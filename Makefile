.PHONY: build start test clean update

build:
	npm run build

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
