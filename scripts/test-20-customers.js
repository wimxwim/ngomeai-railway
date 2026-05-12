#!/usr/bin/env node
/**
 * test-20-customers.js
 * Simulasi 20 pelanggan WAHA Core - generate QR ke terminal
 * Usage: node scripts/test-20-customers.js
 */

const axios = require('axios');
const { execSync } = require('child_process');

const WAHA_IMAGE = 'devlikeapro/waha';
const BASE_PORT = 3003; // 3002 sudah ada, mulai 3003
const TOTAL_CUSTOMERS = 20;
const API_KEY = 'ngomeai123';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getWahaQr(baseUrl, sessionName = 'default') {
  try {
    const res = await axios.get(
      `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr`,
      { 
        headers: { 'X-Api-Key': API_KEY },
        responseType: 'arraybuffer',
        timeout: 10000 
      }
    );
    return Buffer.from(res.data).toString('base64');
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 404) {
      return null; // Session not ready yet
    }
    throw err;
  }
}

async function startWahaContainer(port, containerName) {
  console.log(`\n[${containerName}] Starting container on port ${port}...`);
  
  try {
    // Check if container already exists
    const existing = execSync(`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`, 
      { encoding: 'utf8' }).trim();
    
    if (existing === containerName) {
      console.log(`[${containerName}] Container already exists, starting...`);
      execSync(`docker start ${containerName}`);
    } else {
      const cmd = [
        'docker run -d',
        `--name ${containerName}`,
        '--restart unless-stopped',
        `-p 127.0.0.1:${port}:3000`,
        `-e WHATSAPP_API_KEY=${API_KEY}`,
        `-e WHATSAPP_HOOK_URL=http://172.17.0.1:3000/webhook/waha`,
        `-e WHATSAPP_HOOK_EVENTS=message`,
        WAHA_IMAGE
      ].join(' ');
      
      execSync(cmd, { stdio: 'inherit' });
    }
    
    console.log(`[${containerName}] Waiting for ready...`);
    await sleep(8000); // Wait for container to be ready
    
    return `http://localhost:${port}`;
  } catch (err) {
    console.error(`[${containerName}] Failed to start:`, err.message);
    return null;
  }
}

async function createSession(baseUrl, sessionName = 'default') {
  try {
    await axios.post(
      `${baseUrl}/api/sessions`,
      { name: sessionName },
      { 
        headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
        timeout: 10000 
      }
    );
    console.log(`[${baseUrl}] Session '${sessionName}' created`);
  } catch (err) {
    if (err.response?.status === 409 || err.response?.status === 422) {
      console.log(`[${baseUrl}] Session '${sessionName}' already exists`);
    } else {
      throw err;
    }
  }
}

async function main() {
  console.log('=== SIMULASI 20 PELANGGAN WAHA CORE ===\n');
  console.log(`Base port: ${BASE_PORT}`);
  console.log(`Total customers: ${TOTAL_CUSTOMERS}`);
  console.log(`API Key: ${API_KEY}\n`);
  
  const results = [];
  
  for (let i = 1; i <= TOTAL_CUSTOMERS; i++) {
    const port = BASE_PORT + i;
    const containerName = `waha-customer-${i}`;
    const customerId = `customer-${String(i).padStart(3, '0')}`;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PELANGGAN ${i}/${TOTAL_CUSTOMERS}: ${customerId}`);
    console.log(`${'='.repeat(60)}`);
    
    // Start container
    const baseUrl = await startWahaContainer(port, containerName);
    if (!baseUrl) {
      console.error(`[${customerId}] SKIP - container failed to start`);
      continue;
    }
    
    // Create session
    await createSession(baseUrl, 'default');
    await sleep(3000);
    
    // Get QR code
    console.log(`[${customerId}] Getting QR code...`);
    let qrBase64 = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      qrBase64 = await getWahaQr(baseUrl, 'default');
      if (qrBase64) break;
      console.log(`[${customerId}] QR not ready, retry ${attempt}/3...`);
      await sleep(2000);
    }
    
    if (qrBase64) {
      console.log(`[${customerId}] QR Code (base64) - SAVE TO FILE:`);
      console.log(`echo "${qrBase64}" | base64 -d > ${customerId}-qr.png`);
      console.log(`File akan berisi PNG QR code untuk ${customerId}`);
      
      // Option: Save to file directly
      const fs = require('fs');
      const path = require('path');
      const qrDir = path.join(__dirname, '../qr-codes');
      if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
      
      fs.writeFileSync(
        path.join(qrDir, `${customerId}.png`),
        Buffer.from(qrBase64, 'base64')
      );
      console.log(`[${customerId}] QR saved to: qr-codes/${customerId}.png`);
    } else {
      console.log(`[${customerId}] QR not available - check container logs: docker logs ${containerName}`);
    }
    
    results.push({
      customerId,
      port,
      containerName,
      url: baseUrl,
      qrAvailable: !!qrBase64
    });
    
    // Small delay between customers
    await sleep(1000);
  }
  
  // Summary
  console.log(`\n\n${'='.repeat(60)}`);
  console.log('RINGKASAN 20 PELANGGAN:');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total: ${results.length}/${TOTAL_CUSTOMERS}`);
  console.log(`QR tersedia: ${results.filter(r => r.qrAvailable).length}`);
  console.log(`\nDaftar container:`);
  results.forEach(r => {
    console.log(`  ${r.customerId} → Port ${r.port} → ${r.url}`);
  });
  console.log(`\nLihat semua QR: ls -la qr-codes/`);
  console.log(`Cek container: docker ps | grep waha-customer`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});