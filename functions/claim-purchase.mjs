import { getStore } from "@netlify/blobs";

// ── claim-purchase: hands a buyer their access code right after payment ──
//
// Stripe sends the buyer back to healingmomentumapp.com?welcome=1&session_id=cs_...
// The app calls this function with that session id. We ask Stripe directly
// whether that checkout was really paid (using a read-only restricted key),
// then issue (or re-show) the buyer's personal HM-XXXX-XXXX code.
//
// Required Netlify environment variable:
//   STRIPE_SECRET_KEY — restricted key from the Healing Momentum Stripe account
//                       with "Checkout Sessions: Read" permission only.

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ ok: false, reason: "not_configured" }, 500);

  let sessionId = "";
  try {
    const body = await req.json();
    sessionId = String(body.session_id || "").trim();
  } catch (e) {}

  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
    return json({ ok: false, reason: "bad_session" }, 400);
  }

  // Ask Stripe about this checkout
  let session;
  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), {
      headers: { Authorization: "Bearer " + key }
    });
    session = await res.json();
    if (!res.ok) {
      console.error("Stripe lookup failed:", res.status, session && session.error && session.error.message);
      return json({ ok: false, reason: "not_found" }, 404);
    }
  } catch (err) {
    console.error("Stripe lookup error:", err);
    return json({ ok: false, reason: "stripe_unreachable" }, 502);
  }

  if (session.status !== "complete" || session.payment_status !== "paid") {
    return json({ ok: false, reason: "not_paid" }, 402);
  }

  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  const name = session.customer_details?.name || "";
  const firstName = name.split(" ")[0] || "";
  if (!email) return json({ ok: false, reason: "no_email" }, 400);

  const codeStore = getStore("used-codes");
  const buyerStore = getStore("buyer-codes");

  // Same buyer (or same checkout opened twice) always gets the same code
  const existing = await buyerStore.get(email, { type: "json" }).catch(() => null);
  let code = existing && existing.code;

  if (!code) {
    // Make a code that isn't already taken
    for (let i = 0; i < 5 && !code; i++) {
      const candidate = "HM-" + rand(4) + "-" + rand(4);
      const clash = await codeStore.get(candidate, { type: "json" }).catch(() => null);
      if (!clash) code = candidate;
    }
    if (!code) return json({ ok: false, reason: "code_error" }, 500);

    const record = {
      used: false,
      email,
      name,
      customerId: session.customer || null,
      issuedAt: new Date().toISOString(),
      stripeSessionId: session.id
    };
    await codeStore.setJSON(code, record);
    await buyerStore.setJSON(email, {
      code,
      name,
      customerId: session.customer || null,
      issuedAt: record.issuedAt,
      stripeSessionId: session.id
    });
    console.log("Issued code", code, "for", email);
  }

  return json({ ok: true, code, email, firstName });
};

function rand(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export const config = {
  path: "/api/claim-purchase"
};
