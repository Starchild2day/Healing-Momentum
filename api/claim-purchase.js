// POST /api/claim-purchase  { session_id }
// Stripe sends buyers back to healingmomentumapp.com/?welcome=1&session_id=cs_...
// We confirm with Stripe that the checkout was paid, then return the buyer's code.

import { codeForEmail, normalizeEmail, stripeGet, isPaid, readBody, send } from "./_hm-codes.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, reason: "method" });

  const sessionId = String(readBody(req).session_id || "").trim();
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
    return send(res, 400, { ok: false, reason: "bad_session" });
  }

  try {
    const { ok, status, data: session } = await stripeGet("checkout/sessions/" + encodeURIComponent(sessionId));
    if (!ok) {
      console.error("Stripe lookup failed", status, session && session.error && session.error.message);
      return send(res, 404, { ok: false, reason: "not_found", stripe: status, hint: String((session && session.error && session.error.message) || "").replace(/[a-z]{2}_[A-Za-z0-9_*]+/g, "[key]").slice(0, 120) });
    }
    if (!isPaid(session)) return send(res, 402, { ok: false, reason: "not_paid" });

    const email = normalizeEmail(session.customer_details?.email || session.customer_email);
    if (!email) return send(res, 400, { ok: false, reason: "no_email" });
    const firstName = (session.customer_details?.name || "").split(" ")[0] || "";

    return send(res, 200, { ok: true, code: codeForEmail(email), email, firstName });
  } catch (err) {
    console.error("claim-purchase error:", err.message);
    return send(res, 500, { ok: false, reason: "server_error" });
  }
}
