/**
 * Atomic Onboarding Endpoint
 * POST /admin/clients/onboard
 *
 * Handles the complete onboarding flow in one call:
 *   validate inputs → create DB record → return next steps for QR/connection
 */

const svc    = require("./admin");
const config = require("../config");

module.exports = async function handleOnboard(req, res, ok, fail, str, strOpt, int) {
  const { id, nama, phone_number_id, meta_token, msg_limit, provider, system_prompt, gowa_device_id, waha_session, waha_url } = req.body || {};

  if (!str(id, 64))              return fail(res, "id: required, max 64 chars");
  if (!str(nama, 128))           return fail(res, "nama: required, max 128 chars");
  if (!str(phone_number_id, 64)) return fail(res, "phone_number_id: required, max 64 chars");
  const isUnofficial = provider === "gowa" || provider === "waha";
  if (!isUnofficial && !str(meta_token, 512)) return fail(res, "meta_token: required untuk provider meta, max 512 chars");
  if (meta_token !== undefined && meta_token !== "" && !str(meta_token, 512)) return fail(res, "meta_token: max 512 chars");
  if (msg_limit !== undefined && !int(msg_limit, 1, 1_000_000)) return fail(res, "msg_limit: must be integer 1–1000000");
  if (provider && !["meta", "gowa", "waha"].includes(provider)) return fail(res, "provider: must be 'meta', 'gowa', or 'waha'");
  if (!strOpt(system_prompt, 2000))  return fail(res, "system_prompt: max 2000 chars");
  if (!strOpt(gowa_device_id, 128))  return fail(res, "gowa_device_id: max 128 chars");
  if (!strOpt(waha_session, 128))    return fail(res, "waha_session: max 128 chars");
  if (!strOpt(waha_url, 256))       return fail(res, "waha_url: max 256 chars");

  try {
    const result = await svc.createClient({
      id: id.trim(), nama: nama.trim(),
      phone_number_id: phone_number_id.trim(),
      meta_token: meta_token ? meta_token.trim() : "",
      msg_limit, provider, system_prompt, gowa_device_id, waha_session, waha_url,
    });

    // For WaHA: try to get QR if session is accessible
    if (provider === "waha") {
      const url = waha_url || config.wahaUrl || "http://localhost:3002";
      const axios = require("axios");
      const hdr   = config.wahaApiKey ? { "X-Api-Key": config.wahaApiKey } : {};
      const sess  = waha_session || "default";
      try {
        const stRes = await axios.get(`${url}/api/sessions/${encodeURIComponent(sess)}`, { headers: hdr, timeout: 5000 }).catch(() => null);
        const st = stRes?.data?.status;
        if (st === "WORKING") {
          return ok(res, { 
            client_id: id, 
            status: "connected", 
            provider: "waha",
            waha_webhook_secret: result.waha_webhook_secret,
            waha_webhook_url: `${process.env.PUBLIC_URL || "http://localhost:3000"}/webhook/waha`,
          });
        }
        const qrRes = await axios.get(`${url}/api/${encodeURIComponent(sess)}/auth/qr`,
          { headers: hdr, responseType: "arraybuffer", timeout: 10000 }).catch(() => null);
        if (qrRes?.data) {
          const b64 = `data:image/png;base64,${Buffer.from(qrRes.data).toString("base64")}`;
          return ok(res, { 
            client_id: id, 
            status: "qr_ready", 
            qr: b64, 
            provider: "waha",
            waha_webhook_secret: result.waha_webhook_secret,
            waha_webhook_url: `${process.env.PUBLIC_URL || "http://localhost:3000"}/webhook/waha`,
          });
        }
      } catch (_) {}
      return ok(res, { 
        client_id: id, 
        status: "created", 
        next_step: "start_waha", 
        provider: "waha",
        waha_webhook_secret: result.waha_webhook_secret,
        waha_webhook_url: `${process.env.PUBLIC_URL || "http://localhost:3000"}/webhook/waha`,
      });
    }

    // For GoWA
    if (provider === "gowa") {
      if (!gowa_device_id) {
        return ok(res, { client_id: id, status: "created", next_step: "scan_qr_gowa", provider: "gowa" });
      }
      return ok(res, { client_id: id, status: "created", next_step: "get_qr_gowa", gowa_device_id, provider: "gowa" });
    }

    // For Meta
    return ok(res, { client_id: id, status: "created", provider: "meta" });
  } catch (e) {
    if (e.code === "23505") return fail(res, "Client ID or phone_number_id already exists");
    const { logger } = require("../utils/logger");
    logger.error("admin clients/onboard", { error: e.message });
    fail(res, "DB error", 500);
  }
};
