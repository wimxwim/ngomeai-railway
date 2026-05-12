// tests/waha.test.js – basic WAHA webhook handling test
const request = require('supertest');
const { app } = require('../src/app');

// Minimal valid WAHA payload (no HMAC required)
const payload = {
  event: "message",
  session: "default",
  payload: {
    id: "msg123",
    from: "628123456789@c.us",
    to: "628987654321@c.us",
    fromMe: false,
    body: "halo",
    hasMedia: false,
    ack: 1,
    timestamp: Date.now()
  }
};

describe('WAHA webhook', () => {
  it('should return 200 for a valid message', async () => {
    const res = await request(app)
      .post('/webhook/waha')
      .send(payload)
      .set('Content-Type', 'application/json');
    // The route always replies 200 before processing
    if (res.status !== 200) throw new Error('expected 200');
  });
});
