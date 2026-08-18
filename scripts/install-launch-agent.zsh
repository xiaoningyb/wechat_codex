#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h}"
label="com.local.wecom-codex-bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
node_bin="$(command -v node)"
runtime_dir="$HOME/Library/Application Support/wecom-codex-bridge"
mkdir -p "$HOME/Library/LaunchAgents" "$project_dir/logs/audit" "$runtime_dir"
sed -e "s|__PROJECT_DIR__|$project_dir|g" \
    -e "s|__NODE_BIN__|$node_bin|g" \
    -e "s|__RUNTIME_DIR__|$runtime_dir|g" \
    "$project_dir/support/$label.plist.template" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
loaded=0
for attempt in {1..10}; do
  if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
    loaded=1
    break
  fi
  sleep 1
done
if [[ "$loaded" != "1" ]]; then
  echo "启动失败：launchctl 无法加载 $label" >&2
  exit 1
fi
launchctl enable "gui/$(id -u)/$label"
echo "已安装并启动：$label"
echo "日志：$project_dir/logs/bridge.log"
