#!/bin/zsh
set -eu
cd -- "${0:A:h}"
quota_node="$(command -v node || true)"
if [[ -z "$quota_node" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then quota_node="$candidate"; break; fi
  done
fi
if [[ -z "$quota_node" ]]; then print '请先安装 Node.js 22.13 或更高版本。'; exit 1; fi
exec "$quota_node" plugins/codex-quota-monitor/server/launcher.mjs
