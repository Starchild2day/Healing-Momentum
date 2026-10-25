export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.KS_STRIPE_WEBHOOK_SECRET;

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

  // Handle one-time donations (checkout.session.completed)
  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    // Only process one-time payments (not subscription setups)
    if (session.mode === "payment") {
      const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
      const name = session.customer_details?.name || "";
      const amountCents = session.amount_total || 0;
      const currency = session.currency || "usd";

      if (!email) return res.status(400).json({ error: "No email" });

      const result = await addDonorToSwipeOne({
        email, name,
        amountCents,
        currency,
        frequency: "one-time",
        stripeCustomerId: session.customer || null,
      });
      console.log("One-time donation processed:", JSON.stringify(result));
    }
    return res.status(200).json({ received: true });
  }

  // Handle monthly recurring donations (invoice.paid fires each billing cycle)
  if (stripeEvent.type === "invoice.paid") {
    const invoice = stripeEvent.data.object;
    // Skip $0 invoices (trials, setup) and non-subscription invoices
    if (!invoice.subscription || invoice.amount_paid === 0) {
      return res.status(200).json({ received: true });
    }

    const email = (invoice.customer_email || "").toLowerCase().trim();
    const name = invoice.customer_name || "";
    const amountCents = invoice.amount_paid || 0;
    const currency = invoice.currency || "usd";
    const isFirstPayment = invoice.billing_reason === "subscription_create";

    if (!email) return res.status(400).json({ error: "No email" });

    const result = await addDonorToSwipeOne({
      email, name,
      amountCents,
      currency,
      frequency: "monthly",
      isFirstPayment,
      stripeCustomerId: invoice.customer || null,
      subscriptionId: invoice.subscription || null,
    });
    console.log("Monthly donation processed:", JSON.stringify(result));
    return res.status(200).json({ received: true });
  }

  // All other events — acknowledge and ignore
  return res.status(200).json({ received: true });
}

async function addDonorToSwipeOne({
  email, name, amountCents, currency, frequency,
  isFirstPayment, stripeCustomerId, subscriptionId
}) {
  const apiKey = process.env.KS_SWIPE_ONE_API_KEY;
  const writeKey = process.env.KS_SWIPE_ONE_WRITE_KEY;
  const workspaceId = process.env.KS_SWIPE_ONE_WORKSPACE_ID;
  const baseUrl = "https://api.swipeone.com/api";

  if (!apiKey || !workspaceId) {
    console.error("Missing Swipe One credentials");
    return { error: "Missing credentials" };
  }

  const amountDollars = (amountCents / 100).toFixed(2);
  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency", currency: currency.toUpperCase()
  }).format(amountCents / 100);

  const firstName = name.split(" ")[0] || "Friend";
  const lastName = name.split(" ").slice(1).join(" ") || "";

  const donationDate = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });

  // Upsert contact with kidsavers-donor tag
  let contactId = null;
  try {
    const contactRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        email,
        firstName,
        lastName,
        tags: ["kidsavers-donor"],
        customFields: {
          last_donation_amount: amountDollars,
          last_donation_date: donationDate,
          donation_frequency: frequency,
          stripe_customer_id: stripeCustomerId || "",
          subscription_id: subscriptionId || "",
        },
      }),
    });
    const contactData = await contactRes.json();
    contactId = contactData?.data?.id || contactData?.id;
    console.log("Contact upsert:", contactRes.status, contactId);
  } catch (err) {
    console.error("Contact upsert failed:", err.message);
  }

  // Fire donation_completed event to trigger Swipe One automation
  try {
    const eventBody = {
      workspaceId,
      eventType: "donation_completed",
      contactEmail: email,
      properties: {
        first_name: firstName,
        full_name: name,
        donation_amount: amountDollars,
        donation_amount_formatted: formattedAmount,
        donation_frequency: frequency,
        donation_date: donationDate,
        is_first_payment: isFirstPayment !== false,
        stripe_customer_id: stripeCustomerId || "",
        subscription_id: subscriptionId || "",
        ein: "42-3080282",
        org_name: "Kidsavers International, Inc.",
      },
    };
    if (contactId) eventBody.contactId = contactId;

    const eventRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeKey || apiKey },
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
  if (computedSig !== expectedSig) throw new Error("Signature mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) throw new Error("Timestamp too old");
  return JSON.parse(rawBody);
}
