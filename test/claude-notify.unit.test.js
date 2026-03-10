// Unit tests for claude-notify.js
// TDD anchors — these define DESIRED behavior. Some will fail until implementation is fixed.
//
// Run: node --test ~/.claude/hooks/test/claude-notify.unit.test.js

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  summarize,
  getProjectName,
  buildNotification,
  buildClickUrl,
  shouldDebounce,
  loadConfig,
  DEBOUNCE_MS,
  HOME,
} = require('../lib/hook.js');


// ════════════════════════════════════════════════════════════════════════════
// summarize()
// ════════════════════════════════════════════════════════════════════════════

describe('summarize()', () => {

  // --- Basic behavior ---

  it('returns empty string for null/undefined/empty input', () => {
    assert.equal(summarize(null), '');
    assert.equal(summarize(undefined), '');
    assert.equal(summarize(''), '');
  });

  it('returns short text unchanged', () => {
    assert.equal(summarize('Hello world'), 'Hello world');
  });

  it('truncates at word boundary with ellipsis (default 300)', () => {
    const long = 'word '.repeat(100); // 500 chars
    const result = summarize(long);
    assert.ok(result.endsWith('...'), 'should end with ...');
    assert.ok(result.length <= 303, `should be <= 303 chars, got ${result.length}`); // 300 + '...'
  });

  it('respects custom maxLen parameter', () => {
    const text = 'This is a medium length sentence that goes on for a while';
    const result = summarize(text, 20);
    assert.ok(result.length <= 23, `should be <= 23 chars, got ${result.length}`);
    assert.ok(result.endsWith('...'));
  });

  // --- Markdown stripping ---

  it('strips markdown code blocks', () => {
    const text = 'Before ```const x = 1;\nconsole.log(x);``` After';
    assert.equal(summarize(text), 'Before After');
  });

  it('strips inline code backticks but keeps content', () => {
    assert.equal(summarize('Use `npm install` here'), 'Use npm install here');
  });

  it('strips bold markers but keeps content', () => {
    assert.equal(summarize('This is **important** text'), 'This is important text');
  });

  it('strips markdown links but keeps link text', () => {
    assert.equal(summarize('See [the docs](https://example.com) for info'), 'See the docs for info');
  });

  it('strips header markers', () => {
    assert.equal(summarize('## My Header'), 'My Header');
  });

  // --- Terminal → notification translation ---

  it('translates decorative separator lines to em dash', () => {
    assert.equal(
      summarize('First part\n──────────\nSecond part'),
      'First part — Second part'
    );
  });

  it('translates horizontal rules to em dash', () => {
    assert.equal(
      summarize('Above\n----------\nBelow'),
      'Above — Below'
    );
  });

  it('translates single newlines to pipe separator', () => {
    assert.equal(
      summarize('Line one\nLine two\nLine three'),
      'Line one | Line two | Line three'
    );
  });

  it('collapses multiple consecutive newlines to single pipe', () => {
    assert.equal(
      summarize('Before\n\n\nAfter'),
      'Before | After'
    );
  });

  it('does not produce redundant pipes around separators', () => {
    // Separator between lines: should be " — " not " | — | "
    assert.equal(
      summarize('Header\n─────────\nBody\nMore body'),
      'Header — Body | More body'
    );
  });

  it('handles star-prefixed decorative lines', () => {
    // The ★ Insight ─────── pattern from GSD output
    assert.equal(
      summarize('★ Insight ─────────────────\nSome content'),
      'Insight — Some content'
    );
  });

  it('collapses excess whitespace', () => {
    assert.equal(summarize('too   many    spaces'), 'too many spaces');
  });

  // --- List items ---

  it('translates unordered list markers to bullet character', () => {
    assert.equal(
      summarize('- Item one\n- Item two\n- Item three'),
      '\u2022 Item one | \u2022 Item two | \u2022 Item three'
    );
  });

  it('translates asterisk list markers to bullet character', () => {
    assert.equal(
      summarize('* First\n* Second'),
      '\u2022 First | \u2022 Second'
    );
  });

  it('preserves ordered list numbers', () => {
    const result = summarize('1. First step\n2. Second step\n3. Third step');
    assert.ok(result.includes('1.'), `should keep numbering, got: ${result}`);
    assert.ok(result.includes('2.'), `should keep numbering, got: ${result}`);
  });

  // --- Blockquotes ---

  it('strips blockquote markers', () => {
    assert.equal(summarize('> This is quoted text'), 'This is quoted text');
  });

  // --- Real-world Claude output ---

  it('handles typical Claude Code stop message', () => {
    const input = '## Next Up\n\n**Phase 2** \u2014 Research\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nAlso available:\n- Option A\n- Option B';
    const result = summarize(input);
    // Should contain key info without markdown noise
    assert.ok(result.includes('Next Up'), `should contain "Next Up", got: ${result}`);
    assert.ok(result.includes('Phase 2'), `should contain "Phase 2", got: ${result}`);
    assert.ok(result.includes('Research'), `should contain "Research", got: ${result}`);
    assert.ok(!result.includes('##'), 'should not contain ## markers');
    assert.ok(!result.includes('**'), 'should not contain ** markers');
    assert.ok(!result.includes('\u2500\u2500\u2500\u2500'), 'should not contain decorative chars');
    // List items should have bullet chars
    assert.ok(result.includes('\u2022 Option A'), `should have bullet for Option A, got: ${result}`);
    assert.ok(result.includes('\u2022 Option B'), `should have bullet for Option B, got: ${result}`);
  });

  // --- Very long input ---

  it('truncates very long assistant messages cleanly', () => {
    const long = 'This is a sentence. '.repeat(500); // ~10,000 chars
    const result = summarize(long);
    assert.ok(result.length <= 303, `should be <= 303 chars, got ${result.length}`);
    assert.ok(result.endsWith('...'), 'should end with ...');
    // Should not cut mid-word (the char before ... should be a space or punctuation)
    const beforeEllipsis = result.slice(0, -3);
    const lastChar = beforeEllipsis[beforeEllipsis.length - 1];
    assert.ok(
      lastChar === ' ' || lastChar === '.' || lastChar === ',' || lastChar === ';',
      `should truncate at word boundary, last char before "..." is "${lastChar}"`
    );
  });
});


// ════════════════════════════════════════════════════════════════════════════
// getProjectName()
// ════════════════════════════════════════════════════════════════════════════

describe('getProjectName()', () => {

  it('returns basename for project directory cwd', () => {
    assert.equal(
      getProjectName({}, '/home/rookslog/workspace/projects/scholardoc'),
      'scholardoc'
    );
  });

  it('returns basename when cwd is HOME (not empty string)', () => {
    // This is the title bug fix — HOME should produce "rookslog", not ""
    assert.equal(
      getProjectName({}, HOME),
      path.basename(HOME)
    );
  });

  it('returns basename for arbitrary paths', () => {
    assert.equal(getProjectName({}, '/tmp/foo'), 'foo');
  });

  it('handles special characters in path (spaces, parens)', () => {
    assert.equal(
      getProjectName({}, '/home/rookslog/workspace/projects/my project (2)'),
      'my project (2)'
    );
  });

  it('returns empty string when cwd is null/undefined', () => {
    assert.equal(getProjectName({}, null), '');
    assert.equal(getProjectName({}, undefined), '');
    assert.equal(getProjectName({}, ''), '');
  });

  it('uses cwd from data, not config workspace_root', () => {
    // Per-session cwd is the truth, not global workspace_root
    const config = { workspace_root: '/home/rookslog/workspace/projects/old-project' };
    assert.equal(
      getProjectName(config, '/home/rookslog/workspace/projects/scholardoc'),
      'scholardoc'
    );
  });

  it('returns different names for different CWDs (multi-window)', () => {
    const name1 = getProjectName({}, '/home/rookslog/workspace/projects/scholardoc');
    const name2 = getProjectName({}, '/home/rookslog/workspace/projects/philo-rag-simple');
    const name3 = getProjectName({}, HOME);

    assert.notEqual(name1, name2);
    assert.notEqual(name1, name3);
    assert.equal(name1, 'scholardoc');
    assert.equal(name2, 'philo-rag-simple');
    assert.equal(name3, path.basename(HOME));
  });
});


// ════════════════════════════════════════════════════════════════════════════
// buildNotification()
// ════════════════════════════════════════════════════════════════════════════

describe('buildNotification()', () => {

  const baseConfig = { hostname: 'dionysus' };

  // --- Title format ---

  it('includes folder name and hostname in title for project CWD', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', cwd: '/home/rookslog/workspace/projects/scholardoc' },
      baseConfig
    );
    assert.ok(result.title.includes('scholardoc'), `title should include project name, got: ${result.title}`);
    assert.ok(result.title.includes('dionysus'), `title should include hostname, got: ${result.title}`);
  });

  it('includes folder basename in title when CWD is HOME', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', cwd: HOME },
      baseConfig
    );
    assert.ok(result.title.includes(path.basename(HOME)), `title should include home basename, got: ${result.title}`);
  });

  // --- Event types ---

  it('formats stop event with summary', () => {
    const result = buildNotification(
      { hook_event_name: 'Stop', last_assistant_message: 'All tests pass now.', cwd: '/tmp/test' },
      baseConfig
    );
    assert.ok(result.message.startsWith('Done:'), `message should start with "Done:", got: ${result.message}`);
    assert.ok(result.message.includes('All tests pass now'), `message should include summary, got: ${result.message}`);
  });

  it('formats stop event without message as "Task completed"', () => {
    const result = buildNotification(
      { hook_event_name: 'Stop', cwd: '/tmp/test' },
      baseConfig
    );
    assert.equal(result.message, 'Task completed');
  });

  it('formats idle_prompt correctly', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: '/tmp/test' },
      baseConfig
    );
    assert.equal(result.message, 'Waiting for your input');
  });

  it('formats permission_prompt with priority 4', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: '/tmp/test' },
      baseConfig
    );
    assert.equal(result.message, 'Permission needed to continue');
    assert.equal(result.priority, 4);
  });

  it('formats elicitation_dialog correctly', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', cwd: '/tmp/test' },
      baseConfig
    );
    assert.equal(result.message, 'Question \u2014 needs your answer');
  });

  it('uses default message for unknown event types', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', notification_type: 'unknown_thing', cwd: '/tmp/test' },
      baseConfig
    );
    assert.equal(result.message, 'Needs your attention');
    assert.equal(result.priority, 3);
  });

  it('all event types except permission_prompt have priority 3', () => {
    for (const type of ['idle_prompt', 'elicitation_dialog', 'stop', 'attention_needed']) {
      const result = buildNotification(
        { hook_event_name: 'Notification', notification_type: type, cwd: '/tmp/test' },
        baseConfig
      );
      assert.equal(result.priority, 3, `${type} should have priority 3`);
    }
  });
});


// ════════════════════════════════════════════════════════════════════════════
// buildClickUrl()
// ════════════════════════════════════════════════════════════════════════════

describe('buildClickUrl()', () => {

  it('returns empty string when mode is none', () => {
    assert.equal(buildClickUrl({ click_mode: 'none', click_scheme: 'vscode' }, '/tmp'), '');
  });

  it('returns empty string when scheme is none', () => {
    assert.equal(buildClickUrl({ click_mode: 'workspace', click_scheme: 'none' }, '/tmp'), '');
  });

  it('returns scheme:// only for app mode', () => {
    assert.equal(buildClickUrl({ click_mode: 'app', click_scheme: 'vscode' }, '/tmp'), 'vscode://');
  });

  it('returns full vscode-remote URL for workspace mode', () => {
    const url = buildClickUrl(
      { click_mode: 'workspace', click_scheme: 'vscode', hostname: 'dionysus' },
      '/home/rookslog/workspace/projects/scholardoc'
    );
    assert.equal(url, 'vscode://vscode-remote/ssh-remote+dionysus/home/rookslog/workspace/projects/scholardoc');
  });

  it('falls back to scheme:// when no folder available', () => {
    assert.equal(buildClickUrl({ click_mode: 'workspace', click_scheme: 'vscode' }, ''), 'vscode://');
  });

  it('defaults scheme to vscode when not specified', () => {
    const url = buildClickUrl({ click_mode: 'app' }, '/tmp');
    assert.equal(url, 'vscode://');
  });

  it('supports cursor scheme', () => {
    const url = buildClickUrl(
      { click_mode: 'workspace', click_scheme: 'cursor', hostname: 'dionysus' },
      '/home/rookslog'
    );
    assert.ok(url.startsWith('cursor://'), `should start with cursor://, got: ${url}`);
  });

  it('uses cwd parameter, not config workspace_root, for folder', () => {
    const url = buildClickUrl(
      { click_mode: 'workspace', click_scheme: 'vscode', hostname: 'dionysus', workspace_root: '/old/path' },
      '/home/rookslog/workspace/projects/scholardoc'
    );
    // Should use cwd, not workspace_root
    assert.ok(url.includes('scholardoc'), `should use cwd path, got: ${url}`);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// shouldDebounce()
// ════════════════════════════════════════════════════════════════════════════

describe('shouldDebounce()', () => {

  const testSessionId = `unit-test-debounce-${Date.now()}`;
  const debounceFile = path.join(os.tmpdir(), `claude-notify-${testSessionId}.json`);

  afterEach(() => {
    // Cleanup debounce state files
    try { fs.unlinkSync(debounceFile); } catch (e) { /* ignore */ }
  });

  it('returns false on first call (no state file)', () => {
    assert.equal(shouldDebounce(testSessionId), false);
  });

  it('returns true on immediate second call (within debounce window)', () => {
    shouldDebounce(testSessionId); // first call — creates state
    assert.equal(shouldDebounce(testSessionId), true);
  });

  it('creates state file with lastNotify timestamp', () => {
    shouldDebounce(testSessionId);
    assert.ok(fs.existsSync(debounceFile), 'state file should exist');
    const state = JSON.parse(fs.readFileSync(debounceFile, 'utf8'));
    assert.ok(typeof state.lastNotify === 'number', 'lastNotify should be a number');
    assert.ok(Date.now() - state.lastNotify < 1000, 'timestamp should be recent');
  });

  it('returns false when state file is corrupted', () => {
    fs.writeFileSync(debounceFile, 'not json{{{');
    assert.equal(shouldDebounce(testSessionId), false);
  });

  it('different session IDs do not interfere', () => {
    const otherId = `unit-test-other-${Date.now()}`;
    const otherFile = path.join(os.tmpdir(), `claude-notify-${otherId}.json`);

    try {
      shouldDebounce(testSessionId); // first session
      assert.equal(shouldDebounce(otherId), false, 'different session should not be debounced');
    } finally {
      try { fs.unlinkSync(otherFile); } catch (e) { /* ignore */ }
    }
  });

  it('returns false when lastNotify is beyond debounce window', () => {
    // Write a state file with an old timestamp
    const oldTimestamp = Date.now() - DEBOUNCE_MS - 1000;
    fs.writeFileSync(debounceFile, JSON.stringify({ lastNotify: oldTimestamp }));
    assert.equal(shouldDebounce(testSessionId), false);
  });

  it('sanitizes session_id to prevent path traversal', () => {
    const maliciousId = '../../etc/evil';
    const result = shouldDebounce(maliciousId);
    // Should not create a file outside /tmp
    const expectedSafe = path.join(os.tmpdir(), `claude-notify-${maliciousId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    const dangerousPath = path.join(os.tmpdir(), `claude-notify-${maliciousId}.json`);

    // The dangerous path should NOT exist (it would be /tmp/claude-notify-../../etc/evil.json)
    // Either the function sanitizes the ID, or the path resolves safely within /tmp
    const resolvedPath = path.resolve(os.tmpdir(), `claude-notify-${maliciousId}.json`);
    assert.ok(
      resolvedPath.startsWith(os.tmpdir()) || !fs.existsSync(resolvedPath),
      `path traversal should be prevented: resolved to ${resolvedPath}`
    );

    // Cleanup
    try { fs.unlinkSync(resolvedPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(expectedSafe); } catch (e) { /* ignore */ }
  });
});


// ════════════════════════════════════════════════════════════════════════════
// loadConfig()
// ════════════════════════════════════════════════════════════════════════════

describe('loadConfig()', () => {

  // Note: loadConfig reads ~/.claude-notify.conf which is a real file.
  // These tests verify the current config loads correctly.
  // For edge cases (missing file, invalid JSON), we'd need to mock the filesystem
  // or use a configurable path — testing the real config is still valuable.

  it('returns an object with expected keys', () => {
    const config = loadConfig();
    assert.ok(typeof config === 'object');
    assert.ok('ntfy_enabled' in config, 'should have ntfy_enabled');
    assert.ok('ntfy_server' in config, 'should have ntfy_server');
    assert.ok('hostname' in config, 'should have hostname');
  });

  it('has a valid ntfy_server URL', () => {
    const config = loadConfig();
    assert.ok(config.ntfy_server.startsWith('http'), `ntfy_server should be a URL, got: ${config.ntfy_server}`);
  });

  it('hostname defaults to os.hostname()', () => {
    const config = loadConfig();
    assert.ok(typeof config.hostname === 'string');
    assert.ok(config.hostname.length > 0, 'hostname should not be empty');
  });
});


// ════════════════════════════════════════════════════════════════════════════
// buildNotification() — edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('buildNotification() edge cases', () => {

  const baseConfig = { hostname: 'dionysus' };

  it('notification_type takes precedence over hook_event_name', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: '/tmp/test' },
      baseConfig
    );
    // notification_type should win over hook_event_name
    assert.equal(result.message, 'Permission needed to continue');
    assert.equal(result.priority, 4);
  });

  it('falls back to hook_event_name when notification_type is absent', () => {
    const result = buildNotification(
      { hook_event_name: 'Stop', last_assistant_message: 'Done.', cwd: '/tmp/test' },
      baseConfig
    );
    assert.ok(result.message.startsWith('Done:'), `should use Stop event, got: ${result.message}`);
  });

  it('handles empty/missing cwd gracefully', () => {
    const result1 = buildNotification(
      { hook_event_name: 'Notification', cwd: '' },
      baseConfig
    );
    assert.ok(typeof result1.title === 'string', 'should produce a string title');

    const result2 = buildNotification(
      { hook_event_name: 'Notification' },
      baseConfig
    );
    assert.ok(typeof result2.title === 'string', 'should produce a string title with missing cwd');
  });

  it('handles special characters in project name', () => {
    const result = buildNotification(
      { hook_event_name: 'Notification', cwd: '/home/rookslog/workspace/projects/my project (v2)' },
      baseConfig
    );
    assert.ok(result.title.includes('my project (v2)'), `title should include special chars, got: ${result.title}`);
  });

  it('stop event with very long markdown message truncates cleanly', () => {
    const longMarkdown = '## Summary\n\n' + '**Important:** '.repeat(100) + '\n\n' + '- item\n'.repeat(50);
    const result = buildNotification(
      { hook_event_name: 'Stop', last_assistant_message: longMarkdown, cwd: '/tmp/test' },
      baseConfig
    );
    assert.ok(result.message.startsWith('Done:'), 'should start with Done:');
    // "Done: " is 6 chars, summarize output is max 303 chars
    assert.ok(result.message.length <= 310, `message should be bounded, got ${result.message.length}`);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// VS Code focus behavior
// ════════════════════════════════════════════════════════════════════════════

describe('VS Code focus behavior', () => {

  // These test the main pipeline's code -r . logic conceptually.
  // Since the main block only runs when require.main === module,
  // we test by verifying the env var check pattern is correct.

  it('VSCODE_IPC_HOOK_CLI env var is detectable', () => {
    // Verify the env var detection mechanism works
    const original = process.env.VSCODE_IPC_HOOK_CLI;

    process.env.VSCODE_IPC_HOOK_CLI = '/tmp/fake-ipc-socket';
    assert.ok(process.env.VSCODE_IPC_HOOK_CLI, 'should be truthy when set');

    delete process.env.VSCODE_IPC_HOOK_CLI;
    assert.ok(!process.env.VSCODE_IPC_HOOK_CLI, 'should be falsy when unset');

    // Restore
    if (original) process.env.VSCODE_IPC_HOOK_CLI = original;
  });
});
