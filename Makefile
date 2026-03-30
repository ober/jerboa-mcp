.PHONY: build start test clean update

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
