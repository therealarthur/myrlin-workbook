#!/usr/bin/env node
// Wake-on-LAN for Mac Mini (arthur@alloy)
// MAC: 1c:f6:4c:5a:80:49 | LAN: 192.168.1.151 | Tailscale: 100.111.181.106
// Usage: node wake-mac.js

const dgram = require('dgram');
const { execSync } = require('child_process');

const MAC_MINI = '1c:f6:4c:5a:80:49';
const TAILSCALE_IP = '100.111.181.106';

function sendWoL(mac) {
  return new Promise((resolve, reject) => {
    const macBytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
    const magicPacket = Buffer.alloc(6 + 16 * 6);
    magicPacket.fill(0xFF, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(magicPacket, 6 + i * 6);
    }
    const client = dgram.createSocket('udp4');
    client.bind(() => {
      client.setBroadcast(true);
      client.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
        client.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

async function waitForPing(ip, maxAttempts = 12) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      execSync(`ping -n 1 -w 2000 ${ip}`, { stdio: 'pipe' });
      return true;
    } catch {
      process.stdout.write(`  Attempt ${i}/${maxAttempts}...\r`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return false;
}

async function main() {
  console.log(`Waking Mac Mini (${MAC_MINI})...`);
  // Send WoL 3 times for reliability
  for (let i = 0; i < 3; i++) {
    await sendWoL(MAC_MINI);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('  WoL packets sent (x3)');
  console.log(`Waiting for ${TAILSCALE_IP} to respond...`);
  const alive = await waitForPing(TAILSCALE_IP);
  if (alive) {
    console.log('  Mac Mini is online!');
  } else {
    console.log('  Mac Mini did not respond after 36 seconds.');
    console.log('  It may need a physical power button press.');
    process.exit(1);
  }
}

main();
