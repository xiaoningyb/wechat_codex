# Release process

## Release artifact

The supported release artifact is a `.tgz` archive created by:

```bash
npm run pack:release
```

The archive includes:

- `src/`
- `scripts/`
- `support/`
- `test/`
- `docs/`
- `README.md`
- `AGENTS.md`
- `package.json`
- `package-lock.json`
- `config.example.json`
- `.gitignore`
- `.npmignore`

The archive excludes:

- `node_modules/`
- `config.json`
- `.data/`
- `logs/`
- `dist/`
- `.env*`

## Pre-release checklist

```bash
npm run doctor
npm run check
npm test
npm run pack:release
```

The pack script writes:

```text
dist/wecom-codex-local-bridge-v<version>.tgz
dist/wecom-codex-local-bridge-v<version>.tgz.sha256
```

## Verification on a clean machine

```bash
tar -xzf wecom-codex-local-bridge-v<version>.tgz
cd wecom-codex-local-bridge
npm install
cp config.example.json config.json
./scripts/setup-keychain.zsh config.json
npm run doctor
npm start
```

## Release notes template

```text
Version:
Date:

Changes:
- 

Validation:
- npm run doctor
- npm run check
- npm test

Operational notes:
- 
```
