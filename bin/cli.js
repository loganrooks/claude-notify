#!/usr/bin/env node

const { install, uninstall, status } = require('../lib/install');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');

const command = process.argv[2] || '';

async function test() {
  const configPath = path.join(os.homedir(), '.claude-notify.conf');
  if (!fs.existsSync(configPath)) {
    console.log('\n  Not installed yet. Run: npx hearkn\n');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.ntfy_topic) {
    console.log('\n  No ntfy topic configured. Run: npx hearkn\n');
    process.exit(1);
  }

  const host = config.hostname || os.hostname();
  const clickUrl = config.click_scheme !== 'none'
    ? `${config.click_scheme || 'vscode'}://vscode-remote/ssh-remote+${host}${process.cwd()}`
    : '';

  const payload = {
    topic: config.ntfy_topic,
    title: `test [SSH: ${host}]`,
    message: 'Test notification from hearkn',
    priority: 3,
    tags: ['robot'],
  };
  if (clickUrl) payload.click = clickUrl;

  const body = JSON.stringify(payload);
  const serverUrl = config.ntfy_server || 'https://ntfy.sh';
  const parsed = new URL(serverUrl);
  const transport = parsed.protocol === 'https:' ? https : http;

  const req = transport.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 5000,
  }, (res) => {
    if (res.statusCode === 200) {
      console.log(`\n  ✓ Test notification sent to topic: ${config.ntfy_topic}\n`);
    } else {
      console.log(`\n  ⚠ Server returned ${res.statusCode}\n`);
    }
  });

  req.on('error', (e) => console.log(`\n  ⚠ Failed: ${e.message}\n`));
  req.write(body);
  req.end();
}

function help() {
  console.log(`
  hearkn — Push notifications for AI coding agents

  Usage:
    npx hearkn          Install or update
    npx hearkn test     Send a test notification
    npx hearkn status   Show current configuration
    npx hearkn uninstall Remove hooks and config
    npx hearkn help     Show this message
`);
}

async function main() {
  switch (command) {
    case 'test':
      await test();
      break;
    case 'uninstall':
      uninstall();
      break;
    case 'status':
      status();
      break;
    case 'help':
    case '--help':
    case '-h':
      help();
      break;
    default:
      await install();
      break;
  }
}

main().catch((e) => {
  console.error(`  Error: ${e.message}`);
  process.exit(1);
});
