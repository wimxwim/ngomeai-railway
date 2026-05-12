#!/usr/bin/env node
/**
 * test-qr-terminal-v2.js
 * Test generate QR code WAHA ke terminal - FIXED (start session + wait QR)
 * Usage: node scripts/test-qr-terminal-v2.js
 */

const axios = require('axios');
const { execSync } = require('child_process');

const API_KEY = 'ngomeai123';
const BASE_PORT = 3002; // Start from 3003 (3002 sudah ada)
const TEST_CUSTOMERS = 20;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSessionStatus(port, sessionName = 'default') {
  const url = `http://localhost:${port}`;
  try {
    const res = await axios.get(
      `${url}/api/sessions/${encodeURIComponent(sessionName)}`,
      {
        headers: { 'X-Api-Key': API_KEY },
        timeout: 5000
      }
    );
    return res.data;
  } catch (err) {
    return null;
  }
}

async function startSession(port, sessionName = 'default') {
  const url = `http://localhost:${port}`;
  try {
    const res = await axios.post(
      `${url}/api/sessions/start`,
      { name: sessionName, start: true },
      {
        headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );
    console.log(`[Port ${port}] Session '${sessionName}' started, status: ${res.data?.status}`);
    return res.data;
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 409) {
      console.log(`[Port ${port}] Session '${sessionName}' already started or exists`);
      return null;
    }
    throw err;
  }
}

async function getQrBase64(port, sessionName = 'default') {
  const url = `http://localhost:${port}`;
  try {
    const res = await axios.get(
      `${url}/api/${encodeURIComponent(sessionName)}/auth/qr`,
      {
        headers: { 'X-Api-Key': API_KEY },
        responseType: 'arraybuffer',
        timeout: 10000
      }
    );
    return Buffer.from(res.data).toString('base64');
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 404) {
      return null; // Not ready yet
    }
    throw err;
  }
}

async function ensureWahaContainer(port, containerName) {
  console.log(`\n[${containerName}] Checking container...`);
  
  try {
    // Check if container exists (running or stopped)
    const existing = execSync(
      `docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`,
      { encoding: 'utf8' }
    ).trim();
    
    if (existing === containerName) {
      console.log(`[${containerName}] Container exists, starting...`);
      execSync(`docker start ${containerName}`);
    } else {
      console.log(`[${containerName}] Creating new container on port ${port}...`);
      const cmd = [
        'docker run -d',
        `--name ${containerName}`,
        '--restart unless-stopped',
        `-p 127.0.0.1:${port}:3000`,
        `-e WHATSAPP_API_KEY=${API_KEY}`,
        `-e WHATSAPP_HOOK_URL=http://172.17.0.1:3000/webhook/waha`,
        `-e WHATSAPP_HOOK_EVENTS=message`,
        'devlikeapro/waha'
      ].join(' ');
      
      execSync(cmd, { stdio: 'inherit' });
    }
    
    // Wait for container to be ready
    console.log(`[${containerName}] Waiting 10s for readiness...`);
    await sleep(10000);
    return true;
    
  } catch (err) {
    console.error(`[${containerName}] Error:`, err.message);
    return false;
  }
}

async function testCustomer(index) {
  const port = BASE_PORT + index;
  const containerName = `waha-test-${index}`;
  const customerId = `cust-${String(index).padStart(3, '0')}`;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST PELANGGAN ${index}: ${customerId} (Port ${port})`);
  console.log(`${'='.repeat(60)}`);
  
  // 1. Ensure container
  const containerOk = await ensureWahaContainer(port, containerName);
  if (!containerOk) {
    console.error(`[${customerId}] SKIP - container failed`);
    return null;
  }
  
  // 2. Check session status
  console.log(`[${customerId}] Checking session status...`);
  let sessionData = await getSessionStatus(port, 'default');
  
  if (!sessionData) {
    console.log(`[${customerId}] No session found, creating...`);
    // Create session first
    try {
      await axios.post(
        `http://localhost:${port}/api/sessions`,
        { name: 'default' },
        {
          headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      console.log(`[${customerId}] Session created`);
    } catch (err) {
      if (err.response?.status !== 409 && err.response?.status !== 422) {
        throw err;
      }
    }
  }
  
  // 3. Start session
  console.log(`[${customerId}] Starting session...`);
  await startSession(port, 'default');
  await sleep(3000);
  
  // 4. Wait for SCAN_QR_CODE status
  console.log(`[${customerId}] Waiting for QR ready (SCAN_QR_CODE status)...`);
  let qrReady = false;
  for (let i = 1; i <= 10; i++) {
    sessionData = await getSessionStatus(port, 'default');
    const status = sessionData?.status;
    console.log(`[${customerId}] Status check ${i}/10: ${status}`);
    
    if (status === 'SCAN_QR_CODE') {
      qrReady = true;
      break;
    }
    if (status === 'WORKING') {
      console.log(`[${customerId}] Already connected! No QR needed.`);
      return { customerId, port, status: 'WORKING', qrBase64: null };
    }
    await sleep(2000);
  }
  
  if (!qrReady) {
    console.log(`[${customerId}] QR not ready - status: ${sessionData?.status}`);
    return { customerId, port, status: sessionData?.status, qrBase64: null };
  }
  
  // 5. Get QR code
  console.log(`[${customerId}] Getting QR code...`);
  let qrBase64 = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    qrBase64 = await getQrBase64(port, 'default');
    if (qrBase64) break;
    console.log(`[${customerId}] QR not ready, retry ${attempt}/5...`);
    await sleep(2000);
  }
  
  if (!qrBase64) {
    console.log(`[${customerId}] QR not available - check: docker logs ${containerName}`);
    return { customerId, port, status: 'SCAN_QR_CODE', qrBase64: null };
  }
  
  console.log(`[${customerId}] QR Code generated! (${qrBase64.length} chars)`);
  
  // Save to file
  const fs = require('fs');
  const path = require('path');
  const qrDir = path.join(__dirname, '../qr-codes');
  if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
  
  const filePath = path.join(qrDir, `${customerId}.png`);
  fs.writeFileSync(filePath, Buffer.from(qrBase64, 'base64'));
  console.log(`[${customerId}] QR saved to: ${filePath}`);
  
  // Show first 50 chars of base64
  console.log(`\nBase64 preview: ${qrBase64.substring(0, 50)}...`);
  
  return { customerId, port, status: 'SCAN_QR_CODE', qrBase64, filePath };
}

async function main() {
  console.log('=== TEST QR CODE WAHA KE TERMINAL (FIXED) ===\n');
  console.log(`Base port: ${BASE_PORT + 1}`);
  console.log(`Test customers: ${TEST_CUSTOMERS}`);
  console.log(`API Key: ${API_KEY}\n`);
  
  const results = [];
  
  for (let i = 1; i <= TEST_CUSTOMERS; i++) {
    const result = await testCustomer(i);
    if (result) results.push(result);
    await sleep(1000);
  }
  
  // Summary
  console.log(`\n\n${'='.repeat(60)}`);
  console.log('RINGKASAN TEST:');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total: ${results.length}/${TEST_CUSTOMERS}`);
  console.log(`QR tersedia: ${results.filter(r => r.qrBase64).length}`);
  console.log(`\nDaftar file QR:`);
  results.forEach(r => {
    if (r.filePath) {
      console.log(`  ${r.customerId} → ${r.filePath}`);
    } else {
      console.log(`  ${r.customerId} → Status: ${r.status} (no QR)`);
    }
  });
  console.log(`\nCek container: docker ps | grep waha-test`);
  console.log(`Cek QR files: ls -la qr-codes/`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});