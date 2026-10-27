// POST /api/check-code
//   { action: "claim" | "login", code, email }  -> is this code valid for this email?
//   { action: "resend", email }                 -> if this email has a paid purchase, show the code
//
// Legacy beta codes (FOUNDER50 etc.) are accepted for existing beta users.

import {
  LEGACY_CODES, BUYER_CODE, normalizeEmail, codeForEmail, codeMatchesEmail,
  stripeGet, isPaid, readBody, send
} from "./_hm-codes.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { valid: false, reason: "method" });

  const body = readBody(req);
  const action = body.action;
  const code = String(body.code || "").trim().toUpperCase();
  const email = normalizeEmail(body.email);

  try {
    if (action === "resend") {
      if (!email || !email.includes("@")) return send(res, 400, { success: false, reason: "missing_email" });
      const { ok, data } = await stripeGet(
        "checkout/sessions?limit=20&customer_details[email]=" + encodeURIComponent(email)
      );
      const paid = ok && Array.isArray(data.data) && data.data.some(isPaid);
      if (!paid) {
        return send(res, 200, {
          success: false,
          reason: "not_found",
          message: "We couldn't find a purchase for that email. Use the email you paid with, or contact support@healingmomentumapp.com."
        });
      }
      return send(res, 200, { success: true, code: codeForEmail(email) });
    }

    if (!code) return send(res, 400, { valid: false, reason: "missing_code" });
    if (LEGACY_CODES.includes(code)) return send(res, 200, { valid: true, legacy: true });
    if (!BUYER_CODE.test(code)) return send(res, 200, { valid: false, reason: "unknown_code" });
    if (!email) return send(res, 200, { valid: false, reason: "missing_email" });

    if (!codeMatchesEmail(code, email)) {
      return send(res, 200, {
        valid: false,
        reason: "no_match",
        message: "That code doesn't match that email. Use the email you paid with."
      });
    }
    return send(res, 200, { valid: true });
  } catch (err) {
    console.error("check-code error:", err.message);
    return send(res, 500, { valid: false, reason: "server_error" });
  }
}
