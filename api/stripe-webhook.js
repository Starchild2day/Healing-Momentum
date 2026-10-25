// Vercel serverless function - Stripe webhook handler
// Generates deterministic HM-XXXX-XXXX entry codes from buyer email
// No external storage needed - same email always produces same code

export const config = {
  api: {
    bodyParser: false, // Must receive raw body for Stripe signature verification
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Read raw body for Stripe signature verification
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  let stripeEvent;
  try {
    stripeEvent = await verifyStripeSignature(rawBody.toString(), sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = stripeEvent.data.object;
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  const name = session.customer_details?.name || "";
  const customerId = session.customer || null;

  if (!email) {
    return res.status(400).json({ error: "No email" });
  }

  // Generate deterministic code from email - same buyer always gets same code
  const entryCode = await generateDeterministicCode(email, webhookSecret);

  const firstName = name.split(" ")[0] || "there";
  const appUrl = "https://healingmomentumapp.com?welcome=1&code=" + entryCode;

  const swipeResult = await addToSwipeOne({ email, name, firstName, entryCode, appUrl, customerId });
  console.log("Swipe One result:", JSON.stringify(swipeResult));

  return res.status(200).json({ received: true, codeIssued: true });
}

// Generate a deterministic HM-XXXX-XXXX code from email
// Same email always produces the same code
async function generateDeterministicCode(email, secret) {
  const { createHmac } = await import("crypto");
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const hash = createHmac("sha256", secret || "healing-momentum-salt")
    .update(email.toLowerCase())
    .digest("hex");

  // Convert first 8 hex chars to code characters
  let part1 = "";
  let part2 = "";
  for (let i = 0; i < 4; i++) {
    const byte = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    part1 += chars[byte % chars.length];
  }
  for (let i = 4; i < 8; i++) {
    const byte = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    part2 += chars[byte % chars.length];
  }
  return `HM-${part1}-${part2}`;
}

async function addToSwipeOne({ email, name, firstName, entryCode, appUrl, customerId }) {
  const apiKey = process.env.SWIPE_ONE_API_KEY;
  const writeKey = process.env.SWIPE_ONE_WRITE_KEY;
  const workspaceId = process.env.SWIPE_ONE_WORKSPACE_ID;
  const eventType = process.env.SWIPE_ONE_EVENT_TYPE || "purchase_completed";
  const baseUrl = "https://api.swipeone.com/api";

  if (!apiKey || !workspaceId) {
    console.error("Missing Swipe One credentials");
    return { error: "Missing credentials" };
  }

  // 1. Upsert contact
  let contactId = null;
  try {
    const contactRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        email,
        firstName,
        lastName: name.split(" ").slice(1).join(" ") || "",
        tags: ["healing-momentum"],
        customFields: {
          entry_code: entryCode,
          app_url: appUrl,
          stripe_customer_id: customerId || "",
        },
      }),
    });
    const contactData = await contactRes.json();
    contactId = contactData?.data?.id || contactData?.id;
    console.log("Contact upsert:", contactRes.status, contactId);
  } catch (err) {
    console.error("Contact upsert failed:", err.message);
  }

  // 2. Fire custom event
  try {
    const eventBody = {
      workspaceId,
      eventType,
      contactEmail: email,
      properties: {
        entry_code: entryCode,
        app_url: appUrl,
        first_name: firstName,
        full_name: name,
        stripe_customer_id: customerId || "",
      },
    };
    if (contactId) eventBody.contactId = contactId;

    const eventRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": writeKey || apiKey,
      },
      body: JSON.stringify(eventBody),
    });
    const eventData = await eventRes.json();
    console.log("Event fire:", eventRes.status, JSON.stringify(eventData));
    return { contactId, eventStatus: eventRes.status, eventData };
  } catch (err) {
    console.error("Event fire failed:", err.message);
    return { contactId, eventError: err.message };
  }
}

async function verifyStripeSignature(rawBody, sig, secret) {
  const { createHmac } = await import("crypto");

  if (!sig || !secret) throw new Error("Missing signature or secret");

  const parts = sig.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));

  if (!tPart || !v1Part) throw new Error("Invalid signature format");

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);

  const payload = `${timestamp}.${rawBody}`;
  const computedSig = createHmac("sha256", secret).update(payload).digest("hex");

  if (computedSig !== expectedSig) {
    throw new Error("Signature mismatch");
  }

  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error("Timestamp too old");
  }

  return JSON.parse(rawBody);
}
