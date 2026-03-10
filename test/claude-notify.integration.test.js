// Integration tests for claude-notify.js
// Tests ntfy.sh round-trip: send notification → poll API → verify payload.
//
// These tests hit the real ntfy.sh API with a unique test topic.
// Each test run uses a timestamped topic to avoid collisions.
//
// Run: node --test ~/.claude/hooks/test/claude-notify.integration.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');

const { sendNtfy } = require('../lib/hook.js');

// --- Helpers ---

// Unique topic per test run to avoid cross-run interference
const TEST_TOPIC = `claude-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NTFY_SERVER = 'https://ntfy.sh';

// Poll ntfy.sh for recent messages on the test topic
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
          .map(line => {
            try { return JSON.parse(line); }
            catch (e) { return null; }
          })
          .filter(msg => msg && msg.event === 'message');
        resolve(messages);
      });
    }).on('error', reject);
  });
}

// Wait a bit for ntfy.sh to process the message
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ════════════════════════════════════════════════════════════════════════════
// ntfy.sh round-trip
// ════════════════════════════════════════════════════════════════════════════

describe('ntfy.sh round-trip', () => {

  it('delivers notification with correct title', async () => {
    const config = {
      ntfy_enabled: true,
      ntfy_topic: TEST_TOPIC,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_mode: 'none',
    };
    const notification = {
      title: 'scholardoc [SSH: dionysus]',
      message: 'Waiting for your input',
      priority: 3,
      cwd: '/home/rookslog/workspace/projects/scholardoc',
    };

    await sendNtfy(config, notification);
    await wait(1500); // allow ntfy.sh to process

    const messages = await pollNtfy(TEST_TOPIC);
    assert.ok(messages.length >= 1, `expected at least 1 message, got ${messages.length}`);

    const msg = messages[messages.length - 1]; // most recent
    assert.equal(msg.title, 'scholardoc [SSH: dionysus]');
  });

  it('delivers notification with correct message body', async () => {
    const topic = `${TEST_TOPIC}-body`;
    const config = {
      ntfy_enabled: true,
      ntfy_topic: topic,
      ntfy_server: NTFY_SERVER,
      click_mode: 'none',
    };
    const notification = {
      title: 'Claude Code',
      message: 'Permission needed to continue',
      priority: 4,
      cwd: '/tmp/test',
    };

    await sendNtfy(config, notification);
    await wait(1500);

    const messages = await pollNtfy(topic);
    assert.ok(messages.length >= 1, `expected at least 1 message, got ${messages.length}`);
    assert.equal(messages[messages.length - 1].message, 'Permission needed to continue');
  });

  it('delivers notification with correct priority', async () => {
    const topic = `${TEST_TOPIC}-priority`;
    const config = {
      ntfy_enabled: true,
      ntfy_topic: topic,
      ntfy_server: NTFY_SERVER,
      click_mode: 'none',
    };
    const notification = {
      title: 'Test',
      message: 'High priority test',
      priority: 4,
      cwd: '/tmp',
    };

    await sendNtfy(config, notification);
    await wait(1500);

    const messages = await pollNtfy(topic);
    assert.ok(messages.length >= 1);
    assert.equal(messages[messages.length - 1].priority, 4);
  });

  it('delivers click URL when configured', async () => {
    const topic = `${TEST_TOPIC}-click`;
    const config = {
      ntfy_enabled: true,
      ntfy_topic: topic,
      ntfy_server: NTFY_SERVER,
      hostname: 'dionysus',
      click_scheme: 'vscode',
      click_mode: 'workspace',
    };
    const notification = {
      title: 'Test',
      message: 'Click test',
      priority: 3,
      cwd: '/home/rookslog/workspace/projects/scholardoc',
    };

    await sendNtfy(config, notification);
    await wait(1500);

    const messages = await pollNtfy(topic);
    assert.ok(messages.length >= 1);
    const msg = messages[messages.length - 1];
    assert.ok(msg.click, 'should have click URL');
    assert.ok(msg.click.includes('vscode://'), `click should start with vscode://, got: ${msg.click}`);
    assert.ok(msg.click.includes('scholardoc'), `click should include project path, got: ${msg.click}`);
  });

  it('sends nothing when ntfy_enabled is false', async () => {
    const topic = `${TEST_TOPIC}-disabled`;
    const config = {
      ntfy_enabled: false,
      ntfy_topic: topic,
      ntfy_server: NTFY_SERVER,
    };
    const notification = {
      title: 'Should Not Arrive',
      message: 'This should not be sent',
      priority: 3,
      cwd: '/tmp',
    };

    await sendNtfy(config, notification);
    await wait(1500);

    const messages = await pollNtfy(topic);
    assert.equal(messages.length, 0, 'should receive no messages when disabled');
  });

  it('sends nothing when topic is empty', async () => {
    const config = {
      ntfy_enabled: true,
      ntfy_topic: '',
      ntfy_server: NTFY_SERVER,
    };
    const notification = {
      title: 'Should Not Arrive',
      message: 'No topic set',
      priority: 3,
      cwd: '/tmp',
    };

    // Should resolve without error
    await sendNtfy(config, notification);
    // No assertion on ntfy — we just verify it doesn't throw
  });

  it('delivers notification with robot tag', async () => {
    const topic = `${TEST_TOPIC}-tags`;
    const config = {
      ntfy_enabled: true,
      ntfy_topic: topic,
      ntfy_server: NTFY_SERVER,
      click_mode: 'none',
    };
    const notification = {
      title: 'Tag Test',
      message: 'Checking tags',
      priority: 3,
      cwd: '/tmp',
    };

    await sendNtfy(config, notification);
    await wait(1500);

    const messages = await pollNtfy(topic);
    assert.ok(messages.length >= 1);
    const msg = messages[messages.length - 1];
    assert.ok(Array.isArray(msg.tags), `tags should be an array, got: ${typeof msg.tags}`);
    assert.ok(msg.tags.includes('robot'), `tags should include "robot", got: ${msg.tags}`);
  });

  it('handles unicode in title and message', async () => {
    const topic = `${TEST_TOPIC}-unicode`;
    const config = {
      ntfy_enabled: true,
      ntfy_topic: topic,
      ntfy_server: NTFY_SERVER,
      click_mode: 'none',
    };
    const notification = {
      title: 'Ph\u00e4nomenologie des Geistes',
      message: 'Hegel\u2019s \u00dcbergang: \u00ab\u03b1\u03c1\u03c7\u03ae\u00bb to \u00abT\u00e9los\u00bb',
      priority: 3,
      cwd: '/tmp',
    };

    await sendNtfy(config, notification);
    await wait(1500);

    const messages = await pollNtfy(topic);
    assert.ok(messages.length >= 1);
    const msg = messages[messages.length - 1];
    assert.ok(msg.title.includes('Ph\u00e4nomenologie'), `unicode title should survive round-trip, got: ${msg.title}`);
    assert.ok(msg.message.includes('\u03b1\u03c1\u03c7\u03ae'), `greek chars should survive, got: ${msg.message}`);
  });

  it('resolves without hanging on unreachable server', async () => {
    const config = {
      ntfy_enabled: true,
      ntfy_topic: 'test',
      ntfy_server: 'https://192.0.2.1', // TEST-NET, guaranteed unreachable
    };
    const notification = {
      title: 'Unreachable',
      message: 'Should timeout gracefully',
      priority: 3,
      cwd: '/tmp',
    };

    // Should resolve within 6 seconds (5s timeout + buffer)
    const start = Date.now();
    await sendNtfy(config, notification);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10000, `should resolve within 10s, took ${elapsed}ms`);
  });
});
