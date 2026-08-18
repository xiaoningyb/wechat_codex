# Architecture

## Purpose

`wecom-codex-local-bridge` lets a single authorized Enterprise WeChat user control the local Codex app-server from a Mac. It is not a company gateway and should not be deployed as a shared multi-user service.

## Runtime components

```text
Enterprise WeChat app
  ↕ WebSocket, template cards, markdown, stream replies
@wecom/aibot-node-sdk
  ↕ events
src/bridge.mjs
  ↕ JSON-RPC
src/codex-app-server.mjs
  ↕ local child process
codex app-server
  ↕ local Codex state
Codex Desktop / local account
```

Local state:

```text
config.json                 local configuration, never publish
macOS Keychain              Bot Secret
.data/bridge.sqlite         sessions, processed messages, turns, approvals
logs/audit/*.jsonl          append-only audit stream
logs/bridge*.log            service stdout/stderr
http://127.0.0.1:17321      local read-only admin dashboard
```

## Message flow

1. Enterprise WeChat pushes an inbound event over the official intelligent bot WebSocket.
2. `Bridge.handleText` validates the user, deduplicates message IDs, parses slash commands, and routes ordinary text to Codex.
3. Ordinary text starts or steers a Codex turn through `CodexAppServer`.
4. Codex notifications append agent output, command status, file status, diffs, and completion state.
5. Long task progress updates the original stream message instead of sending repeated standalone messages.
6. System command output uses markdown with a fenced `text` block so Enterprise WeChat renders stable formatted output without unsupported HTML tags.
7. Approval requests use Enterprise WeChat template cards and route decisions back to the active Codex turn.

## Persistence model

- `owners`: first-user lock when `authorizedUsers` is empty.
- `sessions`: per WeChat conversation selected project, mode, thread, and active turn.
- `processed_messages`: inbound message deduplication.
- `thread_aliases`: numeric selections from `/选择对话`.
- `turns`: prompt, final text, lifecycle timestamps, and status.
- `approvals`: pending and resolved command/file/permission/input requests.
- `settings`: selected model and other small conversation-scoped settings.

## Security model

- The bridge only accepts single-chat control.
- Project paths must be absolute and are canonicalized with `realpath`.
- Admin HTTP server only binds loopback and rejects non-loopback configuration.
- Audit logs redact common secrets, response URLs, tokens, cookies, authorization headers, and AES keys.
- Real business text can still be sensitive; never publish audit logs.

## Deployment model

Development:

```bash
npm start
```

Persistent local service:

```bash
./scripts/install-launch-agent.zsh
```

Release archive:

```bash
npm run pack:release
```
