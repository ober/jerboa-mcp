#!/usr/bin/env bash
# update-mcp.sh — Sync jerboa-mcp documentation and cookbooks with latest jerboa changes
#
# Usage:
#   ./scripts/update-mcp.sh                  # analyze NEW commits since last run
#   ./scripts/update-mcp.sh -n 10            # analyze last N commits (ignores watcher)
#   ./scripts/update-mcp.sh --all            # analyze all commits on master
#   ./scripts/update-mcp.sh --since 2026-03-01  # commits since date
#   ./scripts/update-mcp.sh -m std/errdefer  # focus on a specific module
#   ./scripts/update-mcp.sh -f lib/std/os    # focus on files under a path
#   ./scripts/update-mcp.sh --dry-run        # show the prompt but don't run claude
#   ./scripts/update-mcp.sh --model haiku    # use a cheaper model
#
# What it does:
#   1. Finds new commits in ~/mine/jerboa since the last run
#   2. Invokes Claude (with jerboa MCP tools) to analyze changes
#   3. Claude discovers new language features, APIs, and idioms
#   4. Claude saves cookbook recipes via jerboa_howto_add
#   5. Claude updates CLAUDE.md if new prelude exports aren't documented
#   6. Claude verifies existing MCP tool descriptions are still accurate
#   7. Commits cookbooks.json changes to git
#
# State is tracked in ~/.jerboa-watcher.json. After each successful run,
# the current HEAD commit is saved so the next run only processes new commits.
#
# Requires: claude CLI, git, python3
# MCP: Expects jerboa MCP server configured in ~/.claude/mcp.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

JERBOA_DIR="${JERBOA_DIR:-$HOME/mine/jerboa}"
NUM_COMMITS=""
MODULE_FOCUS=""
FILE_FOCUS=""
SINCE=""
DRY_RUN=false
MODEL="sonnet"
MAX_BUDGET=""
USE_ALL=false
WATCHER_FILE="$HOME/.jerboa-watcher.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--num-commits)
      NUM_COMMITS="$2"; shift 2 ;;
    -m|--module)
      MODULE_FOCUS="$2"; shift 2 ;;
    -f|--file-focus)
      FILE_FOCUS="$2"; shift 2 ;;
    --since)
      SINCE="$2"; shift 2 ;;
    --model)
      MODEL="$2"; shift 2 ;;
    --max-budget)
      MAX_BUDGET="$2"; shift 2 ;;
    --all)
      USE_ALL=true; shift ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,/^[^#]/p' "$0" | sed 's/^# \?//' | head -20
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$JERBOA_DIR/.git" ]]; then
  echo "Error: Jerboa repo not found at $JERBOA_DIR" >&2
  echo "Set JERBOA_DIR=/path/to/jerboa to override." >&2
  exit 1
fi

cd "$JERBOA_DIR"

git pull --ff-only 2>/dev/null || true

HEAD_COMMIT=$(git rev-parse HEAD)
HEAD_SHORT=$(git rev-parse --short HEAD)

# Read last-checked commit from watcher file
LAST_COMMIT=""
if [[ -f "$WATCHER_FILE" ]]; then
  LAST_COMMIT=$(python3 -c "
import json
try:
  d = json.load(open('$WATCHER_FILE'))
  print(d.get('last_commit', ''))
except: pass
" 2>/dev/null || true)
fi

# Determine commit range
COMMIT_RANGE=""
if [[ -n "$SINCE" ]]; then
  log_args=(--oneline --since "$SINCE")
elif [[ -n "$NUM_COMMITS" ]]; then
  log_args=(--oneline -n "$NUM_COMMITS")
elif $USE_ALL; then
  log_args=(--oneline)
elif [[ -n "$LAST_COMMIT" ]] && git cat-file -e "$LAST_COMMIT" 2>/dev/null; then
  if [[ "$LAST_COMMIT" == "$HEAD_COMMIT" ]]; then
    echo "No new commits since last run (HEAD=$HEAD_SHORT)."
    echo "Use --all or -n N to re-analyze."
    exit 0
  fi
  COMMIT_RANGE="${LAST_COMMIT}..HEAD"
  log_args=(--oneline)
  echo "=== New commits since last run (${LAST_COMMIT:0:7}..${HEAD_SHORT}) ==="
else
  log_args=(--oneline -n 15)
fi

# Show commit range
if [[ -z "$COMMIT_RANGE" ]]; then
  echo "=== Recent commits in jerboa ==="
  git log "${log_args[@]}"
else
  git log "${log_args[@]}" "$COMMIT_RANGE"
fi
echo ""

# Show changed source files
DIFF_RANGE="${COMMIT_RANGE:-HEAD~15..HEAD}"
if $USE_ALL; then
  DIFF_RANGE="HEAD~100..HEAD"
fi

diff_path_args=()
if [[ -n "$FILE_FOCUS" ]]; then
  diff_path_args=("--" "$FILE_FOCUS")
fi

echo "=== Changed source files [$DIFF_RANGE] ==="
git diff --stat "$DIFF_RANGE" \
  -- 'lib/std/*.ss' 'lib/std/**/*.ss' \
     'lib/jerboa/*.ss' 'lib/jerboa/**/*.ss' \
     'lib/std/*.sls' 'lib/std/**/*.sls' \
     'lib/jerboa/*.sls' 'lib/jerboa/**/*.sls' \
  "${diff_path_args[@]}" 2>/dev/null | tail -25 || true
echo ""

# Build focus clauses
module_clause=""
if [[ -n "$MODULE_FOCUS" ]]; then
  module_clause="
FOCUS MODULE: $MODULE_FOCUS
Pay special attention to this module. Check its exports, signatures, and any API changes."
fi

file_clause=""
if [[ -n "$FILE_FOCUS" ]]; then
  file_clause="
FOCUS PATH: $FILE_FOCUS
Concentrate on files under this path. Read the changed files and understand what's new."
fi

prompt="$(cat <<PROMPT_EOF
You are syncing the jerboa-mcp documentation and cookbook with recent changes to the Jerboa Scheme language.

JERBOA REPO: $JERBOA_DIR
MCP REPO: $MCP_REPO_DIR
DIFF RANGE: $DIFF_RANGE
${module_clause}${file_clause}

## Your Task

Work through these steps in order:

### Step 1 — Understand what changed in Jerboa

Examine recent git diffs for source files in lib/std/ and lib/jerboa/. Focus on:
- New modules or files added (new .ss or .sls files)
- New functions, macros, or syntax forms exported from existing modules
- Changed function signatures (renamed, new parameters, removed)
- New prelude exports (changes to lib/jerboa/prelude.sls)
- New language features (new special forms, reader extensions, etc.)
- Deprecated or removed APIs

Useful git commands (run via Bash):
  git -C $JERBOA_DIR diff $DIFF_RANGE -- lib/std/MODULE.sls
  git -C $JERBOA_DIR diff $DIFF_RANGE --name-only -- 'lib/std/' 'lib/jerboa/'
  git -C $JERBOA_DIR log --oneline $DIFF_RANGE -- lib/std/MODULE.sls

### Step 2 — Verify with live MCP tools

For each interesting change found in Step 1:
- Use jerboa_module_exports to confirm current exports (format: "(std module-name)")
- Use jerboa_function_signature to check arities and optional args
- Use jerboa_eval to test examples interactively — use the imports parameter
- Use jerboa_check_syntax to verify code examples are syntactically valid
- Use jerboa_class_info for new struct/class types

### Step 3 — Update CLAUDE.md if prelude changed

Read $MCP_REPO_DIR/CLAUDE.md (the global user instructions file, NOT the project CLAUDE.md).
The global one is at /home/jafourni/.claude/CLAUDE.md.

If you found new prelude exports or language features that aren't documented there:
- Add them to the appropriate section
- Use correct Jerboa syntax (not Gerbil/Racket)
- Include working code examples
- Note any gotchas (wrong arity assumptions, naming conflicts with other Schemes)

Focus on the "## The Jerboa Language — Quick Reference" section.

### Step 4 — Check for hallucinated functions to alias

The prelude has an "AI Compatibility Aliases" section for common LLM hallucinations.
If you found new aliases added to the prelude (e.g., Racket/Gambit/Gerbil names that
now work), add them to the "AI Compatibility Aliases" section in CLAUDE.md and move
them out of the "Hallucinated Functions" section if they're no longer wrong.

### Step 5 — Check existing cookbook for stale recipes

Use jerboa_howto to search for recipes related to changed modules. If an API changed:
- Verify the recipe still works with jerboa_eval
- If broken, save a corrected version via jerboa_howto_add (same id = update)
- If deprecated, note that in the recipe's notes field

### Step 6 — Save new cookbook recipes

For each new non-trivial pattern you discovered, check jerboa_howto first to
avoid duplicates, then save via jerboa_howto_add:
- id: kebab-case, descriptive (e.g., "errdefer-cleanup-on-error")
- tags: 4-6 keywords including module name (e.g., ["errdefer", "cleanup", "error-handling"])
- imports: all required imports (usually just ["(jerboa prelude)"] if in prelude)
- code: complete working example
- notes: gotchas, alternatives, what's different from Gerbil/Racket

### Step 7 — Verify MCP tool descriptions are accurate

Read a sample of tool source files in $MCP_REPO_DIR/src/tools/ for modules you
examined. Check if the tool descriptions mention APIs that no longer exist or miss
important new APIs. Report any inaccuracies (you don't need to fix them, just report).

Also verify the tool count in $MCP_REPO_DIR/CLAUDE.md is still accurate.

### Step 8 — Report

At the end, provide a summary:
- New modules/features discovered
- Prelude changes found
- CLAUDE.md sections updated (if any)
- Cookbook recipes added or updated
- Stale recipes fixed
- MCP tool inaccuracies found (file:line references)
- Things that need manual follow-up

## Important Guidelines

- This is Jerboa Scheme, NOT Gerbil. Jerboa runs on Chez Scheme. Different APIs.
- Module paths use (std ...) form: (std sort), (std text json), (std misc string)
- The prelude lives at $JERBOA_DIR/lib/jerboa/prelude.sls
- NEVER modify files under $JERBOA_DIR — read-only source of truth
- ONLY modify files under $MCP_REPO_DIR (CLAUDE.md is at /home/jafourni/.claude/CLAUDE.md)
- Skip trivial changes (whitespace, comments, internal implementation details)
- Focus on user-facing API changes
- When in doubt about an API, test with jerboa_eval before documenting it
PROMPT_EOF
)"

if $DRY_RUN; then
  echo "=== PROMPT (dry run) ==="
  echo "$prompt"
  echo ""
  echo "=== Watcher state ==="
  echo "HEAD: $HEAD_COMMIT"
  echo "Last: ${LAST_COMMIT:-<none>}"
  echo "File: $WATCHER_FILE"
  exit 0
fi

echo "=== Running claude -p (model: $MODEL) ==="

claude_args=(
  -p "$prompt"
  --model "$MODEL"
  --verbose
  --output-format stream-json
  --allowedTools "Bash(git:*),Read,Glob,Grep,Edit,mcp__jerboa__*"
)
if [[ -n "$MAX_BUDGET" ]]; then
  claude_args+=(--max-budget-usd "$MAX_BUDGET")
fi

# Save watcher state after successful run
update_watcher() {
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  python3 -c "
import json, os
path = '$WATCHER_FILE'
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except: pass
data['last_commit'] = '$HEAD_COMMIT'
data['last_run'] = '$timestamp'
data['jerboa_dir'] = '$JERBOA_DIR'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
  echo ""
  echo "=== Watcher updated ==="
  echo "Saved HEAD=$HEAD_SHORT to $WATCHER_FILE"
}

# Commit cookbooks.json if changed
commit_cookbooks() {
  local cookbook="$MCP_REPO_DIR/cookbooks.json"
  if [[ ! -f "$cookbook" ]]; then
    return
  fi
  if git -C "$MCP_REPO_DIR" diff --quiet -- cookbooks.json && \
     git -C "$MCP_REPO_DIR" diff --cached --quiet -- cookbooks.json; then
    echo "=== cookbooks.json unchanged — nothing to commit ==="
    return
  fi
  echo "=== Committing cookbooks.json ==="
  git -C "$MCP_REPO_DIR" add cookbooks.json
  git -C "$MCP_REPO_DIR" commit -m "Update cookbooks.json from jerboa changes (${HEAD_SHORT})"
  echo "=== cookbooks.json committed ==="
}

# Stream output with progress display
set +o pipefail
claude "${claude_args[@]}" | while IFS= read -r line; do
  type=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('type',''))" 2>/dev/null || true)
  case "$type" in
    assistant)
      text=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for c in d.get('message',{}).get('content',[]):
  if c.get('type')=='text': print(c['text'])
" 2>/dev/null || true)
      if [[ -n "$text" ]]; then
        echo "$text"
      fi
      ;;
    tool_use)
      tool=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool',''))" 2>/dev/null || true)
      input_preview=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
inp=d.get('input',{})
parts=[]
for k,v in list(inp.items())[:3]:
  s=str(v)
  if len(s)>60: s=s[:60]+'...'
  parts.append(f'{k}={s}')
print(', '.join(parts))
" 2>/dev/null || true)
      echo "  >> [tool] $tool($input_preview)"
      ;;
    tool_result)
      content=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d.get('content','')
if isinstance(t,list):
  t=' '.join(c.get('text','') for c in t if isinstance(c,dict))
t=str(t).strip()
if len(t)>120: t=t[:120]+'...'
print(t)
" 2>/dev/null || true)
      is_error=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('is_error','false'))" 2>/dev/null || true)
      if [[ "$is_error" == "true" || "$is_error" == "True" ]]; then
        echo "  << [result] ERROR: $content"
      else
        echo "  << [result] $content"
      fi
      ;;
    result)
      text=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',''))" 2>/dev/null || true)
      if [[ -n "$text" ]]; then
        echo ""
        echo "=== Final Result ==="
        echo "$text"
      fi
      cost=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
c=d.get('cost_usd')
if c: print(f'Cost: \${c:.4f}')
" 2>/dev/null || true)
      if [[ -n "$cost" ]]; then
        echo "$cost"
      fi
      ;;
  esac
done
claude_exit=${PIPESTATUS[0]}
set -o pipefail

if [[ $claude_exit -eq 0 ]]; then
  update_watcher
  commit_cookbooks
else
  echo ""
  echo "=== claude exited with error (code $claude_exit) — watcher NOT updated ==="
fi
