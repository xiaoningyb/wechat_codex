#!/bin/zsh
set -euo pipefail
config_path="${1:-./config.json}"
bot_id="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.botId)' "$config_path")"
service="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.keychain?.service||"wecom-codex-bridge")' "$config_path")"
account="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.keychain?.account||c.botId)' "$config_path")"
read -r -s "bot_secret?请输入刷新后的企业微信机器人 Secret（输入不可见）: "
echo
if [[ -z "$bot_secret" ]]; then echo "Secret 不能为空" >&2; exit 1; fi
/usr/bin/security add-generic-password -U -s "$service" -a "$account" -w "$bot_secret"
unset bot_secret
echo "已保存到 macOS 钥匙串。Bot ID: $bot_id"
