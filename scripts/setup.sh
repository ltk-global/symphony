#!/usr/bin/env bash
# Symphony first-time setup. Idempotent — safe to re-run.
#
# Validates host, installs deps, builds dist/. Does NOT install agent CLIs
# (claude/codex) or set env vars; those are operator concerns.

set -euo pipefail

cd "$(dirname "$0")/.."

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }

bold "==> Checking host"

if ! command -v node >/dev/null 2>&1; then
  red "node is not on PATH. Install Node 22+ (e.g. 'nvm install 22')."
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  red "Node 22+ required; have $(node -v)."
  exit 1
fi
green "node $(node -v)"

if ! command -v git >/dev/null 2>&1; then
  red "git is not on PATH. Install git (workspace hooks need it)."
  exit 1
fi
green "git $(git --version | awk '{print $3}')"

bold "==> Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

bold "==> Building"
npm run build

bold "==> Done"
green "Build OK. Bin: ./node_modules/.bin/symphony (or 'node dist/src/cli.js')."
echo
echo "Next steps:"
echo
echo "  1. Install the agent CLI you plan to use:"
echo "       claude:  npm install -g @anthropic-ai/claude-code"
echo "       codex:   (whatever installer your codex distribution uses)"
echo
echo "  2. Install gh and authenticate (the agent uses it inside the workspace):"
echo "       brew install gh && gh auth login --scopes 'repo,project,read:project'"
echo
echo "  3. Export env vars in your shell or a service unit:"
echo "       export GITHUB_TOKEN=ghp_..."
echo "       export IRIS_TOKEN=swm_...   # only if iris.enabled in workflow"
echo "       export LOG_LEVEL=info       # or debug"
echo
echo "  4. Copy and edit the example workflow for your project:"
echo "       cp examples/WORKFLOW.example.md /path/to/your/WORKFLOW.md"
echo
echo "  5. Validate config and connectivity without dispatching anything:"
echo "       ./scripts/preflight.sh /path/to/your/WORKFLOW.md"
echo
echo "  6. Run the daemon:"
echo "       node dist/src/cli.js --workflow /path/to/your/WORKFLOW.md"
