# CLAUDE.md — jerboa-mcp Developer Guide

## Project Overview

`jerboa-mcp` is an MCP (Model Context Protocol) server that provides live
Jerboa Scheme language intelligence to AI coding assistants. It exposes 99
tools covering evaluation, syntax checking, compilation, module introspection,
pattern analysis, code generation, testing, benchmarking, and more.

Jerboa is a Scheme dialect built on Chez Scheme. The MCP server runs Chez
Scheme in subprocesses to execute real Jerboa code, introspect modules, and
provide accurate, live answers rather than relying on static knowledge.

---

## Build and Test Commands

```bash
# Compile TypeScript to dist/
npm run build

# Run tests (vitest)
npm test

# Watch mode (recompile on save, no resource copy)
npm run dev

# Copy resources only
npm run copy-resources

# Start the server
npm start
```

**Always run `npm run build` after any change to `.ts` files** before testing
or submitting. The build step also copies `src/resources/` to `dist/resources/`
via the `copy-resources` script.

---

## Project Structure

```
jerboa-mcp/
├── src/
│   ├── index.ts          — Main server entry point; registers all tools
│   ├── chez.ts           — Chez Scheme subprocess layer (runChez, build*)
│   ├── tools/            — 99 individual tool implementations
│   │   ├── eval.ts
│   │   ├── check-syntax.ts
│   │   ├── module-exports.ts
│   │   └── ... (one file per tool)
│   └── resources/        — Static reference docs served as MCP resources
│       ├── jerboa-idioms.md
│       ├── jerboa-chez-interop.md
│       ├── jerboa-pattern-matching.md
│       └── jerboa-stdlib-map.md
├── dist/                 — Compiled output (generated, do not edit)
├── cookbooks.json        — Cookbook recipes (persisted by jerboa_howto_add)
├── error-fixes.json      — Error fix database (jerboa_error_fix_add)
├── security-rules.json   — Custom security patterns (jerboa_security_pattern_add)
├── features.json         — Feature suggestions (jerboa_suggest_feature)
├── package.json
└── tsconfig.json
```

### `src/index.ts`

- Instantiates the `McpServer` with name, version, and the `INSTRUCTIONS`
  string.
- Imports and calls each tool's `registerXxxTool(server)` function.
- Connects via `StdioServerTransport`.

### `src/chez.ts`

Core subprocess and script-building utilities. Import from here in all tools.

### `src/tools/`

Each file exports exactly one `registerXxxTool(server: McpServer): void`
function. Tools call `server.tool(name, description, schema, handler)`.

---

## Adding a New Tool

Follow this checklist to add a new tool without breaking anything:

1. **Create `src/tools/tool-name.ts`**

   ```typescript
   import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
   import { z } from 'zod';
   import { runChez, buildEvalScript } from '../chez.js';

   export function registerToolNameTool(server: McpServer): void {
     server.tool(
       'jerboa_tool_name',
       'Short description of what this tool does.',
       {
         // zod schema for parameters
         expression: z.string().describe('The expression to evaluate'),
         imports: z.array(z.string()).optional()
           .describe('Additional modules to import'),
       },
       async ({ expression, imports }) => {
         const script = buildEvalScript(expression, imports);
         const result = await runChez(script);
         return {
           content: [{
             type: 'text',
             text: result.exitCode === 0 ? result.stdout : result.stderr,
           }],
         };
       }
     );
   }
   ```

2. **Import and register in `src/index.ts`**

   Add to the import block (maintain alphabetical order within groups):
   ```typescript
   import { registerToolNameTool } from './tools/tool-name.js';
   ```

   Add to the registration section:
   ```typescript
   registerToolNameTool(server);
   ```

3. **Update the `INSTRUCTIONS` string in `src/index.ts`**

   Find the relevant section group in the large `INSTRUCTIONS` constant and
   add a bullet describing the new tool and when to use it. This text is shown
   to the AI as the system prompt.

4. **Run `npm run build` to verify compilation.**

5. **Add a test** if the tool has non-trivial logic. Place it alongside the
   tool file or in the `tests/` directory.

---

## Key Patterns in `src/chez.ts`

### `runChez(code, options?)`

Runs a Chez Scheme script in a subprocess. Returns `ChezResult`:
- `stdout` — captured standard output
- `stderr` — captured standard error
- `exitCode` — 0 on success
- `timedOut` — true if the timeout was exceeded

```typescript
const result = await runChez(script, {
  timeout: 10_000,     // ms (default: 30_000)
  jerboaHome: '/path', // override JERBOA_HOME
  env: { LD_LIBRARY_PATH: '/usr/local/lib' },
});
```

### `buildPreamble(imports?)`

Generates a Chez/Jerboa import block. Always includes `(jerboa prelude)` plus
any additional modules specified:

```typescript
const preamble = buildPreamble(['(std text json)', '(std db sqlite)']);
// => "(import (jerboa prelude) (std text json) (std db sqlite))\n"
```

### `buildEvalScript(expr, imports?)`

Wraps an expression for evaluation with output capture. Handles quoting and
ensures the result is printed to stdout:

```typescript
const script = buildEvalScript('(+ 1 2)', ['(std sort)']);
```

### `buildSyntaxCheckScript(code, imports?)`

Generates a script that syntax-checks `code` without executing it. Returns a
boolean-style result suitable for the check-syntax tool.

### `escapeSchemeString(s)`

Escapes a string so it is safe to embed inside a Chez `string` literal. Handles
backslash, double-quote, and control characters:

```typescript
const safe = escapeSchemeString(userInput);
const script = `(display "${safe}")`;
```

### `buildEvalWrapper(expression)`

Lower-level wrapper used by `buildEvalScript`. Wraps an already-preambled
expression in a `with-exception-handler` that catches and formats errors.

---

## Data Files

These JSON files are read at server startup and mutated by tool handlers. Do
not edit them by hand unless fixing corruption; use the corresponding tools.

| File                  | Purpose                          | Write tool                  |
|-----------------------|----------------------------------|-----------------------------|
| `cookbooks.json`      | Cookbook recipes                 | `jerboa_howto_add`          |
| `error-fixes.json`    | Error message → fix mappings     | `jerboa_error_fix_add`      |
| `security-rules.json` | Custom security scan patterns    | `jerboa_security_pattern_add` |
| `features.json`       | Feature suggestions and votes    | `jerboa_suggest_feature`, `jerboa_vote_feature` |

Format for `cookbooks.json`:
```json
{
  "id": "kebab-case-id",
  "title": "Human-readable title",
  "tags": ["module-name", "task", "alternative-phrasing"],
  "imports": ["(jerboa prelude)", "(std text json)"],
  "code": "(def result ...)",
  "notes": "Gotchas or caveats",
  "related": ["other-recipe-id"]
}
```

---

## Mandatory Development Rules

1. **Run `npm run build` after every `.ts` change.** TypeScript errors must be
   resolved before moving on. Do not rely on `dev` watch mode for final
   verification.

2. **Verify Chez scripts with `jerboa_eval` before implementing.** When writing
   a new tool that runs Chez code, test the script interactively using the MCP
   server itself to confirm it produces the expected output and handles errors
   gracefully.

3. **Add cookbook recipes when discovering Jerboa patterns.** If you find the
   correct import, arity, or API convention for a non-obvious Jerboa pattern,
   save it via `jerboa_howto_add` so it is available in future sessions.

4. **Run the security scanner on any FFI code.** Before finalizing any tool
   that involves `foreign-procedure`, shell commands, or raw file I/O, run
   `jerboa_security_scan` on the tool file.

5. **Keep the tool count accurate.** The README and INSTRUCTIONS string mention
   the total tool count. Update them when adding tools. As of this writing
   there are **117 tools** registered.

---

## Tool Count

Currently **117 tools** are registered in `src/index.ts`. The tool names follow
the prefix `jerboa_`.

Tools are grouped in `src/index.ts` registrations by category:
- Core evaluation (eval, check-syntax, compile-check, batch-syntax-check)
- Module introspection (module-exports, function-signature, class-info, ...)
- Build and test (build-project, run-tests, benchmark, ...)
- Code quality (lint, dead-code, check-arity, ...)
- Navigation (find-definition, find-callers, document-symbols, ...)
- Refactoring (rename-symbol, balanced-replace, wrap-form, splice-form, ...)
- Cookbook and recipes (howto, howto-add, howto-get, howto-run, ...)
- Security (security-scan, security-pattern-add, ...)
- FFI tools (ffi-inspect, ffi-scaffold, ffi-type-check, ...)
- Project tools (project-info, project-map, project-health-check, ...)
