.PHONY: build start test clean

build:
	npm run build

start:
	node dist/index.js

test:
	npm test

clean:
	rm -rf dist
