const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');

const WAHA_API_KEY = 'ngomeai123';
const ORCHESTRATOR_URL = 'http://172.17.0.1:3000';
const CUSTOMERS = 6;
const START_PORT = 3003;
const QR_DIR = path.join(__dirname, '..', 'qr-codes');

if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCommand(cmd) {
  try {
    const { stdout, stderr } = await execPromise(cmd);
    return stdout || stderr;
  } catch (err) {
    return err.message;
  }
}

async function startCustomer(index) {
  const port = START_PORT + index;
  const containerName = `waha-cust-${String(index + 1).padStart(3, '0')}`;
  const phoneNumber = `0812345678${String(index + 1).padStart(2, '0')}`;
  
  console.log(`[${index + 1}/${CUSTOMERS}] Starting ${containerName} on port ${port}...`);
  
  // Stop & remove if exists
  await runCommand(`docker stop ${containerName} 2>/dev/null`);
  await runCommand(`docker rm ${containerName} 2>/dev/null`);
  
  // Run container
  const runCmd = `docker run -d --name ${containerName} -p 127.0.0.1:${port}:3000 ` +
    `-e WHATSAPP_API_KEY=${WAHA_API_KEY} ` +
    `-e WHATSAPP_HOOK_URL=${ORCHESTRATOR_URL}/webhook/waha ` +
    `devlikeapro/waha`;
  
  await runCommand(runCmd);
  console.log(`  Container started: ${containerName}`);
  
  // Wait for container ready
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try {
      await axios.get(`http://localhost:${port}/api/version`, {
        headers: { 'X-Api-Key': WAHA_API_KEY }
      });
      ready = true;
      break;
    } catch (e) {
      await sleep(2000);
    }
  }
  
  if (!ready) {
    console.log(`  ❌ Container not ready after 30s`);
    return null;
  }
  
  // Start session
  try {
    await axios.post(`http://localhost:${port}/api/sessions/start`, {
      name: 'default',
      start: true
    }, {
      headers: { 'X-Api-Key': WAHA_API_KEY, 'Content-Type': 'application/json' }
    });
    console.log(`  Session starting...`);
  } catch (e) {
    console.log(`  ⚠️ Start session: ${e.message}`);
  }
  
  // Wait for QR
  let qrBase64 = null;
  for (let i = 0; i < 15; i++) {
    try {
      const statusResp = await axios.get(`http://localhost:${port}/api/sessions/default`, {
        headers: { 'X-Api-Key': WAHA_API_KEY }
      });
      const status = statusResp.data.status || '';
      if (status === 'SCAN_QR_CODE' || status === 'WORKING') {
        const qrResp = await axios.get(`http://localhost:${port}/api/default/auth/qr`, {
          headers: { 'X-Api-Key': WAHA_API_KEY }
        });
        qrBase64 = qrResp.data;
        if (qrBase64 && qrBase64.length > 100) break;
      }
    } catch (e) {
      // ignore
    }
    await sleep(3000);
  }
  
  if (!qrBase64) {
    console.log(`  ❌ QR not available`);
    return null;
  }
  
  // Save QR
  const qrBuffer = Buffer.from(qrBase64, 'base64');
  const qrPath = path.join(QR_DIR, `cust-${String(index + 1).padStart(3, '0')}.png`);
  fs.writeFileSync(qrPath, qrBuffer);
  console.log(`  ✅ QR saved: ${qrPath}`);
  
  return {
    index: index + 1,
    containerName,
    port,
    phoneNumber,
    qrPath,
    qrBase64Length: qrBase64.length
  };
}

async function main() {
  console.log(`Starting ${CUSTOMERS} WAHA Core containers...\n`);
  
  const results = [];
  for (let i = 0; i < CUSTOMERS; i++) {
    const result = await startCustomer(i);
    if (result) results.push(result);
  }
  
  console.log(`\n=== RESULTS ===`);
  console.log(`Success: ${results.length}/${CUSTOMERS}`);
  console.log(`\nQR Files:`);
  results.forEach(r => {
    console.log(`  ${r.index}. ${r.containerName} (port ${r.port}) -> ${r.qrPath}`);
  });
  
  // Save results for Telegram sending
  fs.writeFileSync('/tmp/waha-results.json', JSON.stringify(results, null, 2));
  console.log(`\nResults saved to /tmp/waha-results.json`);
}

main().catch(console.error);
