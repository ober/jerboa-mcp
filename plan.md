# jerboa-mcp Implementation Plan

A comprehensive MCP (Model Context Protocol) server providing Jerboa language intelligence — mirroring gerbil-mcp's 150-tool architecture, adapted for Jerboa's Chez-native runtime.

## Table of Contents

1. [Background & Context](#1-background--context)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Setup](#3-project-setup)
4. [Chez Subprocess Layer](#4-chez-subprocess-layer)
5. [Tool Implementation Phases](#5-tool-implementation-phases)
6. [Data Files & Knowledge Base](#6-data-files--knowledge-base)
7. [Resource & Prompt Templates](#7-resource--prompt-templates)
8. [INSTRUCTIONS String](#8-instructions-string)
9. [Testing Strategy](#9-testing-strategy)
10. [CLAUDE.md & Documentation](#10-claudemd--documentation)
11. [Key Differences from gerbil-mcp](#11-key-differences-from-gerbil-mcp)
12. [Implementation Order & Dependencies](#12-implementation-order--dependencies)

---

## 1. Background & Context

### What is Jerboa?

Jerboa is Gerbil Scheme's syntax and APIs, running on **stock Chez Scheme** (no fork, no patches). It reimplements Gerbil's user-facing language as Chez macros (~500 lines) and native R6RS libraries (~5200 lines total).

**Key properties:**
- ~95% Gerbil source compatibility
- 953+ tests passing (289 core + 637 features + 27 wrappers)
- 51 core modules in `:std/*` namespace
- Native Chez record speed (no MOP overhead)
- Real SMP threads (Chez native)
- FFI via `c-lambda` → `foreign-procedure` macro expansion
- Module system: reader maps `:std/sort` → `(std sort)`, Chez handles rest

**Invocation:**
```bash
scheme --libdirs lib --script your-file.ss
```

**Architecture layers:**
1. Reader: `[...]` = plain parens (like Gerbil/Chez), `{method obj}` → `(~ obj method)`, `:std/sort` → `(std sort)`
2. Core macros: `def`, `defstruct`, `match`, `try/catch` → standard Chez
3. Runtime: hash tables, method dispatch, keywords
4. Standard library: sort, JSON, paths, strings, crypto, net, db, etc.
5. FFI: `c-lambda` → `foreign-procedure`

**Existing projects built on Jerboa:**
- `jerboa-shell` (POSIX shell, 90% Oils compat, 1056/1179 tests)
- `jerboa-emacs` (terminal editor, early stage)
- `jerboa-es-proxy` (Elasticsearch proxy, early stage)

### What is gerbil-mcp?

The reference implementation we're mirroring: a TypeScript MCP server with **150 tools**, **758 cookbook recipes**, **42 security rules**, **16 feature suggestions**, extensive prompts and resources. It wraps Gambit-based `gxi`/`gxc` subprocesses.

### Why jerboa-mcp?

Jerboa is niche — LLMs have minimal training data on it. jerboa-mcp provides live verification tools so AI assistants can check their assumptions against the real Jerboa runtime rather than guessing.

---

## 2. Architecture Overview

```
jerboa-mcp/
├── src/
│   ├── index.ts              # MCP server entry, tool/prompt/resource registration
│   ├── chez.ts               # Chez Scheme subprocess management (core)
│   ├── prompts.ts            # MCP prompt templates
│   ├── resources.ts          # MCP resource templates (cookbooks, reference docs)
│   └── tools/                # One file per tool (~150 files)
│       ├── eval.ts
│       ├── check-syntax.ts
│       ├── ...
│       ├── parse-utils.ts    # Shared parsing helpers
│       ├── scheme-scanner.ts # Lexical analysis (pure TS)
│       └── verify-utils.ts   # Shared verification logic
├── test/
│   └── tools.test.ts         # Integration tests (spawn real MCP server)
├── scripts/
│   └── test-cookbooks.ts     # Cross-version cookbook tester CLI
├── .claude/
│   └── skills/
│       └── save-discoveries/ # Skill for saving recipes/features/patterns
├── cookbooks.json            # Curated Jerboa recipes
├── error-fixes.json          # Error→fix mappings
├── features.json             # Feature suggestions
├── security-rules.json       # Vulnerability detection patterns
├── CLAUDE.md                 # Development guide
├── CLAUDE.md.jerboa-example  # Template for users' projects
├── package.json
├── tsconfig.json
└── Makefile
```

---

## 3. Project Setup

### 3.1 package.json

```json
{
  "name": "jerboa-mcp",
  "version": "1.0.0",
  "description": "MCP server providing Jerboa (Gerbil-on-Chez) language intelligence",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "copy-resources": "cp -r src/resources dist/resources",
    "build": "tsc && npm run copy-resources",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.18"
  }
}
```

### 3.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### 3.3 Makefile

```makefile
.PHONY: build test install clean

build:
	npm run build

test:
	npm run test

install:
	npm install

clean:
	rm -rf dist node_modules
```

### 3.4 .gitignore

```
node_modules/
dist/
*.js.map
```

---

## 4. Chez Subprocess Layer

### 4.1 `src/chez.ts` — Core subprocess wrapper

This is the **most critical file** — every tool depends on it. Model it on gherkin-mcp's `chez.ts` but adapted for Jerboa's simpler import model.

#### Key differences from gerbil-mcp's `gxi.ts`:

| gerbil-mcp (gxi.ts) | jerboa-mcp (chez.ts) |
|---------------------|---------------------|
| Invokes `gxi`, `gxc`, `gxpkg`, `gerbil` binaries | Invokes only `scheme` (stock Chez) |
| `GERBIL_HOME`, `GERBIL_PATH`, `GERBIL_LOADPATH` | `JERBOA_HOME` (path to jerboa repo), plus `--libdirs` |
| Complex preamble with Gambit compat | Simple: `(import (jerboa prelude))` or targeted imports |
| `with-catch` + `display-exception` for errors | `guard` + `display-condition` |
| `hash-table?` / `hash-length` (Gambit) | `hashtable?` / `hashtable-size` (Chez) for internal introspection |
| `gxc -S` for compile checking | `(compile-file ...)` or `(expand ...)` in Chez |

#### Required exports:

```typescript
// Types
export interface ChezResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ChezOptions {
  timeout?: number;       // Default 30s
  env?: Record<string, string>;  // Extra env vars (LD_LIBRARY_PATH, etc.)
  libdirs?: string[];     // Extra --libdirs paths
}

// Markers for output parsing
export const RESULT_MARKER = 'JERBOA-MCP-RESULT:';
export const ERROR_MARKER = 'JERBOA-MCP-ERROR:';
export const STDOUT_MARKER = 'JERBOA-MCP-STDOUT:';
export const VALID_MARKER = 'JERBOA-MCP-VALID';

// Binary resolution
export async function findChez(): Promise<string>;

// Jerboa home resolution
export function getJerboaHome(): string;  // from JERBOA_HOME env var

// Preamble builder
export function buildJerboaPreamble(imports?: string[]): string;

// Core execution functions
export async function runChez(code: string, options?: ChezOptions): Promise<ChezResult>;
export async function runChezFile(filePath: string, options?: ChezOptions): Promise<ChezResult>;
export async function runChezScript(expressions: string[], options?: ChezOptions): Promise<ChezResult>;

// Utility
export function escapeSchemeString(s: string): string;
export function buildLibdirsArg(extraDirs?: string[]): string;
```

#### Implementation details:

**Chez binary discovery:**
1. `process.env.JERBOA_MCP_CHEZ_PATH`
2. `/usr/bin/scheme`
3. `scheme` (via PATH)

**JERBOA_HOME:** Points to the jerboa repo root (contains `lib/` with `jerboa/` and `std/` subdirs).

**Standard invocation pattern:**
```bash
scheme --libdirs /path/to/jerboa/lib --script /tmp/jerboa-mcp-XXXX.ss
```

For REPL sessions:
```bash
scheme --libdirs /path/to/jerboa/lib -q
```

**Preamble template:**
```scheme
#!chezscheme
(import (jerboa prelude))
```

Or for targeted imports (when tools need specific modules):
```scheme
#!chezscheme
(import
  (except (chezscheme)
    make-hash-table hash-table?
    iota last-pair 1+ 1-
    error error? raise with-exception-handler identifier?)
  (jerboa core)
  (jerboa runtime)
  ;; ... specific std modules as needed
)
```

**Output capture pattern:**
```scheme
(guard (exn [#t (display "JERBOA-MCP-ERROR:")
                (display-condition exn)
                (newline)])
  (let ([result (begin YOUR-CODE-HERE)])
    (display "JERBOA-MCP-RESULT:")
    (write result)
    (newline)))
```

**Stdout capture pattern (separate stdout from return value):**
```scheme
(let-values ([(output result)
              (let ([port (open-output-string)])
                (let ([r (parameterize ([current-output-port port])
                           YOUR-CODE-HERE)])
                  (values (get-output-string port) r)))])
  (when (> (string-length output) 0)
    (display "JERBOA-MCP-STDOUT:")
    (display output)
    (newline))
  (display "JERBOA-MCP-RESULT:")
  (write result)
  (newline))
```

### 4.2 REPL Session Management

Same model as gerbil-mcp but using Chez:
- Persistent `scheme` subprocess per session
- Sentinel-based output delimiting
- Max 5 concurrent sessions (configurable)
- 10-minute idle timeout
- Auto-cleanup on destroy
- `preload_file` parameter to load a file's imports at creation
- `env` parameter for FFI library paths

---

## 5. Tool Implementation Phases

### Design Principle

Every tool follows this pattern (one file per tool in `src/tools/`):

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, RESULT_MARKER, getJerboaHome } from '../chez.js';

export function registerMyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_my_tool',
    {
      title: 'My Tool',
      description: '...',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        code: z.string().describe('Jerboa/Gerbil code to check'),
      },
    },
    async ({ code }) => {
      // ... implementation
      return { content: [{ type: 'text', text: result }] };
    },
  );
}
```

**Tool naming convention:** All tools use `jerboa_` prefix (e.g., `jerboa_eval`, `jerboa_check_syntax`).

---

### Phase 1: Core Evaluation (7 tools) — Foundation

These must work first; everything else depends on them.

#### 1.1 `jerboa_eval` — Evaluate Jerboa/Gerbil expressions
- **File:** `src/tools/eval.ts`
- **Params:** `code: string`, `imports?: string[]`, `loadpath?: string`, `project_path?: string`, `env?: Record<string, string>`
- **Behavior:** Write code to temp file with preamble, run via `scheme --libdirs ... --script`, capture stdout separately from return value
- **Key adaptation:** Use `(import (jerboa prelude))` as default preamble. If `imports` provided, use those instead.
- **Reference:** gerbil-mcp's `eval.ts` + gherkin-mcp's `eval.ts`

#### 1.2 `jerboa_check_syntax` — Validate syntax
- **File:** `src/tools/check-syntax.ts`
- **Params:** `code: string`
- **Behavior:** Attempt to `read` the code without evaluating. Use Chez's reader to catch syntax errors.
- **Key adaptation:** Chez reader with jerboa reader loaded. Report line/column for errors.
- **Implementation:**
  ```scheme
  (guard (exn [#t (display "JERBOA-MCP-ERROR:") (display-condition exn)])
    (let ([p (open-input-string CODE)])
      (let loop ()
        (let ([form (read p)])
          (unless (eof-object? form) (loop))))
      (display "JERBOA-MCP-VALID")))
  ```

#### 1.3 `jerboa_compile_check` — Full compilation check
- **File:** `src/tools/compile-check.ts`
- **Params:** `code: string`, `loadpath?: string`, `project_path?: string`
- **Behavior:** Actually compile/expand the code to catch unbound identifiers and type errors. Use `(expand '(begin ...))` or try loading the code as a library.
- **Key adaptation:** Chez's `expand` catches unbound identifiers at expansion time.

#### 1.4 `jerboa_batch_syntax_check` — Check multiple snippets
- **File:** `src/tools/batch-syntax-check.ts`
- **Params:** `snippets: Array<{id: string, code: string}>`
- **Behavior:** Check each snippet independently, return per-snippet pass/fail
- **Pure TS + single Chez invocation:** Build one program that reads all snippets

#### 1.5 `jerboa_verify` — Combined check (syntax + compile + lint + arity + duplicates)
- **File:** `src/tools/verify.ts`
- **Params:** `file_path: string`, `loadpath?: string`, `project_path?: string`
- **Behavior:** Run all checks in one pass, return unified issue list
- **Depends on:** check-syntax, compile-check, lint, check-arity, check-duplicates

#### 1.6 `jerboa_version` — Environment info
- **File:** `src/tools/version.ts`
- **Behavior:** Report Chez version, Jerboa version, machine type, JERBOA_HOME, lib dirs
- **Implementation:**
  ```scheme
  (import (jerboa prelude))
  (display (format "Chez Scheme ~a\n" (scheme-version)))
  (display (format "Machine: ~a\n" (machine-type)))
  (display (format "JERBOA_HOME: ~a\n" JERBOA_HOME))
  ```

#### 1.7 `jerboa_preflight_check` — Verify environment health
- **File:** `src/tools/preflight-check.ts`
- **Behavior:** Check: scheme binary available, JERBOA_HOME set, lib/ exists, basic eval works, jerboa prelude loads

---

### Phase 2: Module & Symbol Introspection (20 tools)

#### 2.1 `jerboa_module_exports`
- **Params:** `module: string`, `loadpath?: string`, `project_path?: string`
- **Behavior:** Import the module and list its exports using `library-exports`
- **Adaptation:** Chez's `(library-exports '(std sort))` returns the export list
- **Fallback:** Parse `.sls` file directly for `(export ...)` form

#### 2.2 `jerboa_function_signature`
- **Params:** `function_name: string`, `module?: string`, `loadpath?: string`, `project_path?: string`
- **Behavior:** Determine arity via `(procedure-arity-mask fn)` in Chez. Parse source for parameter names.
- **Adaptation:** Chez has `procedure-arity-mask` (bitmask of accepted arities)

#### 2.3 `jerboa_doc`
- **Params:** `symbol: string`
- **Behavior:** Look up symbol type (procedure/macro/value), arity, qualified name, related symbols
- **Implementation:** `(eval symbol)` + type tests + arity mask

#### 2.4 `jerboa_class_info`
- **Params:** `type_name: string`, `module?: string`
- **Behavior:** Inspect defstruct/defclass types — fields, inheritance, constructor signature
- **Adaptation:** Use Chez `record-type-descriptor` API: `(record-type-field-names rtd)`, `(record-type-parent rtd)`

#### 2.5 `jerboa_find_definition`
- **Params:** `symbol: string`, `directory?: string`, `source_preview?: boolean`
- **Behavior:** Grep source files for `(def symbol`, `(defstruct symbol`, etc.
- **Implementation:** Pure TS file scanning with regex patterns

#### 2.6 `jerboa_module_deps`
- **Params:** `module: string`, `transitive?: boolean`
- **Behavior:** Parse `.sls` file for `(import ...)` forms, recursively if transitive
- **Implementation:** TS file parsing or Chez `(library-requirements '(module))`

#### 2.7 `jerboa_apropos`
- **Params:** `pattern: string`
- **Behavior:** Search for symbols matching pattern in environment
- **Implementation:** `(environment-symbols (interaction-environment))` filtered by pattern

#### 2.8 `jerboa_list_std_modules`
- **Params:** `prefix?: string`
- **Behavior:** List available standard library modules under `lib/std/`
- **Implementation:** TS glob of `*.sls` files in `$JERBOA_HOME/lib/std/`

#### 2.9 `jerboa_suggest_imports`
- **Params:** `symbol: string`
- **Behavior:** Find which module exports a given symbol
- **Implementation:** Scan all `.sls` files for export lists containing the symbol

#### 2.10 `jerboa_smart_complete`
- **Params:** `prefix: string`, `modules?: string[]`
- **Behavior:** Return valid completions for partial symbol
- **Implementation:** Filter `environment-symbols` by prefix

#### 2.11 `jerboa_describe`
- **Params:** `expression: string`, `imports?: string[]`
- **Behavior:** Evaluate and describe result type, structure, contents
- **Implementation:** Type-test cascade (hashtable? → list? → vector? → string? → number? → ...)

#### 2.12 `jerboa_load_file`
- **Params:** `file_path: string`
- **Behavior:** Parse .ss file to extract imports, exports, definitions without executing
- **Implementation:** Read forms, classify by head symbol (import/export/def/defstruct/...)

#### 2.13 `jerboa_file_summary`
- **Params:** `file_path: string`
- **Behavior:** Quick structural overview — imports, exports, definitions grouped by kind
- **Implementation:** Lighter than load_file, just counts and names

#### 2.14 `jerboa_document_symbols`
- **Params:** `file_path: string`
- **Behavior:** List all definitions with name, kind, line number
- **Implementation:** Parse source for def/defstruct/defclass/defmethod forms

#### 2.15 `jerboa_workspace_symbols`
- **Params:** `query: string`, `directory: string`
- **Behavior:** Search for definitions across all .ss/.sls files
- **Implementation:** TS file scanning

#### 2.16 `jerboa_find_callers`
- **Params:** `symbol: string`, `directory: string`
- **Behavior:** Find all files referencing a given symbol
- **Implementation:** TS grep with word boundary

#### 2.17 `jerboa_module_catalog`
- **Params:** `module: string`
- **Behavior:** Compact reference of all exports with kind, arity, descriptions
- **Implementation:** Combine module-exports + doc for each symbol

#### 2.18 `jerboa_error_hierarchy`
- **Behavior:** Display Chez condition type hierarchy
- **Implementation:** Static tree of R6RS/Chez condition types

#### 2.19 `jerboa_ffi_inspect`
- **Params:** `module: string`
- **Behavior:** Classify FFI exports (c-lambda → foreign-procedure mappings)
- **Implementation:** Parse source for `c-lambda`, `define-c-lambda`, `foreign-procedure`

#### 2.20 `jerboa_diff_modules`
- **Params:** `module_a: string`, `module_b: string`
- **Behavior:** Compare exports between two modules
- **Implementation:** Set operations on export lists

---

### Phase 3: Code Analysis & Linting (28 tools)

#### 3.1 `jerboa_lint`
- **Params:** `file_path: string`
- **Behavior:** Static analysis: unused imports, duplicate defs, shadowed bindings, style issues
- **Implementation:** Pure TS. Parse imports, scan definitions, cross-reference usage.
- **Rules to implement:**
  - Unused imports (import present but no symbol used)
  - Duplicate definitions (same name defined twice)
  - Shadowed bindings (local name shadows import)
  - Missing exports (exported but not defined)
  - Hash literal symbol keys
  - Port type mismatch (char I/O on byte port)
  - Macro suggestions (verbose patterns that have sugar)

#### 3.2 `jerboa_diagnostics`
- **Params:** `file_path: string`, `loadpath?: string`
- **Behavior:** Structured compilation diagnostics with file/line/column/severity
- **Implementation:** Run compilation, parse error output

#### 3.3 `jerboa_check_arity`
- **Params:** `directory: string`
- **Behavior:** Detect functions called with wrong argument count
- **Implementation:** Parse definitions for arity, scan call sites

#### 3.4 `jerboa_check_test_arity`
- **Params:** `function_name: string`, `directory: string`
- **Behavior:** Scan test files for calls to a specific function

#### 3.5 `jerboa_signature_impact`
- **Params:** `function_name: string`, `directory: string`, `new_arity?: number`
- **Behavior:** Find ALL call sites before changing a function signature

#### 3.6 `jerboa_check_exports`
- **Params:** `directory: string`
- **Behavior:** Cross-module export/import consistency

#### 3.7 `jerboa_check_import_conflicts`
- **Params:** `file_path?: string`, `project_path?: string`
- **Behavior:** Detect import conflicts before build

#### 3.8 `jerboa_check_duplicates`
- **Params:** `file_path: string`
- **Behavior:** Fast duplicate top-level definition detection
- **Implementation:** Pure TS, no subprocess

#### 3.9 `jerboa_dead_code`
- **Params:** `directory: string`
- **Behavior:** Find unexported, uncalled definitions

#### 3.10 `jerboa_dependency_cycles`
- **Params:** `directory: string`
- **Behavior:** Detect circular module imports via DFS

#### 3.11 `jerboa_test_coverage`
- **Params:** `module: string`, `directory: string`
- **Behavior:** Compare module exports against test file to find untested symbols

#### 3.12 `jerboa_test_assertion_audit`
- **Params:** `file_path?: string`, `directory?: string`
- **Behavior:** Detect assertion mistakes that silently pass

#### 3.13 `jerboa_dispatch_coverage_analysis`
- **Params:** `file_path: string`
- **Behavior:** Find command interaction coverage gaps in tests

#### 3.14 `jerboa_return_type_analysis`
- **Params:** `file_path: string`
- **Behavior:** Detect gotcha return values (hash-ref returning #!void, when returning void)

#### 3.15 `jerboa_tail_position_check`
- **Params:** `function_name: string`, `file_path: string`
- **Behavior:** Check if recursive calls are in tail position

#### 3.16 `jerboa_method_dispatch_audit`
- **Params:** `file_path: string`
- **Behavior:** Check `{method obj}` dispatch calls against defmethod declarations

#### 3.17 `jerboa_interface_compliance_check`
- **Params:** `type_name: string`, `interface_name: string`, `file_path: string`
- **Behavior:** Verify struct/class implements required methods

#### 3.18 `jerboa_macro_hygiene_check`
- **Params:** `file_path: string`
- **Behavior:** Detect free variable capture in macros

#### 3.19 `jerboa_pattern_cache_check`
- **Params:** `file_path: string`
- **Behavior:** Detect regex compilation anti-patterns

#### 3.20 `jerboa_concurrent_plan_validate`
- **Params:** `steps: Array<{name, depends_on}>`
- **Behavior:** Validate DAG execution plans

#### 3.21 `jerboa_project_health_check`
- **Params:** `directory: string`
- **Behavior:** Composite audit: lint + dead code + cycles + export consistency

#### 3.22 `jerboa_cross_module_check`
- **Params:** `directory: string`, `files?: string[]`
- **Behavior:** Detect unbound symbols across project files

#### 3.23 `jerboa_pre_add_symbol_check`
- **Params:** `symbol: string`, `file_path: string`
- **Behavior:** Check if new symbol would conflict with imports

#### 3.24 `jerboa_export_reexport_conflicts`
- **Params:** `file_path: string`
- **Behavior:** Detect transitive re-export conflicts

#### 3.25 `jerboa_validate_example_imports`
- **Params:** `file_path: string`
- **Behavior:** Check that imports match used symbols in examples

#### 3.26 `jerboa_example_api_coverage`
- **Params:** `module: string`, `directory: string`
- **Behavior:** Check which exports are referenced in example files

#### 3.27 `jerboa_call_graph`
- **Params:** `file_path: string`
- **Behavior:** Static analysis — which functions call which
- **Implementation:** Pure TS, parse and cross-reference

#### 3.28 `jerboa_resolve_imports`
- **Params:** `file_path: string`
- **Behavior:** Analyze unbound identifiers and suggest imports

---

### Phase 4: FFI & Type Tools (15 tools)

Jerboa's FFI maps `c-lambda` to `foreign-procedure`. These tools help with FFI development.

#### 4.1 `jerboa_ffi_scaffold`
- **Params:** `header_path: string`, `module_name?: string`
- **Behavior:** Parse C header, generate Jerboa FFI bindings
- **Key adaptation:** Generate `foreign-procedure` instead of Gambit `c-lambda`

#### 4.2 `jerboa_ffi_type_check`
- **Params:** `file_path: string`
- **Behavior:** Detect type mismatches in FFI declarations
- **Implementation:** Parse c-lambda/foreign-procedure declarations, check arg types

#### 4.3 `jerboa_ffi_null_safety`
- **Params:** `file_path: string`
- **Behavior:** Find pointer dereferences without null checks

#### 4.4 `jerboa_ffi_buffer_size_audit`
- **Params:** `file_path: string`
- **Behavior:** Cross-reference buffer sizes with allocations

#### 4.5 `jerboa_ffi_callback_debug`
- **Params:** `file_path: string`
- **Behavior:** Analyze FFI callback linkage

#### 4.6 `jerboa_ffi_link_check`
- **Params:** `file_path: string`, `library_path: string`
- **Behavior:** Cross-reference C function calls against library symbols

#### 4.7 `jerboa_ffi_utf8_byte_length_audit`
- **Params:** `file_path: string`
- **Behavior:** Detect string-length vs byte-length mismatches

#### 4.8 `jerboa_detect_ifdef_stubs`
- **Params:** `file_path?: string`, `project_path?: string`
- **Behavior:** Find #ifdef stubs that return NULL/0

#### 4.9 `jerboa_exe_macro_check`
- **Params:** `file_path: string`
- **Behavior:** Detect unbound identifiers from macro expansion in exe builds
- **Adaptation:** Chez's compilation model is different — focus on library expansion issues

#### 4.10 `jerboa_build_linkage_diagnostic`
- **Params:** `project_path: string`, `exe_target?: string`
- **Behavior:** Trace transitive FFI link dependencies

#### 4.11 `jerboa_check_c_library`
- **Params:** `project_path?: string`, `libraries?: string[]`
- **Behavior:** Check if C libraries are installed (pkg-config/ldconfig)

#### 4.12 `jerboa_binary_audit`
- **Params:** `binary_path: string`
- **Behavior:** Scan compiled binary for information leaks

#### 4.13 `jerboa_cross_package_diff`
- **Params:** `module_a: string`, `module_b: string`
- **Behavior:** Compare function signatures across packages

#### 4.14 `jerboa_migration_check`
- **Params:** `file_path: string`
- **Behavior:** Scan for Gerbil patterns that need Jerboa adaptation
- **Key adaptation:** Instead of v0.18→v0.19, detect Gerbil→Jerboa migration issues:
  - `(export #t)` not supported → must enumerate exports
  - `for-syntax` / `begin-syntax` → different in Chez
  - Gambit `##` primitives → Chez equivalents
  - `gxi`/`gxc` references → `scheme` invocation

#### 4.15 `jerboa_translate_scheme`
- **Params:** `code: string`, `source_dialect: string` (r7rs/racket/gerbil)
- **Behavior:** Translate to idiomatic Jerboa
- **Key adaptation:** Add "gerbil" source dialect that handles Gerbil→Jerboa differences

---

### Phase 5: Macro Tools (8 tools)

#### 5.1 `jerboa_expand_macro`
- **Params:** `expression: string`, `imports?: string[]`
- **Behavior:** Show fully expanded form
- **Implementation:** `(expand '(YOUR-EXPRESSION))` in Chez

#### 5.2 `jerboa_trace_macro`
- **Params:** `expression: string`
- **Behavior:** Step-by-step expansion showing each transformation
- **Adaptation:** Chez's `expand` doesn't natively trace steps. May need `sc-expand` with tracing.

#### 5.3 `jerboa_macro_expansion_size`
- **Params:** `expression: string`
- **Behavior:** Compare source vs expanded size, warn on explosive macros

#### 5.4 `jerboa_macro_hygiene_check`
- **Params:** `file_path: string`
- **Behavior:** Detect variable capture in macro definitions

#### 5.5 `jerboa_macro_pattern_detector`
- **Params:** `file_path: string`, `min_occurrences?: number`
- **Behavior:** Find repetitive code that could be macros

#### 5.6 `jerboa_boilerplate_converter`
- **Params:** `expressions: string[]`
- **Behavior:** Convert repetitive blocks to macro definitions

#### 5.7 `jerboa_macro_template_library`
- **Params:** `pattern_type: string`, `prefix?: string`
- **Behavior:** Generate reusable macro templates
- **Pattern types:** hash-accessors, method-delegation, validation-guards, enum-constants, event-handlers, type-setters

#### 5.8 `jerboa_signal_trace`
- **Params:** `signals: string[]`
- **Behavior:** Generate signal handling instrumentation code

---

### Phase 6: Build & Compilation (12 tools)

#### Key adaptation:
Jerboa doesn't have `gerbil build` or `gxpkg`. It uses:
- `scheme --libdirs lib --script file.ss` (run)
- `scheme --compile-imported-libraries --libdirs lib --script file.ss` (compile)
- `make` for project builds
- Chez's native library caching system

#### 6.1 `jerboa_build_and_report`
- **Params:** `project_path: string`, `modules_only?: boolean`, `loadpath?: string`
- **Behavior:** Run `make build` and parse output for structured diagnostics
- **Adaptation:** Parse Chez compilation errors instead of gxc errors

#### 6.2 `jerboa_build_chain`
- **Params:** `project_path: string`, `dry_run?: boolean`
- **Behavior:** Build dependent projects in dependency order

#### 6.3 `jerboa_build_conflict_check`
- **Params:** `project_path: string`
- **Behavior:** Detect running Chez build processes on same project

#### 6.4 `jerboa_build_progress`
- **Params:** `output_file?: string`, `build_output?: string`
- **Behavior:** Parse build output for progress info

#### 6.5 `jerboa_stale_static`
- **Params:** `project_path: string`, `exe_check?: boolean`
- **Behavior:** Compare compiled `.so` artifacts for staleness
- **Adaptation:** Chez compiles `.sls` → `.so` files. Check mtime of `.so` vs `.sls`.

#### 6.6 `jerboa_make`
- **Params:** `project_path: string`, `target?: string`
- **Behavior:** Run make targets

#### 6.7 `jerboa_run_tests`
- **Params:** `file_path?: string`, `directory?: string`, `filter?: string`, `verbose?: boolean`, `env?: Record<string, string>`
- **Behavior:** Execute test files via `scheme --libdirs lib --script test-file.ss`
- **Adaptation:** Jerboa tests use `(import (std test))` with `check` and `test-suite`

#### 6.8 `jerboa_build_ss_audit`
- **Params:** `file_path: string`
- **Behavior:** Audit build files for missing imports

#### 6.9 `jerboa_scaffold`
- **Params:** `name: string`, `directory?: string`
- **Behavior:** Create new Jerboa project from template

#### 6.10 `jerboa_project_template`
- **Params:** `template: string`, `name: string`, `directory?: string`
- **Behavior:** Generate complete project from templates (cli, http-api, library, etc.)
- **Templates:** cli, library, ffi-wrapper, test-project (adapt from gerbil-mcp, remove gerbil-specific ones)

#### 6.11 `jerboa_package_info`
- **Params:** `query?: string`
- **Behavior:** List chez-* extension libraries and their status
- **Adaptation:** Jerboa wraps chez-https, chez-ssl, chez-zlib, etc. Show which are available.

#### 6.12 `jerboa_project_info`
- **Params:** `directory: string`
- **Behavior:** Project summary: source files, modules, dependencies, test files

---

### Phase 7: Testing & Profiling (10 tools)

#### 7.1 `jerboa_benchmark`
- **Params:** `expression: string`, `iterations?: number`
- **Behavior:** Measure wall-clock time, CPU time, GC stats
- **Implementation:** `(time ...)` in Chez, plus `(statistics)` for detailed metrics

#### 7.2 `jerboa_benchmark_compare`
- **Params:** `command: string`, `save_as?: string`, `compare_with?: string`
- **Behavior:** Save and compare benchmark baselines

#### 7.3 `jerboa_profile`
- **Params:** `expression: string`, `functions: string[]`
- **Behavior:** Instrument functions with timing
- **Adaptation:** Chez has `profile-dump-html`, `profile-dump-data` for native profiling

#### 7.4 `jerboa_heap_profile`
- **Params:** `expression: string`
- **Behavior:** GC heap metrics before/after
- **Implementation:** `(statistics)` captures heap-size, gc-count, gc-time

#### 7.5 `jerboa_trace_calls`
- **Params:** `expression: string`, `functions: string[]`
- **Behavior:** Count function calls

#### 7.6 `jerboa_trace_eval`
- **Params:** `expression: string`
- **Behavior:** Step through let*/let bindings showing each value

#### 7.7 `jerboa_function_behavior`
- **Params:** `function_name: string`, `module?: string`
- **Behavior:** Behavior card showing return values for normal/edge cases
- **Built-in cards:** ~50 for common functions (hash-ref, sort, string-split, etc.)

#### 7.8 `jerboa_sxml_inspect`
- **Params:** `xml_text?: string`, `expression?: string`
- **Behavior:** Parse XML and display SXML tree structure

#### 7.9 `jerboa_port_fd_inspector`
- **Params:** `expression: string`
- **Behavior:** Extract fd number and properties from Chez port
- **Adaptation:** Chez ports expose fd differently — use `port-file-descriptor` if available

#### 7.10 `jerboa_scaffold_test`
- **Params:** `module: string`
- **Behavior:** Generate test skeleton from module exports

---

### Phase 8: Code Transformation (7 tools)

All pure TS, no Chez subprocess needed.

#### 8.1 `jerboa_rename_symbol`
- **Params:** `old_name: string`, `new_name: string`, `directory?: string`, `file_path?: string`, `dry_run?: boolean`
- **Behavior:** Project-wide rename with word boundary detection

#### 8.2 `jerboa_balanced_replace`
- **Params:** `file_path: string`, `old_string: string`, `new_string: string`, `dry_run?: boolean`
- **Behavior:** Balance-safe string replacement

#### 8.3 `jerboa_wrap_form`
- **Params:** `file_path: string`, `start_line: number`, `wrapper: string`, `end_line?: number`, `dry_run?: boolean`
- **Behavior:** Wrap lines in a new Scheme form with guaranteed matching parens

#### 8.4 `jerboa_splice_form`
- **Params:** `file_path: string`, `line: number`, `keep_children?: number[]`, `dry_run?: boolean`
- **Behavior:** Remove wrapper form while keeping children

#### 8.5 `jerboa_generate_module_stub`
- **Params:** `source_module: string`, `output_path: string`
- **Behavior:** Generate module skeleton matching another module's exports

#### 8.6 `jerboa_generate_module`
- **Params:** `template_path: string`, `output_path: string`, `substitutions: Record<string, string>`
- **Behavior:** Create new module from template with substitutions

#### 8.7 `jerboa_format`
- **Params:** `code: string`
- **Behavior:** Pretty-print using Chez's `pretty-print`

---

### Phase 9: Diagnostics & Debugging (11 tools)

#### 9.1 `jerboa_explain_error`
- **Params:** `error_message: string`
- **Behavior:** Classify error, suggest causes, find relevant recipes
- **Adaptation:** Chez condition types differ from Gambit exceptions. Map Chez error messages.

#### 9.2 `jerboa_error_fix_lookup`
- **Params:** `error_message: string`, `search_all?: boolean`
- **Behavior:** Instant fix lookup from error-fixes.json

#### 9.3 `jerboa_error_fix_add`
- **Params:** `id: string`, `pattern: string`, `message: string`, `explanation: string`, `fix: string`
- **Behavior:** Add new error→fix mapping

#### 9.4 `jerboa_demangle` — Not applicable
- **Note:** Chez doesn't mangle symbols like Gambit. **SKIP** or repurpose for decoding Chez's internal naming.

#### 9.5 `jerboa_bisect_crash`
- **Params:** `file_path: string`
- **Behavior:** Binary-search a crashing file for minimal reproducing forms

#### 9.6 `jerboa_stack_trace_decode`
- **Params:** `trace: string`
- **Behavior:** Parse Chez condition traces into readable form
- **Adaptation:** Chez stack traces use `(debug)` format, not GDB/Gambit format

#### 9.7 `jerboa_check_balance`
- **Params:** `code: string`
- **Behavior:** Fast paren/bracket/brace balance checking
- **Implementation:** Pure TS, no subprocess. Port from gerbil-mcp directly.

#### 9.8 `jerboa_read_forms`
- **Params:** `file_path: string`
- **Behavior:** Read file with Chez reader, show each form's line range and summary

#### 9.9 `jerboa_repl_session`
- **Params:** `action: string` (create/eval/destroy/list), various per action
- **Behavior:** Persistent Chez subprocess sessions

#### 9.10 `jerboa_sigchld_check`
- **Params:** `directory: string`
- **Behavior:** Detect SIGCHLD/process-status incompatibility
- **Adaptation:** Chez uses different signal handling than Gambit. Adapt patterns.

#### 9.11 `jerboa_stdlib_source`
- **Params:** `module: string`
- **Behavior:** Read source code of any Jerboa stdlib module
- **Implementation:** Resolve module path to `.sls` file in `$JERBOA_HOME/lib/`

---

### Phase 10: Scaffolding & Code Generation (8 tools)

#### 10.1 `jerboa_httpd_handler_scaffold`
- **Params:** `routes: Array<{method, path, handler_name}>`
- **Behavior:** Generate HTTP server code for Jerboa's `:std/net/httpd`

#### 10.2 `jerboa_parser_grammar_scaffold`
- **Params:** `tokens: Array<{name, pattern}>`, `rules: Array<{name, production}>`
- **Behavior:** Generate parser skeleton

#### 10.3 `jerboa_actor_ensemble_scaffold`
- **Params:** `actors: Array<{name, messages}>`, `supervision?: string`
- **Behavior:** Generate actor project template

#### 10.4 `jerboa_db_pattern_scaffold`
- **Params:** `db_type: string` (sqlite/postgresql), `tables: Array<{name, columns}>`
- **Behavior:** Generate CRUD with connection pooling

#### 10.5 `jerboa_graceful_shutdown_scaffold`
- **Params:** `signals?: string[]`, `actor_system?: boolean`
- **Behavior:** Generate signal handling and cleanup patterns

#### 10.6 `jerboa_test_fixture_gen`
- **Params:** `module: string`
- **Behavior:** Generate mock modules and test setup

#### 10.7 `jerboa_generate_api_docs`
- **Params:** `module: string`, `title?: string`
- **Behavior:** Generate markdown API docs from module exports

#### 10.8 `jerboa_project_dep_graph`
- **Params:** `directory: string`
- **Behavior:** Visualize module dependency graph as ASCII tree

---

### Phase 11: Cookbook & Knowledge Management (6 tools)

#### 11.1 `jerboa_howto`
- **Params:** `query: string`, `compact?: boolean`, `max_results?: number`
- **Behavior:** Search curated Jerboa recipes by keyword
- **Adaptation:** Start with Jerboa-specific recipes. Many gerbil-mcp recipes apply directly since Jerboa is 95% Gerbil-compatible. Import relevant recipes, update imports from `:gerbil/*` patterns.
- **Features:** Synonym expansion, fuzzy matching, tag-based scoring

#### 11.2 `jerboa_howto_get`
- **Params:** `id: string`
- **Behavior:** Fetch single recipe by ID

#### 11.3 `jerboa_howto_add`
- **Params:** `id: string`, `title: string`, `tags: string[]`, `imports: string[]`, `code: string`, `notes?: string`
- **Behavior:** Add new recipe to cookbooks.json

#### 11.4 `jerboa_howto_run`
- **Params:** `id: string`
- **Behavior:** Compile-check and optionally execute a recipe

#### 11.5 `jerboa_howto_verify`
- **Params:** `mode?: string` (syntax/compile), `recipe_ids?: string[]`
- **Behavior:** Batch-verify cookbook recipes

#### 11.6 `jerboa_module_quickstart`
- **Params:** `module: string`
- **Behavior:** Generate working example for a module

---

### Phase 12: Security & Feature Management (5 tools)

#### 12.1 `jerboa_security_scan`
- **Params:** `file_path?: string`, `project_path?: string`, `severity_threshold?: string`
- **Behavior:** Static security scanner for .ss/.sls and C files
- **Rules:** Shell injection, FFI type mismatches, missing unwind-protect, unsafe C patterns
- **Adaptation:** Adapt rules for Chez patterns (`foreign-procedure` instead of `c-lambda`, `dynamic-wind` instead of `unwind-protect`)

#### 12.2 `jerboa_security_pattern_add`
- **Params:** `id: string`, `title: string`, `severity: string`, `scope: string`, `pattern: string`, `message: string`, `remediation: string`
- **Behavior:** Add custom security detection rules

#### 12.3 `jerboa_suggest_feature`
- **Params:** `id: string`, `title: string`, `description: string`, `impact: string`, `tags: string[]`, ...
- **Behavior:** Submit feature suggestion

#### 12.4 `jerboa_list_features`
- **Params:** `query?: string`
- **Behavior:** Search/list existing feature suggestions

#### 12.5 `jerboa_vote_feature`
- **Params:** `id: string`
- **Behavior:** Vote for existing feature

---

### Phase 13: Project Context (5 tools)

#### 13.1 `jerboa_project_map`
- **Params:** `directory: string`
- **Behavior:** Complete view of all modules with exports, definitions, dependencies

#### 13.2 `jerboa_dynamic_reference`
- **Params:** `module: string`
- **Behavior:** Auto-generate API reference docs on demand

#### 13.3 `jerboa_event_system_guide`
- **Params:** `topic?: string`
- **Behavior:** Interactive guide for event/concurrency patterns

#### 13.4 `jerboa_check_exports`
- **Params:** `directory: string`
- **Behavior:** Verify exports match definitions across project

#### 13.5 `jerboa_dead_code`
- **Params:** `directory: string`
- **Behavior:** Find unexported, uncalled definitions

---

### Tools to SKIP (gerbil-mcp specific, not applicable):

| gerbil-mcp tool | Why skip |
|----------------|----------|
| `gerbil_demangle` | Gambit C name mangling doesn't exist in Chez |
| `gerbil_gambit_primitive_lookup` | Gambit ## namespace doesn't exist |
| `gerbil_gambit_source_extract` | Gambit-specific |
| `gerbil_gambuild_extract` | Gambit build system |
| `gerbil_stale_linked_pkg` | gxpkg linking doesn't exist |
| `gerbil_pkg_link_sync` | gxpkg linking doesn't exist |
| `gerbil_package_manage` | gxpkg doesn't exist (use make/manual) |
| `gerbil_build_project` | gxpkg build doesn't exist |
| `gerbil_obfuscate_link_file` | Gambit link files don't exist |
| `gerbil_qt_test_runner` | Very Gerbil-specific FFI test pattern |

**Total: ~140 tools** (150 gerbil-mcp tools minus ~10 Gambit-specific ones)

---

## 6. Data Files & Knowledge Base

### 6.1 `cookbooks.json` — Jerboa recipes

**Schema (same as gerbil-mcp):**
```json
{
  "id": "string",
  "title": "string",
  "tags": ["string"],
  "imports": ["string"],
  "code": "string",
  "notes": "string (optional)",
  "related": ["string (optional)"],
  "deprecated": "boolean (optional)",
  "superseded_by": "string (optional)",
  "valid_for": ["string (optional)"]
}
```

**Initial recipes to include (seed from Jerboa's own patterns):**

1. **jerboa-import-prelude** — Basic import pattern
2. **jerboa-defstruct** — Define and use structs
3. **jerboa-defclass-inherit** — Class inheritance
4. **jerboa-defmethod** — Method dispatch
5. **jerboa-match** — Pattern matching
6. **jerboa-try-catch** — Error handling
7. **jerboa-hash-create** — Hash table creation and access
8. **jerboa-json-parse** — JSON parsing with `(std text json)`
9. **jerboa-json-generate** — JSON generation
10. **jerboa-sort** — Sorting with `(std sort)`
11. **jerboa-string-join** — String operations
12. **jerboa-file-read** — File I/O with `(std misc ports)`
13. **jerboa-channel-thread** — Channel-based concurrency
14. **jerboa-ffi-basic** — Foreign procedure binding
15. **jerboa-test-suite** — Writing tests with `(std test)`
16. **jerboa-run-script** — Running a Jerboa script
17. **jerboa-keyword-args** — Keyword argument functions
18. **jerboa-defrule** — Custom syntax rules
19. **jerboa-csv-parse** — CSV parsing
20. **jerboa-http-request** — HTTP client via chez-https wrapper
21. **jerboa-path-ops** — Path manipulation with `(std os path)`
22. **jerboa-env-vars** — Environment variables with `(std os env)`
23. **jerboa-process-spawn** — Process spawning with `(std misc process)`
24. **jerboa-binary-pack** — Binary data with `(std binary)`
25. **jerboa-getopt** — CLI argument parsing

**Migration recipes (Gerbil → Jerboa):**
26. **gerbil-to-jerboa-imports** — Import translation guide
27. **gerbil-to-jerboa-ffi** — FFI differences
28. **gerbil-to-jerboa-modules** — Module system differences

### 6.2 `error-fixes.json`

**Schema:**
```json
{
  "id": "string",
  "pattern": "regex string",
  "type": "string",
  "fix": "string",
  "code_example": "string",
  "wrong_example": "string (optional)",
  "imports": ["string (optional)"],
  "related_recipes": ["string (optional)"]
}
```

**Initial entries (~20):**
1. `unbound-variable` — "Exception: variable X is not bound" → check imports
2. `wrong-argument-count` — "Exception: incorrect argument count" → check arity
3. `not-a-procedure` — "Exception: attempt to apply non-procedure" → check value type
4. `import-conflict` — "import conflict for X" → use except-in
5. `duplicate-definition` — "duplicate definition for X" → rename or remove
6. `incompatible-types` — "incompatible record type" → check struct hierarchy
7. `file-not-found` — "cannot open file" → check paths and libdirs
8. `library-not-found` — "cannot find library" → check JERBOA_HOME and libdirs
9. `syntax-violation` — "invalid syntax" → check form structure
10. `assertion-violation` — check preconditions
11. `hash-ref-missing-key` — returns #!void (not error) → use hash-get with default
12. `keyword-mismatch` — positional vs keyword confusion
13. `reader-bracket-error` — brackets are plain parens (like Gerbil/Chez), no special reader needed
14. `foreign-procedure-error` — FFI type mismatch
15. `condition-handler` — guard vs with-exception-handler patterns

### 6.3 `security-rules.json`

**Schema (same as gerbil-mcp):**
```json
{
  "id": "string",
  "title": "string",
  "severity": "critical|high|medium|low|info",
  "scope": "scheme|c-shim|ffi-boundary",
  "pattern": "regex",
  "message": "string",
  "remediation": "string"
}
```

**Initial rules (~30, adapt from gerbil-mcp's 42):**
- Shell injection patterns (same as gerbil-mcp)
- FFI type mismatches (adapt for foreign-procedure)
- Missing dynamic-wind for cleanup (Chez equivalent of unwind-protect)
- Unsafe C patterns in c-declare blocks
- Port without proper cleanup
- Hardcoded credentials
- SQL injection in db queries
- Path traversal in file operations

### 6.4 `features.json`

Start empty, populated via `jerboa_suggest_feature`.

---

## 7. Resource & Prompt Templates

### 7.1 Resources (`src/resources.ts`)

#### Static reference docs (`src/resources/`):

1. **`jerboa-idioms.md`** — Common Jerboa patterns and idioms
2. **`jerboa-chez-interop.md`** — Chez Scheme interop (using Chez APIs directly)
3. **`jerboa-pattern-matching.md`** — Match syntax guide
4. **`jerboa-ffi.md`** — FFI binding guide (c-lambda → foreign-procedure)
5. **`jerboa-stdlib-map.md`** — Standard library module overview

#### Dynamic resources:
- `jerboa://cookbooks` — Recipe index
- `jerboa://cookbooks/{id}` — Individual recipe
- `jerboa://reference/idioms`
- `jerboa://reference/chez-interop`
- `jerboa://reference/pattern-matching`
- `jerboa://reference/ffi`
- `jerboa://reference/stdlib-map`
- `jerboa://reference/std-*` — Dynamic stdlib API references (introspected at request time)

### 7.2 Prompts (`src/prompts.ts`)

Adapt gerbil-mcp's prompt templates:

1. **explain-code** — Explain Jerboa code
2. **write-jerboa-module** — Write a new Jerboa module (with howto lookup)
3. **debug-jerboa-error** — Debug an error (with describe, explain-error)
4. **generate-tests** — Generate test suite for a module
5. **review-code** — Code review (with security scan)
6. **convert-to-jerboa** — Convert other Scheme to Jerboa
7. **port-from-gerbil** — Port Gerbil code to Jerboa (migration-specific)
8. **optimize-jerboa-code** — Performance optimization
9. **design-ffi-bindings** — Design FFI for a C library
10. **refactor-jerboa-module** — Refactor module structure

---

## 8. INSTRUCTIONS String

The `INSTRUCTIONS` string in `src/index.ts` is sent to all MCP clients. It should be comprehensive (300+ lines) following gerbil-mcp's structure:

```
You have access to a live Jerboa environment (Gerbil Scheme on stock Chez Scheme) via this MCP server.

## Essential Tools (Always Use)
- BEFORE writing ANY Jerboa code: FIRST use jerboa_howto ...
- BEFORE finalizing code with FFI: run jerboa_security_scan ...
- BEFORE writing code: use jerboa_module_exports ...
- BEFORE suggesting code: use jerboa_check_syntax ...
- BEFORE calling functions: use jerboa_function_signature ...
- When UNSURE: use jerboa_eval to test ...
- To catch compilation errors: use jerboa_compile_check ...
- To build with diagnostics: use jerboa_build_and_report ...
- To run tests: use jerboa_run_tests ...

## Common Tools (Use Frequently)
[... all 20 common tools ...]

## Specialized Tools
[... remaining tools organized by category ...]

## Common Workflows
- Debug a segfault: stale_static → bisect_crash → ffi_type_check
- Add a feature: howto → write code → check_syntax → compile_check → build_and_report
- Understand code: file_summary → document_symbols → call_graph → module_deps
- Port from Gerbil: migration_check → translate_scheme → verify → compile_check

## Important Guidance
- Don't guess function names — use jerboa_module_exports
- Don't assume arity — use jerboa_function_signature
- Don't skip the cookbook — use jerboa_howto before writing code
- Jerboa is Gerbil syntax on stock Chez — no Gambit, no gxi/gxc

## Key Differences from Gerbil
- Invoked via: scheme --libdirs /path/to/jerboa/lib --script file.ss
- No gxi, gxc, gxpkg binaries
- Uses Chez's native library caching (.so files)
- FFI: c-lambda expands to foreign-procedure
- Error handling: guard instead of with-catch
- Real SMP threads (Chez native), not green threads
- Import: (import (jerboa prelude)) for everything, or (import (std sort)) etc.
```

---

## 9. Testing Strategy

### 9.1 Test Infrastructure

Same as gerbil-mcp: Vitest integration tests that spawn a real MCP server process and communicate via JSON-RPC over stdin/stdout.

**File:** `test/tools.test.ts`

### 9.2 Test Structure

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Spawn MCP server, send tool calls, verify responses

describe('jerboa-mcp tools', () => {
  // Phase 1: Core
  describe('eval', () => { /* ... */ });
  describe('check-syntax', () => { /* ... */ });
  describe('compile-check', () => { /* ... */ });
  // ... etc for all tools
});
```

### 9.3 Test coverage targets

Each tool needs at minimum:
1. Happy path test (valid input → correct output)
2. Error handling test (invalid input → informative error)
3. Edge case test (empty input, missing file, etc.)

**Target:** 500+ tests (matching gerbil-mcp's 575+)

### 9.4 Cross-version testing

`scripts/test-cookbooks.ts` — Test recipes against multiple Chez installations:
```bash
npx tsx scripts/test-cookbooks.ts --chez /path/to/chez --dry-run
```

---

## 10. CLAUDE.md & Documentation

### 10.1 `CLAUDE.md` — Development guide

Mirror gerbil-mcp's CLAUDE.md structure:
- Project structure
- Build & test commands
- Development workflow
- MANDATORY: run tests after changes
- Adding a new tool checklist
- Common patterns
- Test count tracking

### 10.2 `CLAUDE.md.jerboa-example` — User project template

This is the file users copy into their Jerboa projects. It contains:
- All tool descriptions with usage guidance
- Mandatory workflow rules (howto first, verify before committing)
- Common workflows
- Key Jerboa-specific notes

### 10.3 `.claude/skills/save-discoveries/SKILL.md`

Adapt from gerbil-mcp:
- Save cookbook recipes via `jerboa_howto_add`
- Suggest tooling improvements via `jerboa_suggest_feature`
- Add security patterns via `jerboa_security_pattern_add`

---

## 11. Key Differences from gerbil-mcp

### 11.1 Subprocess layer

| Aspect | gerbil-mcp | jerboa-mcp |
|--------|-----------|------------|
| Binary | gxi, gxc, gxpkg, gerbil | scheme (stock Chez) |
| Env var | GERBIL_HOME, GERBIL_PATH | JERBOA_HOME |
| Lib path | GERBIL_LOADPATH | --libdirs argument |
| Preamble | Complex Gambit compat | `(import (jerboa prelude))` |
| Error handling | with-catch / display-exception | guard / display-condition |
| Compile check | gxc -S | (expand '(begin ...)) or (compile-library ...) |
| Build | gerbil build / gxpkg | make / scheme --compile-imported-libraries |
| REPL | gxi -q | scheme -q --libdirs ... |

### 11.2 Module system

| Aspect | gerbil-mcp | jerboa-mcp |
|--------|-----------|------------|
| Module path | `:std/sort` | `(std sort)` or `:std/sort` via reader |
| Exports query | `(module-context-export ...)` | `(library-exports '(std sort))` |
| Library files | .ss | .sls (R6RS libraries) |
| Compiled cache | .ssi files | .so files (Chez native) |
| Package manager | gxpkg | None (manual / make) |

### 11.3 FFI model

| Aspect | gerbil-mcp | jerboa-mcp |
|--------|-----------|------------|
| Declaration | c-lambda (Gambit) | c-lambda → foreign-procedure (Chez) |
| Foreign block | begin-ffi | begin-ffi (jerboa macro) |
| Type mapping | Gambit types | Chez foreign types |
| Shared libs | LD_LIBRARY_PATH | LD_LIBRARY_PATH (same) |

### 11.4 Runtime differences

| Aspect | gerbil-mcp | jerboa-mcp |
|--------|-----------|------------|
| Hash tables | Gambit hash-table | Chez hashtable (wrapped by jerboa runtime) |
| Threads | Gambit green threads | Chez OS threads (real SMP) |
| Conditions | Gambit exception | R6RS/Chez conditions |
| Records | Gambit structs (MOP) | Chez records (native) |
| GC | Gambit GC | Chez GC (generational) |

---

## 12. Implementation Order & Dependencies

### Dependency graph:

```
Phase 1 (Core) ─────────────────┐
  ├── chez.ts (FIRST)            │
  ├── eval                       │
  ├── check-syntax               │
  ├── compile-check              │
  ├── version                    │
  ├── preflight-check            │
  └── verify                     │
                                 │
Phase 2 (Introspection) ────────┤ depends on Phase 1
  ├── module-exports             │
  ├── function-signature         │
  ├── doc                        │
  └── ... (18 more)              │
                                 │
Phase 3 (Analysis) ─────────────┤ depends on Phase 1-2
  ├── lint                       │
  ├── check-arity                │
  └── ... (26 more)              │
                                 │
Phase 4 (FFI) ──────────────────┤ depends on Phase 1
  ├── ffi-scaffold               │
  ├── ffi-type-check             │
  └── ... (13 more)              │
                                 │
Phase 5 (Macros) ───────────────┤ depends on Phase 1
  ├── expand-macro               │
  └── ... (7 more)               │
                                 │
Phase 6 (Build) ────────────────┤ depends on Phase 1
  ├── build-and-report           │
  ├── run-tests                  │
  └── ... (10 more)              │
                                 │
Phase 7 (Test/Profile) ─────────┤ depends on Phase 1
Phase 8 (Transform) ────────────┤ pure TS, no deps
Phase 9 (Diagnostics) ──────────┤ depends on Phase 1
Phase 10 (Scaffolding) ─────────┤ pure TS
Phase 11 (Cookbook) ─────────────┤ depends on Phase 1
Phase 12 (Security/Features) ───┘ mostly pure TS
```

### Recommended implementation order:

1. **Project skeleton** — package.json, tsconfig, Makefile, .gitignore
2. **`src/chez.ts`** — Core subprocess layer (CRITICAL PATH)
3. **Phase 1 tools** — eval, check-syntax, compile-check, version, preflight
4. **`src/index.ts`** — Server entry with INSTRUCTIONS
5. **Phase 8 tools** — Pure TS tools (no Chez needed): check-balance, balanced-replace, wrap-form, splice-form, rename-symbol, format
6. **Phase 11 tools** — Cookbook (howto, howto-add, howto-get) + seed cookbooks.json
7. **`test/tools.test.ts`** — Test infrastructure + tests for Phase 1
8. **Phase 2 tools** — Module introspection (module-exports, function-signature, doc, describe)
9. **Phase 9 tools** — Diagnostics (explain-error, repl-session, read-forms)
10. **Phase 3 tools** — Code analysis (lint, check-arity, dead-code, etc.)
11. **Phase 5 tools** — Macro tools (expand-macro, trace-macro)
12. **Phase 6 tools** — Build tools (build-and-report, run-tests, make)
13. **Phase 7 tools** — Testing & profiling (benchmark, profile, trace-eval)
14. **Phase 4 tools** — FFI tools (ffi-scaffold, ffi-type-check, etc.)
15. **Phase 10 tools** — Scaffolding (project templates, handler scaffolds)
16. **Phase 12 tools** — Security scan, feature management
17. **Phase 13 tools** — Project context
18. **Resources & Prompts** — Reference docs, prompt templates
19. **Documentation** — CLAUDE.md.jerboa-example, save-discoveries skill
20. **Cross-version testing** — scripts/test-cookbooks.ts

### Per-tool implementation checklist:

For each tool:
- [ ] Create `src/tools/<tool-name>.ts`
- [ ] Export `register<ToolName>Tool(server: McpServer)` function
- [ ] Import and call in `src/index.ts`
- [ ] Add to INSTRUCTIONS string
- [ ] Add tests in `test/tools.test.ts`
- [ ] Add to CLAUDE.md.jerboa-example
- [ ] Verify: `npm run build && npm run test`

---

## Appendix A: Full Tool List (sorted alphabetically)

```
jerboa_actor_ensemble_scaffold
jerboa_apropos
jerboa_balanced_replace
jerboa_batch_syntax_check
jerboa_benchmark
jerboa_benchmark_compare
jerboa_binary_audit
jerboa_bisect_crash
jerboa_boilerplate_converter
jerboa_build_and_report
jerboa_build_chain
jerboa_build_conflict_check
jerboa_build_linkage_diagnostic
jerboa_build_progress
jerboa_build_ss_audit
jerboa_call_graph
jerboa_check_arity
jerboa_check_balance
jerboa_check_c_library
jerboa_check_duplicates
jerboa_check_exports
jerboa_check_import_conflicts
jerboa_check_syntax
jerboa_check_test_arity
jerboa_class_info
jerboa_compile_check
jerboa_concurrent_plan_validate
jerboa_cross_module_check
jerboa_cross_package_diff
jerboa_db_pattern_scaffold
jerboa_dead_code
jerboa_dependency_cycles
jerboa_describe
jerboa_detect_ifdef_stubs
jerboa_diagnostics
jerboa_diff_modules
jerboa_dispatch_coverage_analysis
jerboa_doc
jerboa_document_symbols
jerboa_dynamic_reference
jerboa_error_fix_add
jerboa_error_fix_lookup
jerboa_error_hierarchy
jerboa_eval
jerboa_event_system_guide
jerboa_example_api_coverage
jerboa_exe_macro_check
jerboa_expand_macro
jerboa_explain_error
jerboa_export_reexport_conflicts
jerboa_ffi_buffer_size_audit
jerboa_ffi_callback_debug
jerboa_ffi_inspect
jerboa_ffi_link_check
jerboa_ffi_null_safety
jerboa_ffi_scaffold
jerboa_ffi_type_check
jerboa_ffi_utf8_byte_length_audit
jerboa_file_summary
jerboa_find_callers
jerboa_find_definition
jerboa_format
jerboa_function_behavior
jerboa_function_signature
jerboa_generate_api_docs
jerboa_generate_module
jerboa_generate_module_stub
jerboa_graceful_shutdown_scaffold
jerboa_heap_profile
jerboa_howto
jerboa_howto_add
jerboa_howto_get
jerboa_howto_run
jerboa_howto_verify
jerboa_httpd_handler_scaffold
jerboa_interface_compliance_check
jerboa_lint
jerboa_list_features
jerboa_list_std_modules
jerboa_load_file
jerboa_macro_expansion_size
jerboa_macro_hygiene_check
jerboa_macro_pattern_detector
jerboa_macro_template_library
jerboa_make
jerboa_method_dispatch_audit
jerboa_migration_check
jerboa_module_catalog
jerboa_module_deps
jerboa_module_exports
jerboa_module_quickstart
jerboa_package_info
jerboa_parser_grammar_scaffold
jerboa_pattern_cache_check
jerboa_port_fd_inspector
jerboa_pre_add_symbol_check
jerboa_preflight_check
jerboa_profile
jerboa_project_dep_graph
jerboa_project_health_check
jerboa_project_info
jerboa_project_map
jerboa_project_template
jerboa_read_forms
jerboa_rename_symbol
jerboa_repl_session
jerboa_resolve_imports
jerboa_return_type_analysis
jerboa_run_tests
jerboa_scaffold
jerboa_scaffold_test
jerboa_security_pattern_add
jerboa_security_scan
jerboa_sigchld_check
jerboa_signal_trace
jerboa_signature_impact
jerboa_smart_complete
jerboa_splice_form
jerboa_stack_trace_decode
jerboa_stale_static
jerboa_stdlib_source
jerboa_suggest_feature
jerboa_suggest_imports
jerboa_sxml_inspect
jerboa_tail_position_check
jerboa_test_assertion_audit
jerboa_test_coverage
jerboa_test_fixture_gen
jerboa_trace_calls
jerboa_trace_eval
jerboa_trace_macro
jerboa_translate_scheme
jerboa_validate_example_imports
jerboa_verify
jerboa_version
jerboa_vote_feature
jerboa_workspace_symbols
jerboa_wrap_form
```

**Total: ~130 tools** (gerbil-mcp's 150 minus ~20 Gambit/gxpkg-specific tools that don't apply)

---

## Appendix B: Chez Scheme API Reference for Tool Implementors

Key Chez APIs that tools will use internally:

```scheme
;; Module introspection
(library-exports '(std sort))          ;; → list of exported symbols
(library-requirements '(std sort))     ;; → list of imported libraries

;; Procedure inspection
(procedure? obj)
(procedure-arity-mask proc)            ;; bitmask: bit N set = accepts N args
                                       ;; negative = accepts arbitrarily many

;; Record/struct inspection
(record? obj)
(record-type-descriptor obj)
(record-type-name rtd)
(record-type-parent rtd)
(record-type-field-names rtd)

;; Expansion
(expand '(form ...))                   ;; fully expand

;; Environment
(environment-symbols env)
(interaction-environment)
(scheme-version)
(machine-type)

;; Compilation
(compile-file "path.ss")
(compile-library "path.sls")
(compile-whole-program "wpo-file" "output")

;; Statistics
(statistics)                           ;; → alist of GC/memory stats
(time expr)                           ;; → timing info to stderr

;; Ports
(port-file-descriptor port)           ;; if available

;; Conditions
(guard (exn [#t (display-condition exn)]) ...)
(condition-message c)
(condition-irritants c)
```

---

## Appendix C: Porting Guide — gerbil-mcp Tool → jerboa-mcp Tool

For each tool being ported:

1. **Copy the `.ts` file** from gerbil-mcp `src/tools/`
2. **Rename:** `gerbil_` prefix → `jerboa_`
3. **Replace subprocess calls:**
   - `runGxi(...)` → `runChez(...)`
   - `runGxc(...)` → `runChez(...)` with `(expand ...)` wrapper
   - `runGxiFile(...)` → `runChezFile(...)`
   - `runGerbilBuild(...)` → `runChezMake(...)` (new helper)
4. **Replace Scheme code in tool:**
   - `(import :std/sort)` → `(import (std sort))` or keep if reader handles it
   - `with-catch` → `guard`
   - `display-exception` → `display-condition`
   - `hash-table?` (Gambit) → `hashtable?` (Chez) for internal checks
   - `module-context-export` → `library-exports`
5. **Replace markers:**
   - `GERBIL-MCP-RESULT:` → `JERBOA-MCP-RESULT:`
6. **Replace env vars:**
   - `GERBIL_HOME` → `JERBOA_HOME`
   - `GERBIL_LOADPATH` → `--libdirs` argument
7. **Update annotations** (readOnlyHint, idempotentHint)
8. **Update INSTRUCTIONS** entry
9. **Write tests**

### Pure TS tools (no porting of Scheme code needed):

These tools are pure TypeScript file analysis — they can be copied nearly verbatim:
- check-balance, balanced-replace, wrap-form, splice-form
- rename-symbol, generate-module
- find-callers, workspace-symbols, document-symbols
- check-duplicates, dead-code, dependency-cycles
- security-scan, security-pattern-add
- howto, howto-add, howto-get (just change prefix)
- suggest-feature, list-features, vote-feature
- macro-pattern-detector, boilerplate-converter
- build-conflict-check, build-progress
- benchmark-compare

That's approximately **30-40 tools** that can be ported with minimal changes (mostly renaming `gerbil_` → `jerboa_` and updating markers).
