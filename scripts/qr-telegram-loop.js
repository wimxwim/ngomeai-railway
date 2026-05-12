const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = '8671241755:AAEaN_29XipQ51sK_YKjdNLdxnyoJFYP43M';
const CHAT_ID = '1792051357';
const WAHA_API_KEY = 'ngomeai123';

// Fungsi kirim foto ke Telegram
async function sendPhotoToTelegram(imagePath, caption) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('photo', fs.createReadStream(imagePath));
  form.append('caption', caption || '');
  
  try {
    const res = await axios.post(url, form, { headers: form.getHeaders(), timeout: 10000 });
    return res.data.ok;
  } catch (err) {
    console.error('Telegram error:', err.message);
    return false;
  }
}

// Fungsi dapatkan QR dan kirim ke Telegram
async function getAndSendQR(port, customerNum, isUpdate = false) {
  try {
    // Get QR from WAHA (binary PNG)
    const qrResp = await axios.get(`http://localhost:${port}/api/default/auth/qr`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
      responseType: 'arraybuffer',
      timeout: 10000
    });
    
    const qrBuffer = Buffer.from(qrResp.data);
    const qrPath = path.join('/tmp', `qr-cust-${String(customerNum).padStart(3, '0')}-${Date.now()}.png`);
    fs.writeFileSync(qrPath, qrBuffer);
    
    const caption = isUpdate 
      ? `🔄 QR Code Customer ${customerNum} (UPDATE - yang lama expired)`
      : `📱 QR Code Customer ${customerNum}\nPort: ${port}\n\nScan dengan WhatsApp HP kamu!`;
    
    const sent = await sendPhotoToTelegram(qrPath, caption);
    if (sent) {
      console.log(`✅ QR ${isUpdate ? 'updated' : 'sent'} for customer ${customerNum}`);
    }
    
    // Cleanup old file
    setTimeout(() => fs.unlinkSync(qrPath), 60000);
    
    return true;
  } catch (err) {
    console.error(`❌ Error getting QR for customer ${customerNum}:`, err.message);
    return false;
  }
}

// Fungsi cek status session
async function checkSessionStatus(port) {
  try {
    const res = await axios.get(`http://localhost:${port}/api/sessions/default`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
      timeout: 5000
    });
    return res.data.status || 'UNKNOWN';
  } catch (err) {
    return 'ERROR';
  }
}

// Main loop untuk 1 customer
async function monitorCustomer(customerNum, port) {
  console.log(`\n[Customer ${customerNum}] Starting monitor (port ${port})...`);
  
  // Kirim QR pertama
  await getAndSendQR(port, customerNum, false);
  
  // Loop cek status tiap 30 detik
  const maxAttempts = 20; // 20 × 30s = 10 menit
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 detik
    
    const status = await checkSessionStatus(port);
    console.log(`[Customer ${customerNum}] Status: ${status} (check ${attempt + 1}/${maxAttempts})`);
    
    if (status === 'WORKING') {
      await sendPhotoToTelegram(
        '/home/ngome/Documents/chatbot/chatbot/ngomeai-codeengine/codeengine-node-postgres/qr-codes/cust-' + 
        String(customerNum).padStart(3, '0') + '.png',
        `✅ Customer ${customerNum} BERHASIL terhubung! WhatsApp sudah aktif.`
      );
      console.log(`[Customer ${customerNum}] ✅ CONNECTED!`);
      return 'CONNECTED';
    }
    
    if (status === 'SCAN_QR_CODE') {
      // QR expired, kirim yang baru
      await getAndSendQR(port, customerNum, true);
    }
    
    if (status === 'ERROR' || status === 'FAILED') {
      console.log(`[Customer ${customerNum}] ❌ Session error`);
      return 'ERROR';
    }
  }
  
  console.log(`[Customer ${customerNum}] ⏳ Timeout (10 menit)`);
  return 'TIMEOUT';
}

// Main
async function main() {
  console.log('=== QR Telegram Loop Monitor ===');
  console.log('Chat ID:', CHAT_ID);
  console.log('Customers: 6 (ports 3003-3008)\n');
  
  const customers = [
    { num: 1, port: 3003 },
    { num: 2, port: 3004 },
    { num: 3, port: 3005 },
    { num: 4, port: 3006 },
    { num: 5, port: 3007 },
    { num: 6, port: 3008 }
  ];
  
  // Monitor semua customer secara paralel
  const results = await Promise.all(
    customers.map(c => monitorCustomer(c.num, c.port))
  );
  
  console.log('\n=== FINAL RESULTS ===');
  results.forEach((result, idx) => {
    console.log(`Customer ${idx + 1}: ${result}`);
  });
}

main().catch(console.error);
