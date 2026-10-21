import { getStore } from "@netlify/blobs";

// ── Stripe webhook handler ──────────────────────────────────────────
// Fires when Stripe confirms a payment (checkout.session.completed).
// Generates a unique entry code for the buyer, stores it in Netlify
// Blobs tied to their email, and emails it to them.
//
// Required environment variables (set in Netlify site settings):
//   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard → Webhooks → signing secret
//   EMAIL_FROM              — e.g. "Healing Momentum <support@healingmomentumapp.com>"
//   RESEND_API_KEY          — free tier at resend.com (100 emails/day free)

export default async (req, context) => {
  // ── 1. Verify Stripe signature ──────────────────────────────────
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await req.text();

  let event;
  try {
    // Manual HMAC verification (no Stripe SDK needed)
    event = await verifyStripeSignature(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // ── 2. Only handle completed checkouts ─────────────────────────
  if (event.type !== "checkout.session.completed") {
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const session = event.data.object;
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  const name = session.customer_details?.name || "";
  const customerId = session.customer || null;

  if (!email) {
    console.error("No email in Stripe session:", session.id);
    return new Response(JSON.stringify({ error: "No email" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // ── 3. Check if this buyer already has a code (idempotency) ────
  const buyerStore = getStore("buyer-codes");
  const existing = await buyerStore.get(email, { type: "json" }).catch(() => null);

  let entryCode;
  if (existing && existing.code) {
    // Already issued — resend the same code (handles duplicate webhook events)
    entryCode = existing.code;
    console.log(`Reusing existing code ${entryCode} for ${email}`);
  } else {
    // Generate a new unique code: HM-XXXX-XXXX (letters + numbers, easy to type)
    entryCode = generateCode();

    // Store code → email mapping (for validation)
    const codeStore = getStore("used-codes");
    await codeStore.setJSON(entryCode, {
      used: false,
      email,
      name,
      customerId,
      issuedAt: new Date().toISOString(),
      stripeSessionId: session.id
    });

    // Store email → code mapping (for resend lookup)
    await buyerStore.setJSON(email, {
      code: entryCode,
      name,
      customerId,
      issuedAt: new Date().toISOString(),
      stripeSessionId: session.id
    });

    console.log(`Issued code ${entryCode} for ${email}`);
  }

  // ── 4. Email the code to the buyer ─────────────────────────────
  const firstName = name.split(" ")[0] || "there";
  const appUrl = `https://healingmomentumapp.com?welcome=1&code=${entryCode}`;

  const emailSent = await sendEmail({
    to: email,
    subject: "Your Healing Momentum access code is here 🎉",
    html: `
      <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f9f7f3;border-radius:16px;">
        <h1 style="color:#1a4028;font-size:1.6rem;margin-bottom:8px;">Welcome to Healing Momentum, ${firstName}!</h1>
        <p style="color:#444;font-size:1rem;line-height:1.6;margin-bottom:24px;">
          You're officially a Founding Member. Here's your personal access code —
          it's yours alone and can only be used once to set up your account.
        </p>
        <div style="background:#1a4028;border:2px solid #c9923a;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
          <div style="color:#e8b86d;font-size:0.85rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">Your Entry Code</div>
          <div style="color:#ffffff;font-size:2rem;font-weight:900;letter-spacing:0.15em;">${entryCode}</div>
        </div>
        <p style="color:#444;font-size:1rem;line-height:1.6;margin-bottom:16px;">
          The easiest way to get started: tap the button below. Your code is already filled in.
        </p>
        <a href="${appUrl}" style="display:block;background:#1a4028;color:#ffffff;font-weight:700;font-size:1rem;padding:14px 20px;border-radius:10px;text-decoration:none;text-align:center;margin-bottom:24px;">
          Start My Recovery Plan →
        </a>
        <p style="color:#888;font-size:0.85rem;line-height:1.5;">
          If the button doesn't work, go to <strong>healingmomentumapp.com</strong> and enter your code manually.<br><br>
          Save this email — if you ever need to set up the app on a new device, you'll need this code.
        </p>
        <hr style="border:none;border-top:1px solid #e0ddd7;margin:20px 0;">
        <p style="color:#aaa;font-size:0.8rem;">Questions? Reply to this email or contact support@healingmomentumapp.com</p>
      </div>
    `
  });

  if (!emailSent) {
    console.error(`Failed to send email to ${email} with code ${entryCode}`);
    // Don't return error — code is saved, we just couldn't email it
  }

  return new Response(JSON.stringify({ received: true, codeIssued: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

// ── Helpers ─────────────────────────────────────────────────────────

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I to avoid confusion
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `HM-${rand(4)}-${rand(4)}`;
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Healing Momentum <support@healingmomentumapp.com>";

  if (!apiKey) {
    console.warn("RESEND_API_KEY not set — skipping email send");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from, to, subject, html })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Resend error:", data);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Email send failed:", err);
    return false;
  }
}

// Manual Stripe webhook signature verification (no SDK required)
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) {
    // Dev mode: skip verification
    console.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature check");
    return JSON.parse(rawBody);
  }

  if (!sigHeader) throw new Error("Missing stripe-signature header");

  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const timestamp = parts.t;
  const signature = parts.v1;

  if (!timestamp || !signature) throw new Error("Malformed stripe-signature header");

  // Check timestamp within 5 minutes
  const tolerance = 300;
  const diff = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (diff > tolerance) throw new Error(`Timestamp too old: ${diff}s`);

  // Compute expected signature
  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected !== signature) throw new Error("Signature mismatch");

  return JSON.parse(rawBody);
}

export const config = {
  path: "/api/stripe-webhook"
};
