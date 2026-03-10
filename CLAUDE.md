# hearkn

Push notifications for AI coding agents via ntfy.sh with click-to-focus VS Code window support.

## Project Structure

| File | Purpose |
|------|---------|
| `bin/cli.js` | CLI entry point — `npx hearkn [test\|status\|uninstall]` |
| `lib/hook.js` | The hook — reads stdin JSON, sends ntfy, focuses VS Code window |
| `lib/install.js` | Interactive installer — prompts, patches settings.json, sends test |
| `test/*.test.js` | TDD suite — unit (62), integration (9), E2E (9) |
| `package.json` | npm package config |

## Conventions

- **Zero dependencies** — only Node.js built-ins (fs, os, path, https, http, readline)
- **Silent fail** — hooks must never block or crash the agent; all errors → `{}` + exit
- **Pure JS** — no shell scripts, no curl; everything in Node.js for cross-platform portability
- **Config lives at** `~/.claude-notify.conf` (JSON)
- **Hook installs to** `~/.claude/hooks/claude-notify.js`
- **Deploy during dev**: `cp lib/hook.js ~/.claude/hooks/claude-notify.js`
- **Clear debounce for testing**: `rm -f /tmp/claude-notify-*.json`

## Hook Protocol

The agent sends JSON on stdin, expects `{}` on stdout. The hook must:
1. Read all stdin (JSON payload)
2. Do its work (send notification, focus window)
3. Write `{}` to stdout
4. Exit

Never write anything else to stdout. Never throw uncaught exceptions.

## Config Schema (`~/.claude-notify.conf`)

```json
{
  "ntfy_enabled": true,
  "ntfy_topic": "claude-xyz123",           // Unique, hard to guess (public topics)
  "ntfy_server": "https://ntfy.sh",        // Or self-hosted
  "hostname": "myhost",                    // SSH hostname for vscode:// URLs
  "click_scheme": "vscode",               // vscode | vscode-insiders | cursor | none
  "click_mode": "workspace"               // workspace | app | none
}
```

## Version Control

- **Trunk-based** on `main` — no feature branches for this project size
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `chore:`, `test:`
- **`wip:` prefix** for pause-work commits (mid-task handoff)
- **Semver tags** (`v0.1.0`) for npm publish points
- **CI**: GitHub Actions runs unit tests on push (Node 18/20/22, Ubuntu + macOS)
- All tests must pass before committing to main

## Testing

```bash
# Unit tests (62 tests, fast, no network)
npm test

# Integration tests (9 tests, hits ntfy.sh — can be flaky due to rate limits)
npm run test:integration

# E2E tests (9 tests, full stdin pipeline)
npm run test:e2e

# All tests
npm run test:all

# Simulate a Stop event manually
echo '{"session_id":"test","cwd":"/home/user","hook_event_name":"Stop","last_assistant_message":"Hello world."}' | node lib/hook.js

# CLI commands
node bin/cli.js status
node bin/cli.js test
```
