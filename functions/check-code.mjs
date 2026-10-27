import { getStore } from "@netlify/blobs";

// ── check-code: validates entry codes ───────────────────────────────
//
// Two kinds of codes:
//   1. Legacy beta codes (HEALFREE, BETAMARK, etc.) — kept for existing users
//   2. Per-buyer codes (HM-XXXX-XXXX) — issued by claim-purchase.mjs after a
//      verified Stripe payment. Only codes that were actually issued are valid.
//
// Actions:
//   claim   — first-time setup: mark code as used (same email may re-claim)
//   login   — returning user on any device: valid if the code was issued
//   resend  — buyer enters purchase email; we show their code on screen
//   (none)  — check-only

const LEGACY_CODES = ["FOUNDER50", "FOUNDER2026", "HEALFREE", "BETAMARK", "DRKTRIAL"];
const PER_BUYER = /^HM-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export default async (req) => {
  if (req.method !== "POST") return json({ valid: false, reason: "method" }, 405);

  const codeStore = getStore("used-codes");
  const buyerStore = getStore("buyer-codes");

  try {
    const body = await req.json();
    const action = body.action;
    const code = String(body.code || "").trim().toUpperCase();
    const email = String(body.email || "").trim().toLowerCase();

    // ── RESEND: show the buyer their code again ──
    if (action === "resend") {
      if (!email) return json({ success: false, reason: "missing_email" }, 400);
      const buyer = await buyerStore.get(email, { type: "json" }).catch(() => null);
      if (!buyer || !buyer.code) {
        return json({
          success: false,
          reason: "not_found",
          message: "We couldn't find a purchase for that email. Use the email you paid with, or contact support@healingmomentumapp.com."
        });
      }
      return json({ success: true, code: buyer.code });
    }

    if (!code) return json({ valid: false, reason: "missing_code" }, 400);

    if (LEGACY_CODES.includes(code)) {
      return json({ valid: true, legacy: true });
    }

    if (!PER_BUYER.test(code)) return json({ valid: false, reason: "unknown_code" });

    const record = await codeStore.get(code, { type: "json" }).catch(() => null);
    if (!record) return json({ valid: false, reason: "unknown_code" });

    if (action === "login") {
      return json({ valid: true, returning: true });
    }

    if (action === "claim") {
      if (record.used) {
        if (email && record.email === email) return json({ valid: true, claimed: true, returning: true });
        return json({
          valid: false,
          reason: "already_used",
          message: "This access code is already set up. If it's yours, use the Returning User option."
        });
      }
      await codeStore.setJSON(code, { ...record, used: true, claimedAt: new Date().toISOString() });
      return json({ valid: true, claimed: true });
    }

    return json({ valid: true, used: !!record.used });
  } catch (err) {
    console.error("check-code error:", err);
    return json({ valid: false, reason: "server_error" }, 500);
  }
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export const config = {
  path: "/api/check-code"
};
