#!/usr/bin/env node
// hearkn — AI Coding Agent Notification Hook
// Pure JS — no shell dependencies. Installed by `npx hearkn`.
//
// Fires on Notification and Stop events. Sends push notifications
// via ntfy.sh so you know when your agent needs your attention.
//
// Debounce: max 1 notification per 30 seconds per session.
// Silent fail: never blocks or breaks agent sessions.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const DEBOUNCE_MS = 30000;
const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.claude-notify.conf');

// --- Config loading ---

function loadConfig() {
  const defaults = {
    ntfy_enabled: true,
    ntfy_topic: '',
    ntfy_server: 'https://ntfy.sh',
    hostname: os.hostname(),
    click_scheme: 'vscode',  // vscode, vscode-insiders, cursor, none
  };

  if (!fs.existsSync(CONFIG_PATH)) return defaults;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    return { ...defaults, ...config };
  } catch (e) {
    return defaults;
  }
}

// --- Message formatting ---

function summarize(text, maxLen = 300) {
  if (!text) return '';
  let clean = text
    // Strip code blocks entirely
    .replace(/```[\s\S]*?```/g, '')
    // Strip inline code backticks, keep content
    .replace(/`([^`]+)`/g, '$1')
    // Strip bold markers, keep content
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Strip markdown links, keep link text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip header markers (## etc.)
    .replace(/^#{1,6}\s+/gm, '')
    // Strip blockquote markers
    .replace(/^>\s*/gm, '')
    // Translate unordered list markers to bullet character
    .replace(/^[-*]\s+/gm, '\u2022 ')
    // Strip standalone decorative characters (★☆●○ etc.)
    .replace(/[★☆●○◆◇■□▪▫]/g, '')
    // Decorative separator lines → em dash placeholder
    .replace(/[─━═╌╍┄┅┈┉▔▁]{3,}/g, '\x1FSEP\x1F')
    .replace(/[-=~_]{5,}/g, '\x1FSEP\x1F')
    // Collapse multiple newlines to single newline
    .replace(/\n{2,}/g, '\n')
    // Translate separator placeholders (with surrounding whitespace/newlines) to em dash
    .replace(/\s*\x1FSEP\x1F\s*/g, ' \u2014 ')
    // Translate remaining newlines to pipe separator
    .replace(/\n/g, ' | ')
    // Collapse excess whitespace
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLen) return clean;
  const truncated = clean.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

function getProjectName(config, cwd) {
  // Per-session cwd is the truth — not the global workspace_root config
  const root = cwd || '';
  if (!root) return '';
  return path.basename(root);
}

function buildNotification(data, config) {
  const type = (data.notification_type || data.hook_event_name || 'attention_needed').toLowerCase();
  const project = getProjectName(config, data.cwd);
  const host = config.hostname || os.hostname();
  const title = project ? `${project} [SSH: ${host}]` : 'Claude Code';

  let message = '';
  switch (type) {
    case 'stop': {
      const summary = summarize(data.last_assistant_message);
      message = summary ? `Done: ${summary}` : 'Task completed';
      break;
    }
    case 'idle_prompt':
      message = 'Waiting for your input';
      break;
    case 'permission_prompt':
      message = 'Permission needed to continue';
      break;
    case 'elicitation_dialog':
      message = 'Question — needs your answer';
      break;
    default:
      message = 'Needs your attention';
  }

  const priority = type === 'permission_prompt' ? 4 : 3;

  return { type, title, message, priority, cwd: data.cwd || '' };
}

// --- Click URL ---

// Strategy:
//   "workspace" — vscode://vscode-remote/ssh-remote+host/workspace_root
//                 Focuses VS Code window with matching folder. Works best
//                 with one remote window; unreliable with multiple.
//   "app"       — vscode:// (just brings VS Code to front, no folder targeting)
//   "none"      — no click action
//
// Config: click_scheme (vscode/cursor/none), click_mode (workspace/app/none)
function buildClickUrl(config, cwd) {
  const mode = config.click_mode || 'workspace';
  const scheme = config.click_scheme || 'vscode';

  if (mode === 'none' || scheme === 'none') return '';

  if (mode === 'app') {
    // Just bring the editor to front — no folder matching, no window confusion
    return `${scheme}://`;
  }

  // workspace mode: target a specific folder (cwd is per-session truth)
  if (!cwd) return `${scheme}://`;
  const host = config.hostname || os.hostname();
  return `${scheme}://vscode-remote/ssh-remote+${host}${cwd}`;
}

// --- ntfy.sh sender (pure Node.js, no curl) ---

function sendNtfy(config, notification) {
  return new Promise((resolve) => {
    if (!config.ntfy_enabled || !config.ntfy_topic) {
      resolve();
      return;
    }

    const serverUrl = config.ntfy_server || 'https://ntfy.sh';
    const url = `${serverUrl}`;
    const clickUrl = buildClickUrl(config, notification.cwd);

    // Use JSON body mode — avoids HTTP header encoding issues with unicode
    const payload = {
      topic: config.ntfy_topic,
      title: notification.title,
      message: notification.message,
      priority: notification.priority,
      tags: ['robot'],
    };
    if (clickUrl) {
      payload.click = clickUrl;
    }

    const body = JSON.stringify(payload);
    const parsed = new URL(url);
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
    }, () => resolve());

    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// --- Debounce ---

function shouldDebounce(sessionId) {
  const tmpDir = os.tmpdir();
  // Sanitize session_id to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const debounceFile = path.join(tmpDir, `claude-notify-${safeId}.json`);

  if (fs.existsSync(debounceFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(debounceFile, 'utf8'));
      if (Date.now() - (state.lastNotify || 0) < DEBOUNCE_MS) return true;
    } catch (e) {
      // Corrupted — continue
    }
  }

  fs.writeFileSync(debounceFile, JSON.stringify({ lastNotify: Date.now() }));
  return false;
}

// --- Main (only when run directly, not when required for testing) ---

if (require.main === module) {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    try {
      const data = JSON.parse(input);

      if (!data.session_id || shouldDebounce(data.session_id)) {
        process.stdout.write('{}');
        process.exit(0);
      }

      const config = loadConfig();
      const notification = buildNotification(data, config);

      // Focus the VS Code window if running in a VS Code terminal.
      // The code CLI uses VSCODE_IPC_HOOK_CLI to target the exact window.
      if (process.env.VSCODE_IPC_HOOK_CLI) {
        try {
          require('child_process').execSync('code -r .', {
            timeout: 3000,
            stdio: 'ignore',
            env: { ...process.env },
          });
        } catch (e) {
          // Stale IPC socket or code CLI unavailable — skip
        }
      }

      sendNtfy(config, notification).then(() => {
        process.stdout.write('{}');
        process.exit(0);
      });
    } catch (e) {
      process.stdout.write('{}');
      process.exit(0);
    }
  });
}

// --- Exports (for testing) ---

module.exports = {
  summarize,
  getProjectName,
  buildNotification,
  buildClickUrl,
  loadConfig,
  shouldDebounce,
  sendNtfy,
  DEBOUNCE_MS,
  HOME,
  CONFIG_PATH,
};
