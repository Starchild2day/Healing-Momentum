// Shared helpers for Healing Momentum access codes (Vercel).
//
// A buyer's personal code is calculated from their purchase email using a
// private secret, so no database is needed:
//   same email + same secret  ->  always the same HM-XXXX-XXXX code
// Codes are only ever handed out after Stripe confirms a paid checkout.
//
// Environment variables (Vercel project settings):
//   HM_STRIPE_READ_KEY — restricted key from the Healing Momentum Stripe account
//                        with "Checkout Sessions: Read" permission only
//   HM_CODE_SECRET     — long private phrase; never change it once buyers exist

import { createHmac, timingSafeEqual } from "crypto";

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LEGACY_CODES = ["FOUNDER50", "FOUNDER2026", "HEALFREE", "BETAMARK", "DRKTRIAL"];
export const BUYER_CODE = /^HM-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function codeForEmail(email) {
  const secret = process.env.HM_CODE_SECRET;
  if (!secret) throw new Error("HM_CODE_SECRET not set");
  const digest = createHmac("sha256", secret).update("hm-code:" + normalizeEmail(email)).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += CHARS[digest[i] % CHARS.length];
  return "HM-" + out.slice(0, 4) + "-" + out.slice(4);
}

export function codeMatchesEmail(code, email) {
  const expected = Buffer.from(codeForEmail(email));
  const given = Buffer.from(String(code || "").trim().toUpperCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function stripeGet(path) {
  const key = process.env.HM_STRIPE_READ_KEY;
  if (!key) throw new Error("HM_STRIPE_READ_KEY not set");
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    headers: { Authorization: "Bearer " + key }
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export function isPaid(session) {
  return session && session.status === "complete" && session.payment_status === "paid";
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}

export function send(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}
