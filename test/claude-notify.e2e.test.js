// End-to-end tests for claude-notify.js
// Simulates the full Claude Code hook invocation: pipe JSON to stdin → verify ntfy.sh receives correct payload.
//
// These tests spawn the hook as a child process (just like Claude Code does)
// and verify the full pipeline: stdin → parse → debounce → config → build → send → ntfy.sh.
//
// Run: node --test ~/.claude/hooks/test/claude-notify.e2e.test.js

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const HOOK_PATH = path.join(__dirname, '..', 'lib', 'hook.js');
const NTFY_SERVER = 'https://ntfy.sh';
const E2E_TOPIC = `claude-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// We need a test config that uses our E2E test topic
const REAL_CONFIG_PATH = path.join(os.homedir(), '.claude-notify.conf');
const BACKUP_CONFIG_PATH = path.join(os.homedir(), '.claude-notify.conf.bak');

// --- Helpers ---

function pollNtfy(topic, sinceSec = 30) {
  return new Promise((resolve, reject) => {
    const url = `${NTFY_SERVER}/${topic}/json?poll=1&since=${sinceSec}s`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const messages = data
          .trim()
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => { try { return JSON.parse(line); } catch (e) { return null; } })
          .filter(msg => msg && msg.event === 'message');
        resolve(messages);
      });
    }).on('error', reject);
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the hook with given stdin JSON, returns { exitCode, stdout, stderr }
function runHook(stdinJson, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_PATH], {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });

    if (stdinJson !== null) {
      child.stdin.write(typeof stdinJson === 'string' ? stdinJson : JSON.stringify(stdinJson));
    }
    child.stdin.end();
  });
}

function cleanDebounceFile(sessionId) {
  const f = path.join(os.tmpdir(), `claude-notify-${sessionId}.json`);
  try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
}


// ════════════════════════════════════════════════════════════════════════════
// Test setup: swap config to use E2E test topic
// ════════════════════════════════════════════════════════════════════════════

describe('E2E hook pipeline', () => {

  let originalConfig;

  before(() => {
    // Backup real config
    if (fs.existsSync(REAL_CONFIG_PATH)) {
      originalConfig = fs.readFileSync(REAL_CONFIG_PATH, 'utf8');
    }

    // Write test config
    const testConfig = {
      ntfy_enabled: true,
      ntfy_topic: E2E_TOPIC,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_scheme: 'vscode',
      click_mode: 'none', // no click URLs in E2E to keep assertions simple
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(testConfig, null, 2));
  });

  after(() => {
    // Restore original config
    if (originalConfig) {
      fs.writeFileSync(REAL_CONFIG_PATH, originalConfig);
    }
  });

  // --- Core pipeline ---

  it('Notification event produces correct ntfy message', async () => {
    const sessionId = `e2e-notif-${Date.now()}`;
    cleanDebounceFile(sessionId);

    const result = await runHook({
      session_id: sessionId,
      cwd: '/home/rookslog/workspace/projects/scholardoc',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });

    assert.equal(result.exitCode, 0, `hook should exit 0, got ${result.exitCode}, stderr: ${result.stderr}`);
    await wait(2000);

    const messages = await pollNtfy(E2E_TOPIC);
    assert.ok(messages.length >= 1, `expected ntfy message, got ${messages.length}`);

    const msg = messages[messages.length - 1];
    assert.ok(msg.title.includes('scholardoc'), `title should include "scholardoc", got: ${msg.title}`);
    assert.equal(msg.message, 'Waiting for your input');

    cleanDebounceFile(sessionId);
  });

  it('Stop event with last_assistant_message produces "Done:" summary', async () => {
    const sessionId = `e2e-stop-${Date.now()}`;
    cleanDebounceFile(sessionId);

    const result = await runHook({
      session_id: sessionId,
      cwd: '/home/rookslog/workspace/projects/scholardoc',
      hook_event_name: 'Stop',
      last_assistant_message: 'All 5 tests are passing now.',
    });

    assert.equal(result.exitCode, 0);
    await wait(2000);

    const messages = await pollNtfy(E2E_TOPIC);
    const msg = messages[messages.length - 1];
    assert.ok(msg.message.startsWith('Done:'), `message should start with "Done:", got: ${msg.message}`);
    assert.ok(msg.message.includes('tests'), `message should include summary content, got: ${msg.message}`);

    cleanDebounceFile(sessionId);
  });

  // --- CWD / title robustness (multi-window) ---

  it('project CWD produces title with project name', async () => {
    const sessionId = `e2e-proj-${Date.now()}`;
    cleanDebounceFile(sessionId);

    const result = await runHook({
      session_id: sessionId,
      cwd: '/home/rookslog/workspace/projects/philo-rag-simple',
      hook_event_name: 'Notification',
    });

    assert.equal(result.exitCode, 0);
    await wait(2000);

    const messages = await pollNtfy(E2E_TOPIC);
    const msg = messages[messages.length - 1];
    assert.ok(msg.title.includes('philo-rag-simple'), `title should include "philo-rag-simple", got: ${msg.title}`);

    cleanDebounceFile(sessionId);
  });

  it('HOME CWD produces title with home basename (not empty)', async () => {
    const sessionId = `e2e-home-${Date.now()}`;
    cleanDebounceFile(sessionId);

    const result = await runHook({
      session_id: sessionId,
      cwd: os.homedir(),
      hook_event_name: 'Notification',
    });

    assert.equal(result.exitCode, 0);
    await wait(2000);

    const messages = await pollNtfy(E2E_TOPIC);
    const msg = messages[messages.length - 1];
    // Title should include "rookslog", not be bare "Claude Code"
    assert.ok(
      msg.title.includes(path.basename(os.homedir())),
      `title should include home basename "${path.basename(os.homedir())}", got: ${msg.title}`
    );

    cleanDebounceFile(sessionId);
  });

  // --- Debounce ---

  it('debounce: rapid duplicate sends only 1 message', async () => {
    const sessionId = `e2e-debounce-${Date.now()}`;
    const debounceTopic = `${E2E_TOPIC}-deb`;
    cleanDebounceFile(sessionId);

    // Temporarily write config with debounce topic
    const debounceConfig = {
      ntfy_enabled: true,
      ntfy_topic: debounceTopic,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(debounceConfig, null, 2));

    const payload = {
      session_id: sessionId,
      cwd: '/home/rookslog/workspace/projects/test',
      hook_event_name: 'Notification',
    };

    // Fire twice rapidly with the same session_id
    await runHook(payload);
    await wait(200); // ensure debounce file is flushed to disk
    await runHook(payload);
    await wait(2000);

    const messages = await pollNtfy(debounceTopic);
    assert.equal(messages.length, 1, `expected exactly 1 message (debounced), got ${messages.length}`);

    cleanDebounceFile(sessionId);

    // Restore E2E topic config
    const testConfig = {
      ntfy_enabled: true,
      ntfy_topic: E2E_TOPIC,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(testConfig, null, 2));
  });

  it('different session IDs are not debounced against each other', async () => {
    // Use a fully unique topic for this test to guarantee isolation
    const multiTopic = `claude-multi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionId1 = `e2e-multi1-${Date.now()}`;
    const sessionId2 = `e2e-multi2-${Date.now()}`;
    cleanDebounceFile(sessionId1);
    cleanDebounceFile(sessionId2);

    const multiConfig = {
      ntfy_enabled: true,
      ntfy_topic: multiTopic,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(multiConfig, null, 2));

    await runHook({
      session_id: sessionId1,
      cwd: '/home/rookslog/workspace/projects/project-a',
      hook_event_name: 'Notification',
    });
    await runHook({
      session_id: sessionId2,
      cwd: '/home/rookslog/workspace/projects/project-b',
      hook_event_name: 'Notification',
    });
    await wait(3000);

    const messages = await pollNtfy(multiTopic, 30);
    assert.equal(messages.length, 2, `expected 2 messages (different sessions), got ${messages.length}`);

    cleanDebounceFile(sessionId1);
    cleanDebounceFile(sessionId2);

    // Restore E2E topic config
    const testConfig = {
      ntfy_enabled: true,
      ntfy_topic: E2E_TOPIC,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(testConfig, null, 2));
  });

  // --- Error resilience ---

  it('invalid JSON stdin exits 0 (no crash)', async () => {
    const result = await runHook('not valid json {{{');
    assert.equal(result.exitCode, 0, `should exit 0 on invalid JSON, got ${result.exitCode}`);
  });

  it('empty stdin exits 0 after timeout', async () => {
    const result = await runHook('', 5000);
    assert.equal(result.exitCode, 0, `should exit 0 on empty stdin, got ${result.exitCode}`);
  });

  it('missing session_id exits 0 without sending', async () => {
    const missingIdTopic = `${E2E_TOPIC}-noid`;
    const noIdConfig = {
      ntfy_enabled: true,
      ntfy_topic: missingIdTopic,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(noIdConfig, null, 2));

    const result = await runHook({
      cwd: '/tmp/test',
      hook_event_name: 'Notification',
      // no session_id
    });

    assert.equal(result.exitCode, 0);
    await wait(1500);

    const messages = await pollNtfy(missingIdTopic);
    assert.equal(messages.length, 0, 'should send nothing without session_id');

    // Restore
    const testConfig = {
      ntfy_enabled: true,
      ntfy_topic: E2E_TOPIC,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    fs.writeFileSync(REAL_CONFIG_PATH, JSON.stringify(testConfig, null, 2));
  });
});
