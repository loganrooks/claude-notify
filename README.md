# hearkn

Push notifications for AI coding agents via [ntfy.sh](https://ntfy.sh). Know when your agent needs you — from your phone, another monitor, or across the room.

Works with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex, Gemini CLI, OpenCode, and any agent that supports hook systems. Compatible with VS Code Remote SSH, Cursor, and plain SSH terminals.

## What it does

When your AI coding agent stops, needs permission, or asks a question, you get a push notification on your phone (or desktop). Tapping the notification focuses the correct VS Code window.

| Event | Notification |
|-------|-------------|
| Task completed | "Done: {summary of last response}" |
| Waiting for input | "Waiting for your input" |
| Permission needed | "Permission needed to continue" (high priority) |
| Question asked | "Question — needs your answer" |

Notifications show the project folder and SSH hostname (e.g., `my-project [SSH: myserver]`) matching your VS Code window title.

## Install

**Prerequisites:** Node.js 18+, an AI coding agent with hook support (e.g., Claude Code).

```bash
npx hearkn
```

The interactive installer will:
1. Generate a unique ntfy topic
2. Configure your SSH hostname for click-to-focus
3. Install the hook into `~/.claude/hooks/`
4. Register it in `~/.claude/settings.json`
5. Send a test notification

Then install the [ntfy app](https://ntfy.sh) on your phone and subscribe to the topic shown during setup.

## Usage

Notifications are automatic after install. No changes to your workflow.

```bash
# Send a test notification
npx hearkn test

# Check installation status
npx hearkn status

# Remove hooks and config
npx hearkn uninstall
```

## How it works

Claude Code fires [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) on `Notification` and `Stop` events. This package installs a hook that:

1. Reads the JSON payload from stdin
2. Debounces (max 1 notification per 30s per session)
3. Focuses the VS Code window via `code -r .` (using the `VSCODE_IPC_HOOK_CLI` socket)
4. Sends a push notification via ntfy.sh (JSON body mode, handles unicode)
5. Writes `{}` to stdout and exits

Zero dependencies — pure Node.js built-ins only.

## Config

Config lives at `~/.claude-notify.conf` (JSON):

```json
{
  "ntfy_enabled": true,
  "ntfy_topic": "claude-myhost-a1b2c3",
  "ntfy_server": "https://ntfy.sh",
  "hostname": "myhost",
  "click_scheme": "vscode",
  "click_mode": "workspace"
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `ntfy_enabled` | `true` | Send push notifications |
| `ntfy_topic` | (generated) | Your ntfy topic — keep this hard to guess |
| `ntfy_server` | `https://ntfy.sh` | ntfy server URL (self-hosted supported) |
| `hostname` | OS hostname | SSH hostname for click-to-focus URLs |
| `click_scheme` | `vscode` | `vscode`, `vscode-insiders`, `cursor`, or `none` |
| `click_mode` | `workspace` | `workspace` (target folder), `app` (just focus), or `none` |

## Click-to-focus

Tapping a notification opens a `vscode://vscode-remote/ssh-remote+host/path` URL that focuses the correct VS Code window.

| Mode | Behavior |
|------|----------|
| `workspace` | Focuses the VS Code window matching the project folder |
| `app` | Brings VS Code to front (no folder targeting) |
| `none` | No click action (phone-only use) |

**Note:** The hook also runs `code -r .` on the server when `VSCODE_IPC_HOOK_CLI` is present, which directly focuses the correct window via IPC. This works even without ntfy.

## Security

- **ntfy topics are public by default.** Use a long, random topic name (the installer generates one). Anyone who knows your topic can see your notifications.
- For sensitive environments, use a [self-hosted ntfy server](https://docs.ntfy.sh/install/) with access control.
- Session IDs are sanitized to prevent path traversal in debounce file names.
- The hook never sends code content — only project names and short status messages.

## Development

```bash
git clone https://github.com/loganrooks/hearkn.git
cd hearkn

# Run unit tests (62 tests)
npm test

# Run integration tests (requires ntfy.sh access)
npm run test:integration

# Run all tests
npm run test:all

# Deploy to local Claude Code
cp lib/hook.js ~/.claude/hooks/claude-notify.js
```

## License

MIT
