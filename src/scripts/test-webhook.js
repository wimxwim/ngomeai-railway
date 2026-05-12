const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");

function buildPayload() {
  const phoneNumberId =
    process.env.DEMO_PHONE_NUMBER_ID || "123456789012345";
  const from = process.env.TEST_FROM_PHONE || "6281234567890";
  const message = process.env.TEST_MESSAGE || "halo";

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry_demo",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "6280000000000",
                phone_number_id: phoneNumberId
              },
              contacts: [{ profile: { name: "Tester" }, wa_id: from }],
              messages: [
                {
                  from,
                  id: "wamid.test.local",
                  timestamp: `${Math.floor(Date.now() / 1000)}`,
                  text: { body: message },
                  type: "text"
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

async function run() {
  const payload = buildPayload();
  const rawBody = JSON.stringify(payload);
  const signature =
    "sha256=" +
    crypto.createHmac("sha256", config.metaAppSecret).update(rawBody).digest("hex");

  try {
    const response = await axios.post("http://localhost:3000/webhook", payload, {
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature
      },
      timeout: 10000
    });

    console.log("Webhook test sent.");
    console.log("Status:", response.status);
    console.log("Message:", payload.entry[0].changes[0].value.messages[0].text.body);
  } catch (error) {
    console.error(
      "Webhook test failed:",
      error.response?.status || error.code || error.message
    );
    process.exitCode = 1;
  }
}

run();
