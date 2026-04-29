#!/usr/bin/env bash
# Interactive setup wizard. See scripts/init.mjs for the actual logic.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
  echo "init: dist/ missing — run ./scripts/setup.sh first" >&2
  exit 1
fi

exec node scripts/init.mjs "$@"
