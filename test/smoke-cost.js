/**
 * Smoke test: hit the LIVE running server's cost endpoint
 * to verify real cost data is returned.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3456;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method,
      headers: {},
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    if (request._token) {
      opts.headers['Authorization'] = 'Bearer ' + request._token;
    }
    const req = http.request(opts, res => {
      let resBody = '';
      res.on('data', d => resBody += d);
      res.on('end', () => resolve({ status: res.statusCode, body: resBody }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
request._token = null;

async function run() {
  // Get password from config
  let password = null;
  const configPaths = [
    path.join(os.homedir(), '.myrlin', 'config.json'),
    path.join(__dirname, '..', 'state', 'config.json'),
  ];
  for (const p of configPaths) {
    try {
      const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (config.password) { password = config.password; break; }
    } catch (_) {}
  }
  if (!password) { console.log('No password found'); process.exit(1); }

  // Auth
  const authRes = await request('POST', '/api/auth/login', { password });
  if (authRes.status !== 200) {
    console.log('Auth failed:', authRes.body.substring(0, 200));
    process.exit(1);
  }
  request._token = JSON.parse(authRes.body).token;
  console.log('Authenticated\n');

  // Get all sessions
  const sessRes = await request('GET', '/api/sessions');
  const sessions = JSON.parse(sessRes.body);
  const ids = Object.keys(sessions);
  console.log('Total sessions:', ids.length);

  const withWorkDir = ids.filter(id => sessions[id].workingDir);
  const withResume = ids.filter(id => sessions[id].resumeSessionId);
  console.log('With workingDir:', withWorkDir.length);
  console.log('With resumeSessionId:', withResume.length);

  // Test sessions that have workingDir pointing to THIS project
  const thisProject = withWorkDir.filter(id =>
    sessions[id].workingDir.includes('claude-workspace-manager')
  );
  console.log('Sessions for this project:', thisProject.length);

  // Test up to 3 sessions
  const testIds = (thisProject.length > 0 ? thisProject : withWorkDir).slice(0, 3);
  let successCount = 0;

  for (const id of testIds) {
    const s = sessions[id];
    console.log(`\n--- ${(s.name || id).substring(0, 50)} ---`);
    console.log(`  workingDir: ${s.workingDir}`);
    console.log(`  resumeSessionId: ${s.resumeSessionId || 'NONE'}`);

    const costRes = await request('GET', `/api/sessions/${id}/cost`);
    if (costRes.status === 200) {
      const cost = JSON.parse(costRes.body);
      console.log(`  totalCost: $${cost.totalCost.toFixed(4)}`);
      console.log(`  messages: ${cost.messages}`);
      console.log(`  inputTokens: ${cost.inputTokens}, outputTokens: ${cost.outputTokens}`);
      if (cost.totalCost > 0) {
        console.log(`  PASS`);
        successCount++;
      } else {
        console.log(`  $0.00`);
      }
    } else {
      console.log(`  ERROR ${costRes.status}: ${costRes.body.substring(0, 100)}`);
    }
  }

  console.log(`\n=== Result: ${successCount}/${testIds.length} returned real cost data ===`);
  process.exit(successCount > 0 ? 0 : 1);
}

run().catch(e => { console.error(e.message); process.exit(1); });
