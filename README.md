# jerboa-mcp

MCP (Model Context Protocol) server providing live Jerboa Scheme language
intelligence to AI coding assistants. **111 tools** covering evaluation, syntax
checking, compilation, module introspection, security auditing, code
generation, testing, benchmarking, and more.

Jerboa is a Scheme dialect built on [Chez Scheme](https://cisco.github.io/ChezScheme/).
The MCP server runs Chez Scheme in subprocesses to execute real Jerboa code,
introspect modules, and provide accurate, live answers rather than relying on
static knowledge.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Start the server
npm start
```

### Claude Code

Add to your Claude Code `settings.json`:

```json
{
  "mcpServers": {
    "jerboa": {
      "command": "node",
      "args": ["/path/to/jerboa-mcp/dist/index.js"]
    }
  }
}
```

### OpenCode

OpenCode reads MCP configuration from `opencode.json` files. Configuration is merged from multiple sources in priority order:

1. **Global config**: `~/.config/opencode/opencode.json`
2. **Project-local config**: `opencode.json` in the project root (or walked up from cwd)
3. **Project `.opencode/` directory**: `.opencode/opencode.json`

#### Global setup (all projects)

Create or edit `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "jerboa": {
      "type": "local",
      "command": ["node", "/absolute/path/to/jerboa-mcp/dist/index.js"]
    }
  }
}
```

#### Project-local setup (single project)

Create `opencode.json` in your project root:

```json
{
  "mcp": {
    "jerboa": {
      "type": "local",
      "command": ["node", "/absolute/path/to/jerboa-mcp/dist/index.js"]
    }
  }
}
```

To verify the configuration is loaded, run `opencode debug config` and check that the `mcp` section includes the `jerboa` entry.

To auto-load Jerboa-specific instructions, copy the example file to your project:

```sh
mkdir -p .opencode
cp /path/to/jerboa-mcp/CLAUDE.md.jerboa-example .opencode/AGENTS.md
```

Or for global instructions across all projects:

```sh
cp /path/to/jerboa-mcp/CLAUDE.md.jerboa-example ~/.config/opencode/AGENTS.md
```

### Other MCP clients

Any MCP-compatible client can connect using the stdio transport. The server reads JSON-RPC from stdin and writes to stdout:

```sh
node /path/to/jerboa-mcp/dist/index.js
```

## Tool Categories

| Category | Count | Examples |
|---|---|---|
| Core Evaluation | 5 | `eval`, `check_syntax`, `compile_check`, `batch_syntax_check`, `verify` |
| Module Introspection | 12 | `module_exports`, `function_signature`, `class_info`, `describe` |
| Navigation & Discovery | 10 | `find_definition`, `find_callers`, `document_symbols`, `apropos` |
| Code Quality & Linting | 12 | `lint`, `dead_code`, `check_arity`, `check_exports`, `check_duplicates` |
| Security Auditing | 5 | `security_scan`, `security_audit`, `import_policy_check`, `unsafe_import_lint` |
| Safe-by-Default | 3 | `safe_prelude_check`, `resource_leak_check`, `safe_prelude_generate` |
| Build & Test | 7 | `make`, `build_and_report`, `run_tests`, `benchmark`, `stale_static` |
| Static Builds & FFI | 6 | `ffi_scaffold`, `ffi_type_check`, `rust_musl_build`, `static_symbol_audit` |
| Macro Development | 6 | `expand_macro`, `trace_macro`, `macro_hygiene_check`, `macro_expansion_size` |
| Refactoring | 8 | `rename_symbol`, `balanced_replace`, `wrap_form`, `splice_form` |
| Code Generation | 7 | `generate_module`, `scaffold_test`, `project_template`, `httpd_handler_scaffold` |
| Cookbook & Recipes | 5 | `howto`, `howto_add`, `howto_get`, `howto_run`, `howto_verify` |
| Cross-Platform | 2 | `sandbox_parity`, `boot_library_audit` |
| Debugging | 4 | `command_trace`, `signal_trace`, `bisect_crash`, `stack_trace_decode` |
| Project Context | 5 | `project_info`, `project_map`, `project_dep_graph`, `project_health_check` |
| Performance | 4 | `profile`, `heap_profile`, `trace_calls`, `benchmark_compare` |
| Documentation | 4 | `doc`, `generate_api_docs`, `dynamic_reference`, `module_catalog` |
| Translation | 2 | `translate_scheme`, `migration_check` |
| Certificates | 1 | `mtls_cert_generate` |
| Features | 3 | `suggest_feature`, `vote_feature`, `list_features` |
| Environment | 2 | `version`, `preflight_check` |

All tool names are prefixed with `jerboa_`.

## Common Workflows

**Write new code:**
`howto` → `module_exports` → write code → `verify` → `security_scan`

**Debug an error:**
`explain_error` → follow suggestions → `howto` for fix patterns

**Understand unfamiliar code:**
`file_summary` → `document_symbols` → `module_deps`

**Audit project quality:**
`verify` → `lint` → `dead_code` → `dependency_cycles`

**Security review:**
`security_audit` → `import_policy_check` → `unsafe_import_lint` → `resource_leak_check`

**Static build (Rust FFI):**
`rust_musl_build` → `static_symbol_audit` → `boot_library_audit`

## Project Structure

```
jerboa-mcp/
├── src/
│   ├── index.ts          — Server entry point; registers all tools
│   ├── chez.ts           — Chez Scheme subprocess layer
│   ├── tools/            — Tool implementations (one file per tool)
│   └── resources/        — Static reference docs (MCP resources)
├── dist/                 — Compiled output (generated)
├── cookbooks.json        — Cookbook recipes (jerboa_howto_add)
├── error-fixes.json      — Error fix database (jerboa_error_fix_add)
├── security-rules.json   — Custom security patterns
├── features.json         — Feature suggestions and votes
├── package.json
└── tsconfig.json
```

## Development

```bash
npm run build        # Compile TypeScript + copy resources
npm test             # Run tests (vitest)
npm run dev          # Watch mode (recompile on save)
npm start            # Start the MCP server
```

Always run `npm run build` after any `.ts` change before testing.

### Adding a Tool

1. Create `src/tools/tool-name.ts` exporting `registerToolNameTool(server)`
2. Import and call it in `src/index.ts`
3. Update the `INSTRUCTIONS` string in `src/index.ts`
4. Run `npm run build`

See [CLAUDE.md](CLAUDE.md) for detailed development instructions.

## AI Assistant Integration

This server includes example configuration files for AI coding assistants:

- **`CLAUDE.md.jerboa-example`** — Example Claude Code instructions
- **`copilot-instructions.md.jerboa-example`** — Example GitHub Copilot instructions

Copy and adapt these to your Jerboa project for optimal AI assistance.

## License

ISC
