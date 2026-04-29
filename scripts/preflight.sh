#!/usr/bin/env bash
# Validate a Symphony WORKFLOW.md and confirm GitHub Projects access without
# dispatching any agent. Exits 0 if everything looks good, non-zero otherwise.
#
# Usage:  ./scripts/preflight.sh /path/to/WORKFLOW.md

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path-to-WORKFLOW.md>" >&2
  exit 64
fi

WORKFLOW="$1"

if [ ! -f "$WORKFLOW" ]; then
  echo "preflight: workflow not found: $WORKFLOW" >&2
  exit 1
fi

if [ ! -d dist ]; then
  echo "preflight: dist/ missing — run ./scripts/setup.sh first" >&2
  exit 1
fi

exec node scripts/preflight.mjs "$WORKFLOW"
