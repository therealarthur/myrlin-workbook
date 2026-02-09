// In-process test: start server on random port, login, test SSE
const http = require('http');
const path = require('path');

// Start server fresh in this process
const { getStore } = require('../src/state/store');
getStore();
const { startServer } = require('../src/web/server');

const server = startServer(0); // random port
const port = server.address().port;
console.log('Test server on port:', port);

function login() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ password: process.env.CWM_PASSWORD || 'test-password' }));
    req.end();
  });
}

function testSSE(token) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/events?token=${token}`, (res) => {
      let data = '';
      res.on('data', d => {
        data += d.toString();
        res.destroy();
        resolve({ status: res.statusCode, contentType: res.headers['content-type'], data });
      });
      setTimeout(() => {
        res.destroy();
        resolve({ status: res.statusCode, contentType: res.headers['content-type'], data: data || '(timeout)' });
      }, 3000);
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log('\n=== LOGIN ===');
  const loginResult = await login();
  console.log('Status:', loginResult.status);
  console.log('Token:', loginResult.body.token ? loginResult.body.token.substring(0, 16) + '...' : 'NONE');

  if (loginResult.body.token) {
    console.log('\n=== SSE ===');
    const sseResult = await testSSE(loginResult.body.token);
    console.log('Status:', sseResult.status);
    console.log('Content-Type:', sseResult.contentType);
    console.log('Data:', sseResult.data.substring(0, 500));
    console.log('\nRESULT:', sseResult.status === 200 ? 'SUCCESS' : 'FAIL');
  }

  server.close();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
