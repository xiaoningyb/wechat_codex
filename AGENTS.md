# Codex handoff guide

This repository is a local-only Enterprise WeChat intelligent bot bridge for controlling the local Codex app-server on macOS.

## Read first

1. `README.md` for user-facing capability and operations.
2. `docs/ARCHITECTURE.md` for runtime components and data flow.
3. `docs/DEPLOY.md` for a clean-machine deployment path.
4. `docs/RELEASE.md` for release packaging and verification.

## Safety rules

- Never commit `config.json`, `.data/`, `logs/`, `audit/`, or any Bot Secret.
- `config.example.json` is safe to publish; real `config.json` is local-only.
- Bot Secret must be stored in macOS Keychain through `scripts/setup-keychain.zsh`.
- The service is intended for single-user local control. Do not expose the admin server beyond loopback.
- Prefer `npm run doctor`, `npm run check`, and `npm test` before changing runtime behavior.

## Common commands

```bash
npm install
cp config.example.json config.json
./scripts/setup-keychain.zsh config.json
npm run doctor
npm run check
npm test
npm start
./scripts/install-launch-agent.zsh
npm run pack:release
```

## Important implementation points

- `src/main.mjs` wires config, Keychain secret, SQLite store, audit logger, Codex app-server, admin server, and WeCom WS client.
- `src/bridge.mjs` owns message routing, slash commands, active-turn state, approvals, progress updates, and completion notifications.
- Long-running task progress updates the original stream message; system command output is sent as Enterprise WeChat markdown wrapped in a `text` fenced code block.
- `src/codex-app-server.mjs` talks to local `codex app-server` JSON-RPC and avoids spawning nested `codex exec resume` flows.
- `src/store.mjs` owns SQLite schema and durable session/turn/approval state.
- `src/admin-server.mjs` exposes local read-only audit and SQLite inspection APIs.

## Release boundary

A release archive must include source, tests, docs, scripts, templates, `package.json`, and `package-lock.json`. It must exclude local runtime state, logs, audit data, `config.json`, secrets, and `node_modules`.
