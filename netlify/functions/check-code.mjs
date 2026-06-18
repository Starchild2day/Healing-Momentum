import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore("used-codes");

  try {
    const body = await req.json();
    const code = body.code;
    const action = body.action;
    const normalizedCode = (code || "").trim().toUpperCase();

    if (!normalizedCode) {
      return new Response(JSON.stringify({ valid: false, reason: "missing_code" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const VALID_CODES = ["FOUNDER50", "FOUNDER2026", "HEALFREE", "BETAMARK", "DRKTRIAL"];

    if (!VALID_CODES.includes(normalizedCode)) {
      return new Response(JSON.stringify({ valid: false, reason: "unknown_code" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const existing = await store.get(normalizedCode, { type: "json" });

    if (action === "claim") {
      if (existing && existing.used) {
        return new Response(JSON.stringify({
          valid: false,
          reason: "already_used",
          message: "This code has already been used to create an account."
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      await store.setJSON(normalizedCode, {
        used: true,
        claimedAt: new Date().toISOString()
      });
      return new Response(JSON.stringify({ valid: true, claimed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      const isUsed = existing && existing.used;
      return new Response(JSON.stringify({
        valid: true,
        used: !!isUsed
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, reason: "server_error", error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const config = {
  path: "/api/check-code"
};
