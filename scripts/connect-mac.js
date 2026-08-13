#!/usr/bin/env node
// One-click Mac Mini remote connect
// Wakes the Mac if needed, waits for SSH, then opens VNC or RustDesk
// Usage: node connect-mac.js [--vnc|--rustdesk]

const dgram = require('dgram');
const { execSync, spawn } = require('child_process');
const path = require('path');

const MAC_MINI = '1c:f6:4c:5a:80:49';
const TAILSCALE_IP = '100.118.228.46';
const SSH_USER = 'arthur';
const RUSTDESK_ID = '1320203920';
const VNC_VIEWER = path.join(process.env.USERPROFILE || '', 'Downloads', 'vncviewer64.exe');

const mode = process.argv.includes('--rustdesk') ? 'rustdesk' : 'vnc';

function sendWoL(mac) {
  return new Promise((resolve, reject) => {
    const macBytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
    const magicPacket = Buffer.alloc(6 + 16 * 6);
    magicPacket.fill(0xFF, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magicPacket, 6 + i * 6);
    const client = dgram.createSocket('udp4');
    client.bind(() => {
      client.setBroadcast(true);
      client.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
        client.close();
        err ? reject(err) : resolve();
      });
    });
  });
}

function ping(ip) {
  try {
    execSync(`ping -n 1 -w 2000 ${ip}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function sshCmd(cmd) {
  try {
    return execSync(`ssh -o ConnectTimeout=5 -o BatchMode=yes ${SSH_USER}@${TAILSCALE_IP} '${cmd}'`, {
      stdio: 'pipe', timeout: 15000
    }).toString().trim();
  } catch { return null; }
}

async function main() {
  console.log('Mac Mini Remote Connect');
  console.log('=======================\n');

  // Step 1: Check if Mac is awake
  console.log('1. Checking if Mac Mini is online...');
  if (!ping(TAILSCALE_IP)) {
    console.log('   Offline - sending Wake-on-LAN...');
    for (let i = 0; i < 3; i++) {
      await sendWoL(MAC_MINI);
      await new Promise(r => setTimeout(r, 500));
    }
    for (let i = 0; i < 15; i++) {
      if (ping(TAILSCALE_IP)) break;
      process.stdout.write(`   Waiting... (${i + 1}/15)\r`);
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!ping(TAILSCALE_IP)) {
      console.log('\n   FAILED: Mac Mini did not wake up.');
      process.exit(1);
    }
  }
  console.log('   Online!\n');

  // Step 2: SSH in and wake display
  console.log('2. Waking display and ensuring services...');
  const sshResult = sshCmd('caffeinate -u -t 10 & echo ok');
  if (!sshResult) {
    console.log('   WARNING: SSH failed. VNC may still work.\n');
  } else {
    console.log('   Display wake triggered.\n');
  }

  // Step 3: Connect
  if (mode === 'rustdesk') {
    console.log(`3. Opening RustDesk to ID: ${RUSTDESK_ID}`);
    console.log('   (Use your password to connect)\n');
    const rustdesk = path.join(process.env.USERPROFILE || '', 'Downloads', 'rustdesk-1.4.5-x86_64.exe', 'rustdesk.exe');
    try {
      spawn(rustdesk, ['--connect', RUSTDESK_ID], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      console.log('   Could not launch RustDesk. Open it manually and enter ID:', RUSTDESK_ID);
    }
  } else {
    console.log(`3. Opening VNC to ${TAILSCALE_IP}:5900`);
    console.log('   Login with your Mac credentials.\n');
    try {
      spawn(VNC_VIEWER, [`${TAILSCALE_IP}:5900`], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      console.log('   Could not launch TigerVNC. Open it manually:', VNC_VIEWER);
    }
  }

  console.log('Done! Connection should open momentarily.');
}

main();
