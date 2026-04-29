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

if [ -t 0 ] && [ -t 1 ]; then
  echo
  printf "Run the interactive setup wizard now? (y/N) "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) exec ./scripts/init.sh ;;
  esac
fi

echo
echo "Next steps (or run ./scripts/init.sh anytime for an interactive wizard):"
echo
echo "  1. Install the agent CLI you plan to use:"
echo "       claude:  npm install -g @anthropic-ai/claude-code   # then run 'claude' once to log in"
echo "       codex:   npm install -g @openai/codex               # OR: brew install --cask codex"
echo
echo "     The agent CLI is what the orchestrator spawns inside each workspace."
echo "     Install only the one matching agent.kind in your WORKFLOW.md."
echo
echo "  2. Install gh — the AGENT uses it inside the workspace to update Project"
echo "     Status, open PRs, and post comments (NOT the daemon)."
echo "       macOS:    brew install gh"
echo "       Debian:   sudo apt install gh         # see cli.github.com for older distros"
echo "       Fedora:   sudo dnf install gh"
echo "     Then authenticate once: gh auth login --scopes 'repo,project'"
echo
echo "  3. Export env vars in your shell or service unit. GITHUB_TOKEN is for the"
echo "     DAEMON — tracker auth + workspace clones — separate from gh's own auth."
echo "       export GITHUB_TOKEN=ghp_...    # PAT or App installation token"
echo "       export IRIS_TOKEN=swm_...      # only if iris.enabled in workflow"
echo "       export LOG_LEVEL=info          # or debug"
echo
echo "  4. Copy and edit the example workflow for your project:"
echo "       cp examples/WORKFLOW.example.md /path/to/your/WORKFLOW.md"
echo
echo "  5. Validate config and GitHub Projects connectivity without dispatching:"
echo "       ./scripts/preflight.sh /path/to/your/WORKFLOW.md"
echo
echo "  6. Run the daemon — add --port to enable the operator console:"
echo "       node dist/src/cli.js --workflow /path/to/your/WORKFLOW.md --port 8787"
echo "     Then visit http://127.0.0.1:8787/ for the live dashboard."
echo
echo "  Data dir for logs and raw turn captures defaults to:"
echo "       ~/.symphony/<sha256(workflow_path)[:12]>/"
echo "  Override with top-level data_dir: in WORKFLOW.md front matter."
