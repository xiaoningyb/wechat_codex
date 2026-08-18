# Deployment guide

## Prerequisites

- macOS.
- Node.js 22 or newer recommended because the project uses `node:sqlite`.
- Codex Desktop signed in on the same Mac.
- `codex` CLI available in `PATH`, or configure `codexCommand` to an absolute path.
- Enterprise WeChat intelligent bot `Bot ID` and `Secret`.

## Fresh install

```bash
npm install
cp config.example.json config.json
```

Edit `config.json`:

- Set `botId`.
- Set `projects[].path` to absolute local project paths.
- Set `defaultProject` to one configured project ID.
- Prefer filling `authorizedUsers` with your Enterprise WeChat userid.
- Keep `adminHost` as `127.0.0.1`.

Store the Bot Secret in macOS Keychain:

```bash
./scripts/setup-keychain.zsh config.json
```

Validate local readiness:

```bash
npm run doctor
npm run check
npm test
```

Start interactively:

```bash
npm start
```

Send `/状态` to the Enterprise WeChat bot. If it responds, send a simple read-only task.

## Persistent LaunchAgent install

```bash
./scripts/install-launch-agent.zsh
```

Verify:

```bash
launchctl print "gui/$(id -u)/com.local.wecom-codex-bridge"
tail -f logs/bridge.log
```

Open admin dashboard on the same Mac:

```text
http://127.0.0.1:17321
```

## Upgrade from release archive

1. Stop the old service:

   ```bash
   launchctl bootout "gui/$(id -u)/com.local.wecom-codex-bridge" 2>/dev/null || true
   ```

2. Extract the new archive.
3. Preserve or copy your existing `config.json`.
4. Run:

   ```bash
   npm install
   npm run doctor
   npm run check
   npm test
   ./scripts/install-launch-agent.zsh
   ```

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.local.wecom-codex-bridge" 2>/dev/null || true
rm "$HOME/Library/LaunchAgents/com.local.wecom-codex-bridge.plist"
```

Runtime data remains in:

```text
~/Library/Application Support/wecom-codex-bridge
```

Project logs remain in:

```text
logs/
```

Audit JSONL files are written under:

```text
logs/audit/
```
