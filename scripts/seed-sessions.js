#!/usr/bin/env node
/**
 * One-time script to rebuild sessions from layout.json data.
 * Reads layout.json, maps tab groups to workspace IDs, creates sessions via API.
 */

const http = require('http');

const BASE = 'http://127.0.0.1:3456';
const PASSWORD = 'Sparktech123!';

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiCall._token ? { 'Authorization': 'Bearer ' + apiCall._token } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Auth
  const auth = await apiCall('POST', '/api/auth/login', { password: PASSWORD });
  apiCall._token = auth.token;
  console.log('Authenticated');

  // Get workspace map
  const wsResp = await apiCall('GET', '/api/workspaces');
  const wsMap = {};
  for (const ws of wsResp.workspaces) {
    wsMap[ws.name] = ws.id;
  }
  console.log('Workspaces:', Object.keys(wsMap).join(', '));

  // Session definitions from layout.json
  const sessions = [
    // Pantex
    { name: 'pantex main', ws: 'Pantex', cwd: 'C:\\Users\\Arthur\\Desktop\\Desktop\\work\\pantex', resume: '01ec027f-d5ba-42db-ae3e-1337d204da7b' },
    { name: 'pantex', ws: 'Pantex', cwd: 'C:\\Users\\Arthur\\Desktop\\Desktop\\work\\pantex' },
    { name: 'pantex 3', ws: 'Pantex', cwd: 'C:\\Users\\Arthur\\Desktop\\Desktop\\work\\pantex' },
    { name: 'pantex (fbc77065)', ws: 'Pantex', cwd: 'C:\\Users\\Arthur\\Desktop\\Desktop\\work\\pantex', resume: 'fbc77065-760d-4834-876c-57aef851f51b' },

    // Myrlin Research
    { name: 'Big ML Study', ws: 'Myrlin Research', cwd: 'C:\\Users\\Arthur\\Desktop\\claude-workspace-manager' },
    { name: 'Modding code focus', ws: 'Myrlin Research', cwd: 'C:\\Users\\Arthur\\hytale-asset-factory', resume: '2d1047c7-42ea-4bf8-a17e-1e4d3e448582' },
    { name: 'hytale-asset-factory - new', ws: 'Myrlin Research', cwd: 'C:\\Users\\Arthur\\hytale-asset-factory' },
    { name: 'Main Myrlin Debug', ws: 'Myrlin Research', cwd: 'C:\\Users\\Arthur\\hytale-asset-factory', resume: 'c0d5a3a3-9963-49c6-9de3-185b47034260' },

    // Workbook
    { name: 'Workbook main', ws: 'Workbook', cwd: 'C:\\Users\\Arthur\\Desktop\\claude-workspace-manager', resume: '4271e03d-7295-40e4-bb35-0fd887c39461' },
    { name: 'refactor/optimization', ws: 'Workbook', cwd: 'C:\\Users\\Arthur\\Desktop\\claude-workspace-manager', resume: '4ece62ba-44db-49a2-8af5-4c44f85a1514' },

    // Myrlin Debug/General
    { name: 'Main Myrlin Debug', ws: 'Myrlin Debug/General', cwd: 'C:\\Users\\Arthur\\hytale-asset-factory', resume: 'c0d5a3a3-9963-49c6-9de3-185b47034260' },
    { name: 'reddit conversation', ws: 'Myrlin Debug/General', cwd: 'C:\\Users\\Arthur\\hytale-asset-factory', resume: '9af8b4ef-b5d4-4a69-a004-62755e612e39' },

    // Loussine
    { name: 'Loussines stuff', ws: 'Loussine', cwd: 'C:\\Users\\Arthur' },

    // Onnik
    { name: 'filepro_ai (36b04d1d)', ws: 'Onnik', cwd: 'C:\\Users\\Arthur\\Desktop\\filepro_ai', resume: '36b04d1d-4260-4630-aa1c-283f822dba0e' },
    { name: 'filepro_ai (4d9d0d40)', ws: 'Onnik', cwd: 'C:\\Users\\Arthur\\Desktop\\filepro_ai', resume: '4d9d0d40-df32-4fb3-bd45-b755ca5618fc' },

    // Myrlin Platform
    { name: 'Adidas bot', ws: 'Myrlin Platform', cwd: 'C:\\Users\\Arthur' },
    { name: 'myrlin portal', ws: 'Myrlin Platform', cwd: 'C:\\Users\\Arthur', resume: 'c0df573d-78ce-40a7-9033-eb392e87395c' },

    // AI incubator
    { name: 'M&H Billing Dev', ws: 'AI incubator', cwd: 'C:\\Users\\Arthur\\Desktop\\Work AI Project' },
    { name: 'Q&A', ws: 'AI incubator', cwd: 'C:\\Users\\Arthur\\Desktop\\Work AI Project', resume: '20553635-833e-4a24-af3b-8cbee03c2d65' },
    { name: 'random tasking 1', ws: 'AI incubator', cwd: 'C:\\Users\\Arthur\\Desktop\\Work AI Project', resume: 'e964d01e-031d-460a-8988-e9bff6efb949' },
    { name: 'random tasking 2', ws: 'AI incubator', cwd: 'C:\\Users\\Arthur\\Desktop\\Work AI Project', resume: '00964339-f945-4ba0-aa7f-e1bcb47be118' },
  ];

  let created = 0;
  for (const s of sessions) {
    const wsId = wsMap[s.ws];
    if (!wsId) {
      console.error('  SKIP: no workspace found for', s.ws);
      continue;
    }
    const body = {
      name: s.name,
      workspaceId: wsId,
      workingDir: s.cwd,
      command: 'claude',
      topic: s.name,
    };
    if (s.resume) body.resumeSessionId = s.resume;

    const result = await apiCall('POST', '/api/sessions', body);
    if (result.session) {
      console.log('  Created:', s.name, '->', s.ws);
      created++;
    } else {
      console.error('  FAILED:', s.name, result.error || JSON.stringify(result));
    }
  }

  console.log('\nDone:', created, 'sessions created');
}

main().catch(err => { console.error(err); process.exit(1); });
