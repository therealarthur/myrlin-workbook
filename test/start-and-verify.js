/**
 * Starts the GUI server on port 3456 and verifies SSE works.
 * Checks if port is in use first and handles it.
 */
const http = require('http');
const net = require('net');
const { execSync } = require('child_process');

const PORT = 3456;

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true)); // port in use
    server.once('listening', () => {
      server.close();
      resolve(false); // port free
    });
    server.listen(port);
  });
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // Step 1: Check if port is in use
  console.log('Step 1: Checking port', PORT);
  const inUse = await checkPort(PORT);
  if (inUse) {
    console.log('  Port is IN USE. Trying to kill...');
    try {
      const result = execSync(`powershell -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`, { timeout: 5000 }).toString().trim();
      if (result) {
        const pids = result.split('\n').map(p => p.trim()).filter(Boolean);
        console.log('  PIDs found:', pids);
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
            console.log('  Killed PID:', pid);
          } catch (e) {
            console.log('  Failed to kill PID:', pid, e.message);
          }
        }
        // Wait for port to free up
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.log('  Could not find/kill process:', e.message);
    }

    // Re-check
    const stillInUse = await checkPort(PORT);
    if (stillInUse) {
      console.log('  ERROR: Port still in use. Cannot start server.');
      process.exit(1);
    }
  }
  console.log('  Port is FREE');

  // Step 2: Start server
  console.log('\nStep 2: Starting server on port', PORT);
  const { getStore } = require('../src/state/store');
  const store = getStore();

  // Seed demo data if empty
  if (store.getAllWorkspacesList().length === 0) {
    const ws1 = store.createWorkspace({ name: 'Project Alpha', description: 'Frontend application' });
    const ws2 = store.createWorkspace({ name: 'Backend API', description: 'Backend services' });
    const ws3 = store.createWorkspace({ name: 'Documentation', description: 'Docs & guides' });
    store.createSession({ name: 'ui-components', workspaceId: ws1.id, workingDir: 'C:\\Projects\\project-alpha', topic: 'React components' });
    store.createSession({ name: 'state-mgmt', workspaceId: ws1.id, workingDir: 'C:\\Projects\\project-alpha\\state', topic: 'State management' });
    store.createSession({ name: 'api-routes', workspaceId: ws2.id, workingDir: 'C:\\Projects\\backend-api', topic: 'REST endpoints' });
    store.createSession({ name: 'db-migrations', workspaceId: ws2.id, workingDir: 'C:\\Projects\\backend-api\\db', topic: 'Database schema' });
    store.createSession({ name: 'readme-update', workspaceId: ws3.id, workingDir: 'C:\\Projects\\docs', topic: 'README overhaul' });
    store.createSession({ name: 'api-docs', workspaceId: ws3.id, workingDir: 'C:\\Projects\\docs\\api', topic: 'API reference' });
    store.save();
    console.log('  Demo data seeded');
  } else {
    console.log('  Existing data found:', store.getAllWorkspacesList().length, 'workspaces');
  }

  const { startServer } = require('../src/web/server');
  const server = startServer(PORT);

  server.on('listening', () => {
    console.log('  Server LISTENING on', PORT);
  });
  server.on('error', (err) => {
    console.log('  Server ERROR:', err.message);
    process.exit(1);
  });

  // Wait a moment for server to be ready
  await new Promise(r => setTimeout(r, 1000));

  // Step 3: Test login
  console.log('\nStep 3: Testing login');
  const loginRes = await httpRequest({
    hostname: '127.0.0.1', port: PORT,
    path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ password: process.env.CWM_PASSWORD || 'test-password' }));
  console.log('  Login status:', loginRes.status);
  const loginData = JSON.parse(loginRes.body);
  console.log('  Token:', loginData.token ? loginData.token.substring(0, 16) + '...' : 'NONE');

  if (!loginData.token) {
    console.log('  LOGIN FAILED:', loginRes.body);
    process.exit(1);
  }

  // Step 4: Test SSE
  console.log('\nStep 4: Testing SSE');
  const sseRes = await httpRequest({
    hostname: '127.0.0.1', port: PORT,
    path: '/api/events?token=' + loginData.token, method: 'GET',
  });
  console.log('  SSE status:', sseRes.status);
  console.log('  SSE content-type:', sseRes.headers['content-type']);
  console.log('  SSE body (first 300):', sseRes.body.substring(0, 300));

  if (sseRes.status === 200) {
    console.log('\n=== SSE WORKING === Server running on http://localhost:' + PORT);
    console.log('Open browser and reload the page.');
    // Keep server alive
    setInterval(() => {}, 30000);
  } else {
    console.log('\n=== SSE STILL BROKEN ===');
    console.log('Full response:', sseRes.body);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
