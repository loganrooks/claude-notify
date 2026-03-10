const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const readline = require('readline');

const HOME = os.homedir();
const HOOKS_DIR = path.join(HOME, '.claude', 'hooks');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const CONFIG_PATH = path.join(HOME, '.claude-notify.conf');
const HOOK_FILENAME = 'claude-notify.js';

function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function generateTopic() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `claude-${os.hostname()}-${rand}`;
}

function detectHostname() {
  // Try Tailscale hostname first, fall back to OS hostname
  try {
    const tsStatus = require('child_process')
      .execSync('tailscale status --self --json 2>/dev/null', { timeout: 3000 })
      .toString();
    const parsed = JSON.parse(tsStatus);
    if (parsed.Self && parsed.Self.HostName) {
      return parsed.Self.HostName;
    }
  } catch (e) {
    // No Tailscale — use OS hostname
  }
  return os.hostname();
}

function detectEditor() {
  // Check common editor environment variables
  if (process.env.VSCODE_IPC_HOOK_CLI) return 'vscode';
  if (process.env.CURSOR_IPC_HOOK) return 'cursor';
  if (process.env.TERM_PROGRAM === 'vscode') return 'vscode';
  return 'vscode'; // safe default
}

function checkClaudeCode() {
  // Check for ~/.claude/ directory (created on first run)
  const claudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) return true;

  // Check if `claude` CLI is on PATH
  try {
    require('child_process').execSync('which claude 2>/dev/null', { timeout: 3000 });
    return true;
  } catch (e) {
    return false;
  }
}

function validateTopic(server, topic) {
  return new Promise((resolve) => {
    const serverUrl = server || 'https://ntfy.sh';
    const parsed = new URL(serverUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const payload = JSON.stringify({
      topic: topic,
      title: 'hearkn',
      message: 'Topic validation — you can ignore this.',
      priority: 1,
      tags: ['test_tube'],
    });

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

async function install() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n  hearkn — Push notifications for AI coding agents\n');

  // Check for Claude Code
  if (!checkClaudeCode()) {
    console.log('  Claude Code not detected.');
    console.log('  Install it first: https://docs.anthropic.com/en/docs/claude-code\n');
    console.log('  If Claude Code is installed but not on PATH, you can continue anyway.');
    const proceed = await ask(rl, '  Continue? (y/N)', 'N');
    if (proceed.toLowerCase() !== 'y') {
      rl.close();
      process.exit(1);
    }
    console.log('');
  }

  // Check if already installed
  const hookPath = path.join(HOOKS_DIR, HOOK_FILENAME);
  const isUpdate = fs.existsSync(hookPath);
  if (isUpdate) {
    console.log('  Existing installation detected — updating.\n');
  }

  // Detect defaults
  const defaultHostname = detectHostname();
  const defaultEditor = detectEditor();
  const existingConfig = loadExistingConfig();

  // Prompt for config
  const topic = await ask(rl, '  ntfy topic (unique, hard to guess)',
    existingConfig.ntfy_topic || generateTopic());
  const server = await ask(rl, '  ntfy server',
    existingConfig.ntfy_server || 'https://ntfy.sh');

  // Validate topic reachability
  console.log('  Validating ntfy topic...');
  const topicOk = await validateTopic(server, topic);
  if (!topicOk) {
    console.log('  Could not reach ntfy server or topic was rejected.');
    const proceed = await ask(rl, '  Continue anyway? (y/N)', 'N');
    if (proceed.toLowerCase() !== 'y') {
      rl.close();
      process.exit(1);
    }
  } else {
    console.log('  Topic reachable.\n');
  }

  const hostname = await ask(rl, '  SSH hostname (for click-to-focus)',
    existingConfig.hostname || defaultHostname);
  const editor = await ask(rl, '  Editor (vscode/vscode-insiders/cursor/none)',
    existingConfig.click_scheme || defaultEditor);

  rl.close();

  // 1. Write config
  const config = {
    ntfy_enabled: true,
    ntfy_topic: topic,
    ntfy_server: server,
    hostname: hostname,
    click_scheme: editor,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n  ✓ Config written to ${CONFIG_PATH}`);

  // 2. Copy hook
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  const hookSource = path.join(__dirname, 'hook.js');
  fs.copyFileSync(hookSource, hookPath);
  fs.chmodSync(hookPath, 0o755);
  console.log(`  ✓ Hook installed at ${hookPath}`);

  // 3. Patch settings.json
  patchSettings(hookPath);
  console.log(`  ✓ Hooks registered in ${SETTINGS_PATH}`);

  // 4. Send test notification
  console.log('\n  Sending test notification...');
  const success = await sendTest(config);
  if (success) {
    console.log('  ✓ Notification sent!\n');
  } else {
    console.log('  ⚠ Could not send — check your ntfy topic and server.\n');
  }

  // 5. Instructions
  console.log('  Next steps:');
  console.log(`  1. Install the ntfy app on your phone/Mac`);
  console.log(`  2. Subscribe to topic: ${topic}`);
  console.log(`  3. Start using Claude Code — notifications are automatic.\n`);
  if (editor !== 'none') {
    console.log(`  Click-to-focus: Tapping a notification will open ${editor}`);
    console.log(`  connected to ${hostname} via SSH.\n`);
  }
}

function loadExistingConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function patchSettings(hookPath) {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
      // Corrupted — start fresh hooks section
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const hookCommand = `node "${hookPath}"`;
  const hookEntry = {
    hooks: [{ type: 'command', command: hookCommand }]
  };

  // Add to Notification and Stop hooks (avoid duplicates)
  for (const event of ['Notification', 'Stop']) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const existing = settings.hooks[event].find(
      h => h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-notify'))
    );

    if (existing) {
      // Update existing entry
      existing.hooks = hookEntry.hooks;
    } else {
      settings.hooks[event].push(hookEntry);
    }
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function sendTest(config) {
  return new Promise((resolve) => {
    const serverUrl = config.ntfy_server || 'https://ntfy.sh';
    const parsed = new URL(serverUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const payload = {
      topic: config.ntfy_topic,
      title: 'hearkn',
      message: 'Installation successful \u2014 notifications are working!',
      priority: 3,
      tags: ['white_check_mark'],
    };
    const body = JSON.stringify(payload);

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
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

function uninstall() {
  console.log('\n  hearkn — Uninstalling\n');

  // Remove hook file
  const hookPath = path.join(HOOKS_DIR, HOOK_FILENAME);
  if (fs.existsSync(hookPath)) {
    fs.unlinkSync(hookPath);
    console.log(`  ✓ Removed ${hookPath}`);
  }

  // Remove from settings.json
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (settings.hooks) {
        for (const event of ['Notification', 'Stop']) {
          if (settings.hooks[event]) {
            settings.hooks[event] = settings.hooks[event].filter(
              h => !h.hooks || !h.hooks.some(hh => hh.command && hh.command.includes('claude-notify'))
            );
            if (settings.hooks[event].length === 0) delete settings.hooks[event];
          }
        }
      }
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
      console.log(`  ✓ Removed hooks from ${SETTINGS_PATH}`);
    } catch (e) {
      console.log(`  ⚠ Could not clean ${SETTINGS_PATH}`);
    }
  }

  // Leave config in place (has user's topic)
  console.log(`  ℹ Config left at ${CONFIG_PATH} (contains your topic name)`);
  console.log('  Done.\n');
}

function status() {
  const hookPath = path.join(HOOKS_DIR, HOOK_FILENAME);
  const installed = fs.existsSync(hookPath);
  const config = loadExistingConfig();

  console.log('\n  hearkn status\n');
  console.log(`  Installed: ${installed ? 'yes' : 'no'}`);
  if (installed) {
    console.log(`  Hook: ${hookPath}`);
    console.log(`  Config: ${CONFIG_PATH}`);
    console.log(`  ntfy topic: ${config.ntfy_topic || '(not set)'}`);
    console.log(`  ntfy server: ${config.ntfy_server || 'https://ntfy.sh'}`);
    console.log(`  Hostname: ${config.hostname || os.hostname()}`);
    console.log(`  Click scheme: ${config.click_scheme || 'vscode'}`);
  }
  console.log('');
}

module.exports = { install, uninstall, status, checkClaudeCode, validateTopic };
