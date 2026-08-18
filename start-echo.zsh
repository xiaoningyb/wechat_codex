#!/bin/zsh

set -eu

if [[ -z "${WECOM_BOT_ID:-}" ]]; then
  read -r "WECOM_BOT_ID?Bot ID: "
fi

if [[ -z "${WECOM_BOT_SECRET:-}" ]]; then
  read -rs "WECOM_BOT_SECRET?Secret（输入时不会显示）: "
  echo
fi

if [[ -z "${WECOM_BOT_ID}" || -z "${WECOM_BOT_SECRET}" ]]; then
  echo "Bot ID 和 Secret 均不能为空。" >&2
  exit 1
fi

export WECOM_BOT_ID WECOM_BOT_SECRET
exec npm run start:echo
