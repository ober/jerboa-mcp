.PHONY: build start test clean update update-opencode update-claude update-codex \
        regen-api regen-strict-prelude regen-docs regen-changelog regen-all

build: node_modules
	npm run build

## Regeneration targets -------------------------------------------------------
## Usage: make regen-all JERBOA_ROOT=/path/to/jerboa
JERBOA_ROOT ?= $(HOME)/mine/jerboa

regen-api:
	python3 scripts/extract-api.py --root $(JERBOA_ROOT) --out api-signatures.json

regen-strict-prelude:
	python3 scripts/gen-strict-prelude.py \
		--api api-signatures.json \
		--divergence divergence.json \
		--out $(JERBOA_ROOT)/lib/jerboa/prelude/strict.sls

regen-docs:
	python3 scripts/gen-divergence-md.py --json divergence.json \
		--out $(JERBOA_ROOT)/docs/divergence.md
	python3 scripts/gen-api-index.py --api api-signatures.json \
		--out $(JERBOA_ROOT)/docs/api-index.md

## Diff api-signatures.json against its previous git revision and append
## a changelog entry. Expects a clean working tree under git.
regen-changelog:
	git show HEAD:api-signatures.json > /tmp/jerboa-api-prev.json
	python3 scripts/diff-api-signatures.py \
		--old /tmp/jerboa-api-prev.json \
		--new api-signatures.json \
		--append-to changelog.json

regen-all: regen-api regen-strict-prelude regen-docs
	@echo "All generated artifacts refreshed."

node_modules: package.json
	npm install
	@touch node_modules

start:
	node dist/index.js

test:
	npm test

clean:
	rm -rf dist

update: update-opencode update-claude update-codex
	cp CLAUDE.md.jerboa-example AGENTS.md
	cp copilot-instructions.md.jerboa-example ~/.copilot-instructions.md
	mkdir -p ~/.claude/skills/save-discoveries
	cp .claude/skills/save-discoveries/SKILL.md ~/.claude/skills/save-discoveries/SKILL.md

CLAUDE_CONFIG := $(HOME)/.claude/settings.json
OPENCODE_CONFIG := $(HOME)/.config/opencode/opencode.json
JERBOA_MCP_CMD := ["node", "$(CURDIR)/dist/index.js"]
CODEX_MCP_NAME := jerboa

update-claude:
	@mkdir -p ~/.claude
	@if [ -f "$(CLAUDE_CONFIG)" ]; then \
		if ! jq empty "$(CLAUDE_CONFIG)" 2>/dev/null; then \
			echo "ERROR: $(CLAUDE_CONFIG) is not valid JSON. Fix it first."; \
			exit 1; \
		fi; \
		if jq -e '.mcpServers.jerboa' "$(CLAUDE_CONFIG)" >/dev/null 2>&1; then \
			echo "jerboa MCP entry already present in $(CLAUDE_CONFIG), skipping."; \
		else \
			jq '.mcpServers = (.mcpServers // {}) | .mcpServers.jerboa = {"command": "node", "args": ["$(CURDIR)/dist/index.js"]}' \
				"$(CLAUDE_CONFIG)" > "$(CLAUDE_CONFIG).tmp" && \
				mv "$(CLAUDE_CONFIG).tmp" "$(CLAUDE_CONFIG)"; \
			echo "Added jerboa MCP entry to $(CLAUDE_CONFIG)"; \
		fi; \
	else \
		jq -n '{"mcpServers": {"jerboa": {"command": "node", "args": ["$(CURDIR)/dist/index.js"]}}}' \
			> "$(CLAUDE_CONFIG)"; \
		echo "Created $(CLAUDE_CONFIG) with jerboa MCP entry"; \
	fi

update-opencode:
	@mkdir -p ~/.config/opencode
	@if [ -f "$(OPENCODE_CONFIG)" ]; then \
		if ! jq empty "$(OPENCODE_CONFIG)" 2>/dev/null; then \
			echo "ERROR: $(OPENCODE_CONFIG) is not valid JSON. Fix it first."; \
			exit 1; \
		fi; \
		if jq -e '.mcp.jerboa' "$(OPENCODE_CONFIG)" >/dev/null 2>&1; then \
			echo "jerboa MCP entry already present in $(OPENCODE_CONFIG), skipping."; \
		else \
			jq --argjson cmd '$(JERBOA_MCP_CMD)' \
				'.mcp = (.mcp // {}) | .mcp.jerboa = {"type": "local", "command": $$cmd}' \
				"$(OPENCODE_CONFIG)" > "$(OPENCODE_CONFIG).tmp" && \
				mv "$(OPENCODE_CONFIG).tmp" "$(OPENCODE_CONFIG)"; \
			echo "Added jerboa MCP entry to $(OPENCODE_CONFIG)"; \
		fi; \
	else \
		jq -n --argjson cmd '$(JERBOA_MCP_CMD)' \
			'{"mcp": {"jerboa": {"type": "local", "command": $$cmd}}}' \
			> "$(OPENCODE_CONFIG)"; \
		echo "Created $(OPENCODE_CONFIG) with jerboa MCP entry"; \
	fi
	@echo ""
	@echo "NOTE: To use the Jerboa AGENTS.md in a project, copy it there:"
	@echo "  cp $(CURDIR)/CLAUDE.md.jerboa-example /path/to/project/AGENTS.md"
	@echo ""
	@echo "Installing to jerboa-mcp project directory..."
	@cp CLAUDE.md.jerboa-example AGENTS.md
	@echo "Copied AGENTS.md to $(CURDIR)/AGENTS.md"

update-codex:
	@if ! command -v codex >/dev/null 2>&1; then \
		echo "WARNING: codex CLI not found; skipping Codex MCP configuration."; \
	elif codex mcp get "$(CODEX_MCP_NAME)" >/dev/null 2>&1; then \
		echo "jerboa MCP entry already present in Codex config, skipping."; \
	else \
		codex mcp add "$(CODEX_MCP_NAME)" -- node "$(CURDIR)/dist/index.js"; \
		echo "Added jerboa MCP entry to Codex config"; \
	fi
