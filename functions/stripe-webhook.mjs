import { getStore } from "@netlify/blobs";
import { Context } from "@netlify/functions";

// ── Stripe webhook handler ──────────────────────────────────────────
// Netlify Functions v2 format.
// Fires when Stripe confirms a payment (checkout.session.completed).
// Generates a unique entry code, stores it in Netlify Blobs,
// then adds the buyer to Swipe One and fires a custom event
// to trigger the welcome email automation.
//
// Required Netlify environment variables:
//   STRIPE_WEBHOOK_SECRET      — from Stripe Dashboard → Webhooks → signing secret
//   SWIPE_ONE_API_KEY          — Swipe One API key (Workspace Settings → API)
//   SWIPE_ONE_WRITE_KEY        — Swipe One write key (needed to record events)
//   SWIPE_ONE_WORKSPACE_ID     — your workspace ID
//   SWIPE_ONE_EVENT_TYPE       — custom event name (set in Netlify env vars)

export default async (req, context) => {
  // ── 1. Verify Stripe signature ──────────────────────────────────
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await req.text();

  let stripeEvent;
  try {
    stripeEvent = await verifyStripeSignature(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // ── 2. Only handle completed checkouts ─────────────────────────
  if (stripeEvent.type !== "checkout.session.completed") {
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const session = stripeEvent.data.object;
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  const name = session.customer_details?.name || "";
  const customerId = session.customer || null;

  if (!email) {
    console.error("No email in Stripe session:", session.id);
    return new Response(JSON.stringify({ error: "No email" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // ── 3. Check if this buyer already has a code (idempotency) ────
  const buyerStore = getStore("buyer-codes");
  const existing = await buyerStore.get(email, { type: "json" }).catch(() => null);

  let entryCode;
  if (existing && existing.code) {
    entryCode = existing.code;
    console.log("Reusing existing code", entryCode, "for", email);
  } else {
    entryCode = generateCode();

    // Store code → buyer details (for validation in check-code.mjs)
    const codeStore = getStore("used-codes");
    await codeStore.setJSON(entryCode, {
      used: false,
      email,
      name,
      customerId,
      issuedAt: new Date().toISOString(),
      stripeSessionId: session.id
    });

    // Store email → code (for resend lookup)
    await buyerStore.setJSON(email, {
      code: entryCode,
      name,
      customerId,
      issuedAt: new Date().toISOString(),
      stripeSessionId: session.id
    });

    console.log("Issued code", entryCode, "for", email);
  }

  // ── 4. Add to Swipe One + fire event to trigger welcome email ──
  const firstName = name.split(" ")[0] || "there";
  const appUrl = "https://healingmomentumapp.com?welcome=1&code=" + entryCode;

  const swipeResult = await addToSwipeOne({ email, name, firstName, entryCode, appUrl, customerId });
  if (!swipeResult.success) {
    console.error("Swipe One sync failed for", email, ":", swipeResult.error);
    // Don't block — code is safely stored in Netlify Blobs regardless
  }

  return new Response(JSON.stringify({ received: true, codeIssued: true }), { status: 200, headers: { "Content-Type": "application/json" } });
};

// ── Swipe One integration ────────────────────────────────────────────

async function addToSwipeOne({ email, name, firstName, entryCode, appUrl, customerId }) {
  const apiKey = process.env.SWIPE_ONE_API_KEY;
  const writeKey = process.env.SWIPE_ONE_WRITE_KEY;
  const workspaceId = process.env.SWIPE_ONE_WORKSPACE_ID;
  const eventType = process.env.SWIPE_ONE_EVENT_TYPE;
  const baseUrl = "https://api.swipeone.com/api";

  if (!apiKey || !workspaceId) {
    console.warn("SWIPE_ONE_API_KEY or SWIPE_ONE_WORKSPACE_ID not set — skipping");
    return { success: false, error: "Missing Swipe One config" };
  }

  try {
    // Step 1: Create or update the contact
    const nameParts = name.split(" ");
    const contactRes = await fetch(baseUrl + "/workspaces/" + workspaceId + "/contacts", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        firstName: nameParts[0] || firstName,
        lastName: nameParts.slice(1).join(" ") || "",
        tags: ["healing-momentum-buyer"]
      })
    });

    if (!contactRes.ok) {
      const err = await contactRes.text();
      return { success: false, error: "Contact creation failed: " + err };
    }

    const contact = await contactRes.json();
    const contactId = contact._id || contact.id;

    // Step 2: Record the purchase event — triggers the Swipe One automation
    const evKey = writeKey || apiKey;
    const eventRes = await fetch(baseUrl + "/workspaces/" + workspaceId + "/events", {
      method: "POST",
      headers: {
        "x-api-key": evKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contact: { id: contactId },
        type: eventType,
        properties: {
          entryCode,
          appUrl,
          stripeCustomerId: customerId || ""
        }
      })
    });

    if (!eventRes.ok) {
      const err = await eventRes.text();
      return { success: false, error: "Event recording failed: " + err };
    }

    return { success: true, contactId };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return "HM-" + rand(4) + "-" + rand(4);
}

// Manual Stripe webhook signature verification (no Stripe SDK required)
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) {
    console.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature check (dev mode)");
    return JSON.parse(rawBody);
  }

  if (!sigHeader) throw new Error("Missing stripe-signature header");

  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const timestamp = parts.t;
  const signature = parts.v1;

  if (!timestamp || !signature) throw new Error("Malformed stripe-signature header");

  const tolerance = 300;
  const diff = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (diff > tolerance) throw new Error("Timestamp too old: " + diff + "s");

  const payload = timestamp + "." + rawBody;
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

// Register explicit route so Netlify's function runner takes priority over static file serving
export const config = {
  path: "/.netlify/functions/stripe-webhook",
  method: ["GET", "POST", "PUT", "DELETE"]
};
