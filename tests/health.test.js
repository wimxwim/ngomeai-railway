// tests/health.test.js – basic health endpoint test
const request = require('supertest');
const { app } = require('../src/app');

describe('Health endpoint', () => {
  it('should return status ok quickly', async () => {
    const start = Date.now();
    const res = await request(app)
      .get('/health')
      .set('Accept', 'application/json');
    const duration = Date.now() - start;
    if (res.status !== 200) throw new Error('Expected 200');
    if (!res.body || res.body.status !== 'ok') throw new Error('Unexpected body');
    if (duration > 500) throw new Error(`Response too slow: ${duration}ms`);
  });
});
