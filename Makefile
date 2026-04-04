.PHONY: build start test clean update update-opencode

build: node_modules
	npm run build

node_modules: package.json
	npm install
	@touch node_modules

start:
	node dist/index.js

test:
	npm test

clean:
	rm -rf dist

update:
	mkdir -p ~/.claude
	cp CLAUDE.md.jerboa-example ~/.claude/CLAUDE.md
	cp copilot-instructions.md.jerboa-example ~/.copilot-instructions.md
	mkdir -p ~/.claude/skills/save-discoveries
	cp .claude/skills/save-discoveries/SKILL.md ~/.claude/skills/save-discoveries/SKILL.md

OPENCODE_CONFIG := $(HOME)/.config/opencode/opencode.json
JERBOA_MCP_CMD := ["node", "$(CURDIR)/dist/index.js"]

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
	@mkdir -p ~/.config/opencode
	@cp CLAUDE.md.jerboa-example ~/.config/opencode/AGENTS.md
	@echo "Copied AGENTS.md to ~/.config/opencode/AGENTS.md"
