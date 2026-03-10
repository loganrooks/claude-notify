# TODO

## Before v0.2.0

- [ ] Test `npx hearkn` install flow end-to-end on a clean machine
- [ ] Uninstaller: verify it cleanly removes hooks without breaking other hooks

## Design decisions needed

- [ ] Different notification types per event (permission vs idle vs stop)
- [ ] Actionable notifications (respond from phone for AskUserQuestion)
- [ ] Importance levels / categories
- [ ] Multi-session handling from different VS Code windows

## Nice-to-have

- [ ] Self-hosted ntfy support (non-HTTPS servers, auth tokens)
- [ ] Rate limiting beyond debounce (e.g., max N notifications per hour)
- [ ] Notification sound/vibration config via ntfy priority levels
- [ ] Other notification backends (Pushover, Slack webhook, desktop-notify)
- [ ] Detect Cursor vs VS Code automatically from TERM_PROGRAM / env vars
- [ ] `npx hearkn update` — update hook without re-running full installer
- [ ] `install.sh` curl-based alternative installer for non-npm users

## Done

- [x] README.md with install instructions, usage, config reference
- [x] Installer: detect if Claude Code is installed
- [x] Installer: validate ntfy topic is reachable
- [x] GitHub repo creation + first push
- [x] GitHub Actions CI (Node 18/20/22, Ubuntu + macOS)
- [x] Handle stale VSCODE_IPC_HOOK_CLI sockets (catch error silently)
- [x] Remove workspace_root from config/code (use cwd directly)
- [x] Switch ntfy from HTTP headers to JSON body mode (fixes unicode)
- [x] TDD test suite (62 unit, 9 integration, 9 E2E)
