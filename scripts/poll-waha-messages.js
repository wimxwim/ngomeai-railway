#!/usr/bin/env node
/**
 * Poll WAHA for new messages and forward to webhook endpoint
 * Run every 5 seconds via cron/hermes
 */

const axios = require('axios');
const config = require('../src/config');

const WAHA_URL = process.env.WAHA_URL || 'http://127.0.0.1:3002';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'ngomeai123';
const WEBHOOK_URL = 'http://127.0.0.1:3000/webhook/waha';

let lastMessageId = '';

async function pollMessages() {
  try {
    // Get messages from WAHA
    const res = await axios.get(`${WAHA_URL}/api/sessions/default/messages`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
      timeout: 5000
    });

    const messages = res.data || [];
    if (messages.length === 0) return;

    // Process only new messages (not from self)
    for (const msg of messages.reverse()) {
      if (msg.fromMe) continue;
      if (msg.id === lastMessageId) break;
      
      // Forward to webhook
      try {
        await axios.post(WEBHOOK_URL, {
          id: msg.id,
          timestamp: Date.now(),
          session: 'default',
          event: 'message',
          payload: {
            id: msg.id,
            from: msg.chatId,
            to: msg.to || msg.chatId,
            fromMe: false,
            body: msg.body,
            hasMedia: msg.hasMedia || false
          }
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        });
        
        lastMessageId = msg.id;
        console.log(`✅ Forwarded: ${msg.body?.slice(0, 50)}...`);
      } catch (err) {
        console.error(`❌ Forward failed: ${err.message}`);
      }
    }
  } catch (err) {
    if (!err.response?.status === 404) {
      console.error(`Poll error: ${err.message}`);
    }
  }
}

// Run once
pollMessages().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
