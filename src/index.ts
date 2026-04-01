#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerEvalTool } from './tools/eval.js';
import { registerCheckSyntaxTool } from './tools/check-syntax.js';
import { registerCompileCheckTool } from './tools/compile-check.js';
import { registerBatchSyntaxCheckTool } from './tools/batch-syntax-check.js';
import { registerVerifyTool } from './tools/verify.js';
import { registerVersionTool } from './tools/version.js';
import { registerPreflightCheckTool } from './tools/preflight-check.js';
import { registerModuleExportsTool } from './tools/module-exports.js';
import { registerFunctionSignatureTool } from './tools/function-signature.js';
import { registerModuleDepsTool } from './tools/module-deps.js';
import { registerExpandMacroTool } from './tools/expand-macro.js';
import { registerDescribeTool } from './tools/describe.js';
import { registerReplSessionTool } from './tools/repl-session.js';
import { registerRunTestsTool } from './tools/run-tests.js';
import { registerMakeTool } from './tools/make.js';
import { registerBuildAndReportTool } from './tools/build-and-report.js';
import { registerBuildConflictCheckTool } from './tools/build-conflict-check.js';
import { registerStdlibSourceTool } from './tools/stdlib-source.js';
import { registerBisectCrashTool } from './tools/bisect-crash.js';
import { registerStackTraceDecodeTool } from './tools/stack-trace-decode.js';
import { registerSecurityScanTool } from './tools/security-scan.js';
import { registerSecurityPatternAddTool } from './tools/security-pattern-add.js';
import { registerExplainErrorTool } from './tools/explain-error.js';
import { registerLintTool } from './tools/lint.js';
import { registerDeadCodeTool } from './tools/dead-code.js';
import { registerDependencyCyclesTool } from './tools/dependency-cycles.js';
import { registerHowtoTool } from './tools/howto.js';
import { registerHowtoAddTool } from './tools/howto-add.js';
import { registerHowtoGetTool } from './tools/howto-get.js';
import { registerHowtoRunTool } from './tools/howto-run.js';
import { registerHowtoVerifyTool } from './tools/howto-verify.js';
import { registerRenameSymbolTool } from './tools/rename-symbol.js';
import { registerBalancedReplaceTool } from './tools/balanced-replace.js';
import { registerWrapFormTool } from './tools/wrap-form.js';
import { registerSpliceFormTool } from './tools/splice-form.js';
import { registerCheckBalanceTool } from './tools/check-balance.js';
import { registerFormatTool } from './tools/format.js';
import { registerFindCallersTool } from './tools/find-callers.js';
import { registerDocumentSymbolsTool } from './tools/document-symbols.js';
import { registerWorkspaceSymbolsTool } from './tools/workspace-symbols.js';
import { registerFileSummaryTool } from './tools/file-summary.js';
import { registerSuggestFeatureTool } from './tools/suggest-feature.js';
import { registerListFeaturesTool } from './tools/list-features.js';
import { registerVoteFeatureTool } from './tools/vote-feature.js';
import { registerProjectInfoTool } from './tools/project-info.js';
import { registerCheckExportsTool } from './tools/check-exports.js';
import { registerCheckImportConflictsTool } from './tools/check-import-conflicts.js';
import { registerReadFormsTool } from './tools/read-forms.js';
import { registerProjectDepGraphTool } from './tools/project-dep-graph.js';
import { registerAproposTool } from './tools/apropos.js';
import { registerSuggestImportsTool } from './tools/suggest-imports.js';
import { registerBenchmarkTool } from './tools/benchmark.js';
import { registerBenchmarkCompareTool } from './tools/benchmark-compare.js';
import { registerProfileTool } from './tools/profile.js';
import { registerProjectMapTool } from './tools/project-map.js';
import { registerTestCoverageTool } from './tools/test-coverage.js';
import { registerDiffModulesTool } from './tools/diff-modules.js';
import { registerDynamicReferenceTool } from './tools/dynamic-reference.js';
import { registerModuleQuickstartTool } from './tools/module-quickstart.js';
import { registerGenerateApiDocsTool } from './tools/generate-api-docs.js';
import { registerScaffoldTestTool } from './tools/scaffold-test.js';
import { registerGenerateModuleStubTool } from './tools/generate-module-stub.js';
import { registerGenerateModuleTool } from './tools/generate-module.js';
import { registerCheckArityTool } from './tools/check-arity.js';
import { registerProjectTemplateTool } from './tools/project-template.js';
import { registerHttpdHandlerScaffoldTool } from './tools/httpd-handler-scaffold.js';
import { registerActorEnsembleScaffoldTool } from './tools/actor-ensemble-scaffold.js';
import { registerDbPatternScaffoldTool } from './tools/db-pattern-scaffold.js';
import { registerGracefulShutdownScaffoldTool } from './tools/graceful-shutdown-scaffold.js';
import { registerTranslateSchemeTool } from './tools/translate-scheme.js';
import { registerListModulesTool } from './tools/list-modules.js';
import { registerLoadFileTool } from './tools/load-file.js';
import { registerDocTool } from './tools/doc.js';
import { registerClassInfoTool } from './tools/class-info.js';
import { registerFindDefinitionTool } from './tools/find-definition.js';
import { registerCheckDuplicatesTool } from './tools/check-duplicates.js';
import { registerErrorFixLookupTool } from './tools/error-fix-lookup.js';
import { registerErrorFixAddTool } from './tools/error-fix-add.js';
import { registerSmartCompleteTool } from './tools/smart-complete.js';
import { registerErrorHierarchyTool } from './tools/error-hierarchy.js';
import { registerModuleCatalogTool } from './tools/module-catalog.js';
import { registerTraceEvalTool } from './tools/trace-eval.js';
import { registerHeapProfileTool } from './tools/heap-profile.js';
import { registerTraceCallsTool } from './tools/trace-calls.js';
import { registerTraceMacroTool } from './tools/trace-macro.js';
import { registerMacroExpansionSizeTool } from './tools/macro-expansion-size.js';
import { registerFfiScaffoldTool } from './tools/ffi-scaffold.js';
import { registerFfiTypeCheckTool } from './tools/ffi-type-check.js';
import { registerFfiNullSafetyTool } from './tools/ffi-null-safety.js';
import { registerMigrationCheckTool } from './tools/migration-check.js';
import { registerMacroHygieneCheckTool } from './tools/macro-hygiene-check.js';
import { registerMacroPatternDetectorTool } from './tools/macro-pattern-detector.js';
import { registerBoilerplateConverterTool } from './tools/boilerplate-converter.js';
import { registerMacroTemplateLibraryTool } from './tools/macro-template-library.js';
import { registerSignalTraceTool } from './tools/signal-trace.js';
import { registerEventSystemGuideTool } from './tools/event-system-guide.js';
import { registerStaleStaticTool } from './tools/stale-static.js';
import { registerProjectHealthCheckTool } from './tools/project-health-check.js';
import { registerPackageInfoTool } from './tools/package-info.js';
import { registerSecurityAuditTool } from './tools/security-audit.js';
import { registerImportPolicyCheckTool } from './tools/import-policy-check.js';
import { registerUnsafeImportLintTool } from './tools/unsafe-import-lint.js';
import { registerRustMuslBuildTool } from './tools/rust-musl-build.js';
import { registerStaticSymbolAuditTool } from './tools/static-symbol-audit.js';
import { registerBootLibraryAuditTool } from './tools/boot-library-audit.js';
import { registerSafePreludeCheckTool } from './tools/safe-prelude-check.js';
import { registerResourceLeakCheckTool } from './tools/resource-leak-check.js';
import { registerSafePreludeGeneratorTool } from './tools/safe-prelude-generator.js';
import { registerSandboxParityTool } from './tools/sandbox-parity.js';
import { registerMtlsCertGenerateTool } from './tools/mtls-cert-generate.js';
import { registerCommandTraceTool } from './tools/command-trace.js';
import { registerVerifyStaticBinaryTool } from './tools/verify-static-binary.js';

const INSTRUCTIONS = `You have access to a live Jerboa Scheme environment via this MCP server. Use these tools proactively when working with Jerboa Scheme code.

Jerboa is a Chez Scheme-based dialect. Your training data for Jerboa is extremely limited — ALWAYS verify APIs, module names, and function signatures with live tools rather than guessing.

## Essential Tools (Always Use First)

- BEFORE writing ANY Jerboa code: use jerboa_howto to search the cookbook for relevant patterns. The cookbook contains verified, working examples with correct imports and idioms accumulated from real sessions. Search with the module/task name (e.g. "json parse", "hash iterate", "sort list", "string split"). Skipping this step risks bugs that are already documented.
- BEFORE finalizing code involving FFI, shell commands, or file I/O: run jerboa_security_scan on the file or project. It detects shell injection, type mismatches, resource leaks, and unsafe patterns with severity and remediation guidance.
- BEFORE writing Jerboa code: use jerboa_module_exports to check what a module actually exports. Never guess function names. Module paths use (std ...) form: (std sort), (std text json), (std misc string).
- BEFORE suggesting code: use jerboa_check_syntax to verify syntactic validity. Use jerboa_batch_syntax_check to check multiple snippets in one call.
- BEFORE calling Jerboa functions: use jerboa_function_signature to check procedure arities and keyword arguments. Prevents wrong-number-of-arguments errors.
- When UNSURE about Jerboa behavior: use jerboa_eval to test expressions interactively. Use the imports parameter to bring modules into scope (e.g. ["(std sort)", "(std text json)"]).
- To catch compilation errors: use jerboa_compile_check to run the compiler and detect unbound identifiers and type issues.
- To run test suites: use jerboa_run_tests to execute a test file or run project-wide tests. Use filter to match test names.
- To run Makefile targets: use jerboa_make to build, test, or clean in a project directory.

## Module System

- Module paths use (std ...) form: (std sort), (std text json), (std misc string)
- The :std/... syntax is also accepted and auto-normalized: :std/sort, :std/text/json
- Import with (import (std sort)) or (import :std/sort) — both work
- Use jerboa_list_modules to discover available standard library modules
- Use jerboa_suggest_imports to find which module exports a given symbol
- Use jerboa_module_deps to understand a module's import dependencies
- Use jerboa_apropos to search for symbols by substring when unsure of exact names

## Jerboa Language Notes

- Jerboa reader handles [...] for list literals, {...} for hash table literals, keyword: syntax for keyword args
- eval tool handles Jerboa reader extensions automatically
- Error handling: use guard for condition-based handling (Chez Scheme style); try/catch is also provided by Jerboa prelude
- Run scripts with: scheme --libdirs JERBOA_HOME/lib --script file.ss
- Tail calls are optimized; use jerboa_tail_position_check equivalent patterns when recursing

## Cookbook Tools

- jerboa_howto: Search curated Jerboa idioms by keyword with synonym expansion and fuzzy matching. Returns verified, working examples. Use compact: true then jerboa_howto_get by id to save tokens.
- jerboa_howto_get: Fetch a single recipe by its ID. Returns full code, imports, and notes.
- jerboa_howto_add: Save new recipes to the cookbook (available across all sessions). Requires id, title, tags, imports, code. Same-id replaces existing.
- jerboa_howto_run: Compile-check and optionally execute a cookbook recipe by ID. Validates that the recipe's code and imports produce valid Jerboa before running.
- jerboa_howto_verify: Batch-verify cookbook recipes for syntax and compilation validity. Use to maintain cookbook quality.

## Analysis and Quality Tools

- jerboa_lint: Static analysis — unused imports, duplicate defs, shadowed bindings, hash literal keys, missing exports, port-type mismatches, and more.
- jerboa_check_arity: Detect functions called with the wrong number of arguments across a project.
- jerboa_dead_code: Find unexported, uncalled definitions across a project.
- jerboa_dependency_cycles: Detect circular module imports using DFS cycle detection.
- jerboa_check_exports: Cross-module export/import consistency checker. Detects symbols exported but not defined.
- jerboa_check_import_conflicts: Detect import conflicts before build. Finds local-def vs import conflicts and cross-import collisions. Suggests (only-in)/(except-in) fixes.
- jerboa_check_duplicates: Fast pre-build check for duplicate top-level defs. Catches rebind conflicts before compilation.
- jerboa_verify: Combined syntax + compile + lint + arity + duplicate check in one pass. Returns unified issue list. Use this as the standard "is my code ok?" workflow.
- jerboa_diff_modules: Compare exports between two modules — added, removed, and shared symbols. Useful for version migration.
- jerboa_test_coverage: Compare a module's exports against its test file to identify untested symbols.
- jerboa_explain_error: Classify Jerboa/Chez error messages with likely causes, suggested fixes, and relevant cookbook recipes.

## Macro Analysis Tools

- jerboa_expand_macro: See the fully expanded core form of a macro expression.
- jerboa_trace_macro: Step-by-step macro expansion showing each transformation level. Uses expand-once in a loop.
- jerboa_macro_expansion_size: Analyze macro expansion size — warns when ratio exceeds 10x or 50x.
- jerboa_macro_hygiene_check: Detect free variable capture in defrule/define-syntax macro definitions.
- jerboa_macro_pattern_detector: Find repetitive code patterns that could be replaced with macros. Detects accessors, method wrappers, and similar function structures.
- jerboa_boilerplate_converter: Convert 2+ similar expressions into a macro definition automatically. Extracts the common pattern and generates a defrule.
- jerboa_macro_template_library: Generate reusable macro templates. Supports: hash-accessors, method-delegation, validation-guards, enum-constants, event-handlers, type-setters.
- jerboa_signal_trace: Generate signal handling instrumentation code for debugging SIGINT/SIGTERM/SIGHUP delivery.

## Navigation and Discovery

- jerboa_document_symbols: List all definitions in a file with name, kind, and line number.
- jerboa_workspace_symbols: Search for symbol definitions across all project files.
- jerboa_find_callers: Find all files that reference a given symbol, with line numbers.
- jerboa_find_definition: Locate where a symbol is defined (source file, kind, arity). Use source_preview: true for code preview.
- jerboa_file_summary: Quick structural overview — imports, exports, and definitions — without reading the whole file.
- jerboa_project_info: Single-call project summary: package name, build targets, source files, and external dependencies.
- jerboa_project_map: Complete view of all modules with exports, definitions by kind, and import dependencies.
- jerboa_project_dep_graph: Visualize project module dependency tree as ASCII art.
- jerboa_load_file: Parse a .ss file to extract imports, exports, and definitions without executing it.
- jerboa_read_forms: Read a file with the actual Jerboa reader and see each form's line range and summary.
- jerboa_doc: Look up any symbol for type, arity, qualified name, and related symbols.
- jerboa_describe: Evaluate an expression and describe the resulting value's type, structure, and contents. Shows hash table entries, list length, vector elements, string length, number type, etc.
- jerboa_class_info: Inspect defclass/defstruct types — slots, fields, inheritance, precedence list, and exact constructor signature.
- jerboa_apropos: Search for symbols by substring when unsure of exact names.
- jerboa_list_modules: Discover available standard library modules, optionally filtered by prefix.
- jerboa_dynamic_reference: Auto-generate reference documentation for any Jerboa module on demand. Introspects all exports and classifies them.
- jerboa_module_quickstart: Generate a working example file that exercises a module's main exports. Useful for undocumented modules.

## REPL and Interactive Tools

- jerboa_repl_session: Maintain persistent state across evaluations. Define functions, import modules, test incrementally. Use preload_file to load a file's imports into the session automatically.
- jerboa_eval: Evaluate a single expression. Use imports parameter to bring modules into scope. Use env parameter for library paths (e.g. LD_LIBRARY_PATH).

## Profiling and Tracing

- jerboa_benchmark: Measure wall-clock time, CPU time, GC stats, and memory allocation.
- jerboa_benchmark_compare: Run benchmarks, save as named baseline, compare with previous runs.
- jerboa_profile: Instrument specific functions with call counting and timing.
- jerboa_trace_eval: Step through let*/let/letrec binding sequences showing each variable value as it is bound.
- jerboa_heap_profile: Capture GC heap metrics before and after evaluating an expression.
- jerboa_trace_calls: Lightweight call counting for named functions during expression evaluation.

## Build and Compilation

- jerboa_build_and_report: Run "make build" and parse output for structured error diagnostics (file, line, severity).
- jerboa_build_conflict_check: Detect running Chez/make processes on the same project directory.
- jerboa_make: Run Makefile targets in a project directory.
- jerboa_stale_static: Compare compiled .so artifact mtimes against source .sls files. Reports stale artifacts.
- jerboa_run_tests: Execute test files via scheme or run project-wide tests. Use filter to match test names.

## FFI Tools

- jerboa_ffi_scaffold: Parse a C header file and generate Jerboa FFI bindings using foreign-procedure and load-shared-object.
- jerboa_ffi_type_check: Detect type mismatches between foreign-procedure declarations and call sites.
- jerboa_ffi_null_safety: Find foreign-procedure pointer parameters dereferenced without null checks.

## Error Lookup

- jerboa_error_fix_lookup: Instant fix lookup from error-fixes.json for known error patterns. Faster than explain_error.
- jerboa_error_fix_add: Add new error→fix mappings to the database.
- jerboa_error_hierarchy: Display the full R6RS/Chez condition type hierarchy tree.
- jerboa_stack_trace_decode: Parse Chez error output into structured form with type, message, irritants, and suggestions.
- jerboa_bisect_crash: Binary-search a crashing file to find the minimal set of forms that reproduce the crash.

## Project Health

- jerboa_project_health_check: Composite project audit — balance, export consistency, circular imports, duplicates. Returns health score.
- jerboa_package_info: List available Jerboa/Chez extension packages and their installation status.

## Migration

- jerboa_migration_check: Scan Gerbil source files for patterns needing Jerboa adaptation. Detects (export #t), ## primitives, gxi/gxc, :gerbil/ imports.
- jerboa_translate_scheme: Translate R7RS, Racket, or Gerbil code to idiomatic Jerboa (~40 rules).

## Completion

- jerboa_smart_complete: Return valid symbol completions for a partial prefix from the Jerboa environment.
- jerboa_module_catalog: Compact reference of all exports from a module with kind, arity, and descriptions.
- jerboa_stdlib_source: Read the source code of any Jerboa stdlib module (e.g., (std sort) → lib/std/sort.sls).

## Events and Concurrency

- jerboa_event_system_guide: Interactive guide for channel, thread, mutex, promises, timers, and process patterns.

## Macro Tools

- jerboa_check_balance: Fast paren/bracket/brace balance checking without spawning a subprocess.

## Refactoring and Code Generation

- jerboa_rename_symbol: Rename a symbol across all project files or a single file. Uses word-boundary detection to avoid partial matches. Dry-run by default.
- jerboa_balanced_replace: Like Edit/string-replace but validates delimiter balance before and after. Rejects edits that would break balance.
- jerboa_wrap_form: Wrap lines in a new Scheme form (e.g. when, let, begin) with guaranteed matching parentheses. Auto-detects form boundaries when end_line is omitted.
- jerboa_splice_form: Remove a wrapper form while keeping selected children (inverse of wrap). Child indices are 1-based.
- jerboa_format: Pretty-print Jerboa expressions.
- jerboa_generate_module_stub: Generate a module skeleton matching another module's exported signatures.
- jerboa_generate_module: Create new modules by applying word-boundary-aware substitutions to a template file.
- jerboa_scaffold_test: Generate a test skeleton from a module's exports.
- jerboa_generate_api_docs: Generate markdown API documentation from a module's exports.

## Scaffolding

- jerboa_project_template: Generate a complete Jerboa project from templates (cli, http-api, library, actor-service, db-crud, parser, ffi-wrapper, test-project). Creates package config, build scripts, source modules, and test files.
- jerboa_httpd_handler_scaffold: Generate HTTP server code from route specifications. Produces handler functions, routing setup, and middleware patterns.
- jerboa_actor_ensemble_scaffold: Generate distributed actor project template with multiple actor types, message protocols, and supervision trees.
- jerboa_db_pattern_scaffold: Generate database CRUD patterns with connection pooling for SQLite or PostgreSQL.
- jerboa_graceful_shutdown_scaffold: Generate signal handling and cleanup patterns with optional actor system integration.

## Security Tools

- jerboa_security_scan: Static security scanner. Detects shell injection, FFI type mismatches, missing unwind-protect, unsafe patterns. Reports severity, line, and remediation. Scans single file (file_path) or project (project_path). Filter by severity_threshold. Supports inline suppression: ; jerboa-security: suppress <rule-id>.
- jerboa_security_pattern_add: Add custom security detection rules. Requires id, title, severity, scope, pattern (regex), message, and remediation.
- jerboa_security_audit: Jerboa-specific security auditor that understands Jerboa's security modules (taint, capability, restrict, sanitize, privsep). Detects sanitizer context misuse, missing taint checks at sinks, bare read without read-eval #f, copy-environment without restrict, eval of user input, SQL injection, path traversal, and resource leaks. More Jerboa-aware than the generic security_scan.
- jerboa_import_policy_check: Build-time check that scans .ss files for forbidden imports (direct (chezscheme), inline foreign-procedure, load-shared-object, shell interpolation). Reports violations with file, line, and clear remediation. Excludes .sls library files by default.
- jerboa_unsafe_import_lint: Lint pass that warns on raw/unsafe module imports and suggests safe alternatives. Detects (std db sqlite-native), (std net tcp-raw), inline foreign-procedure, bare (error ...), fork-thread, and more. Suggests (std safe) wrappers, structured concurrency, and structured conditions.

## Safe-by-Default Tools

- jerboa_safe_prelude_check: Checks whether a project uses safe APIs by default. Scans for uses of unsafe functions (sqlite-open, tcp-connect, open-input-file, foreign-procedure, system) and reports where safe alternatives exist from (std safe).
- jerboa_resource_leak_check: Static analysis for resource leaks. Detects resource-acquiring calls not protected by with-resource, unwind-protect, dynamic-wind, or call-with-* patterns. Checks sqlite-open, tcp-connect, open-input-file, duckdb-open, mutex-acquire, and more.
- jerboa_safe_prelude_generate: Generates a safe-by-default prelude module that re-exports safe wrappers under the original names. Given (std safe) module, strips "safe-" prefixes and generates a library with define aliases. Excludes dangerous exports like foreign-procedure.

## Static Build Tools

- jerboa_rust_musl_build: Automates building Rust static libraries for the musl target. Detects rustup toolchain, verifies target installation, sets CC=musl-gcc, runs cargo build. Reports output .a path. Use when integrating Rust crates into Chez static binaries.
- jerboa_static_symbol_audit: Cross-references Sforeign_symbol() registration calls in C entry points against actual symbols from linked .a/.o files (via nm). Detects missing registrations (causes runtime "foreign-procedure not found") and dead registrations.
- jerboa_boot_library_audit: Audits a Chez static build script's library list against the transitive import closure. Detects missing libraries (causes runtime "library not found") and dead-weight libraries (increase binary size without being used).

## Cross-Platform Tools

- jerboa_sandbox_parity: Compares sandbox capabilities across Linux (seccomp/Landlock), FreeBSD (Capsicum), and macOS (Seatbelt) by introspecting actual module exports. Reports feature parity gaps and platform-specific capabilities.
- jerboa_mtls_cert_generate: Generates self-signed Ed25519 (or RSA/EC) certificate and private key for mTLS testing. Returns file paths and example Jerboa code for rustls-server-ctx-new-mtls and rustls-connect-mtls.

## Debugging Tools

- jerboa_command_trace: Traces the dispatch path for a given editor command. Analyzes cmd-* function definitions to show cond/match branches, predicates tested, and which branch fires for a given buffer type. Helps diagnose "why does command X do nothing?" issues.

## Feature Tracking

- jerboa_suggest_feature: Submit a feature suggestion for future tooling improvements.
- jerboa_list_features: Search or list existing feature suggestions. Use before suggesting to check for duplicates. Shows vote counts.
- jerboa_vote_feature: Vote for an existing feature suggestion by ID. Use when you encounter a situation where a suggested feature would have saved time.

## Common Workflows

- **Write new code**: jerboa_howto → jerboa_module_exports → write code → jerboa_verify → jerboa_security_scan
- **Debug an error**: jerboa_explain_error → follow suggested tools → jerboa_howto for fix patterns
- **Understand unfamiliar code**: jerboa_file_summary → jerboa_document_symbols → jerboa_module_deps
- **Port from Racket/R7RS**: jerboa_translate_scheme → jerboa_verify → jerboa_suggest_imports → manual review
- **Refactor a module**: jerboa_check_exports → jerboa_find_callers → jerboa_rename_symbol → jerboa_check_import_conflicts
- **Add a feature**: jerboa_howto → write code → jerboa_check_syntax → jerboa_compile_check → jerboa_make
- **Start new project**: jerboa_project_template → make build → make test
- **Explore unknown module**: jerboa_module_quickstart → jerboa_dynamic_reference → jerboa_howto
- **Audit project quality**: jerboa_verify → jerboa_lint → jerboa_dead_code → jerboa_dependency_cycles
- **Find imports for symbols**: jerboa_suggest_imports → jerboa_module_exports → jerboa_eval to confirm
- **Debug a crash**: jerboa_stale_static → jerboa_bisect_crash → jerboa_ffi_type_check
- **Build project**: jerboa_build_conflict_check → jerboa_make → jerboa_build_and_report
- **Security audit**: jerboa_security_audit → jerboa_import_policy_check → jerboa_unsafe_import_lint
- **Static build audit**: jerboa_static_symbol_audit → jerboa_boot_library_audit → jerboa_rust_musl_build
- **Safe-by-default check**: jerboa_safe_prelude_check → jerboa_resource_leak_check → jerboa_safe_prelude_generate
- **Debug editor command**: jerboa_command_trace with project_path and buffer_type
- **Port from Gerbil**: jerboa_migration_check → jerboa_translate_scheme → jerboa_verify → jerboa_check_syntax
- **Check project health**: jerboa_project_health_check → fix issues → jerboa_build_and_report
- **Learn a module**: jerboa_stdlib_source → jerboa_module_catalog → jerboa_module_quickstart
- **Debug error**: jerboa_error_fix_lookup → jerboa_explain_error → jerboa_stack_trace_decode
- **Write macros**: jerboa_howto "defrule" → write macro → jerboa_macro_hygiene_check → jerboa_macro_expansion_size

## Important Guidance

- Never guess Jerboa/Chez APIs — always verify with live tools
- Module paths use (std ...) form: (std sort), (std text json), (std misc string)
- Import with :std/sort is also accepted and auto-normalized
- Jerboa reader handles [...], {...}, keyword: syntax; eval tool handles this automatically
- Error handling: use guard not try/catch (though try/catch is provided by jerboa prelude)
- Run with: scheme --libdirs JERBOA_HOME/lib --script file.ss
- Don't guess function names — use jerboa_module_exports to verify
- Don't assume arity — use jerboa_function_signature to check
- Don't skip the cookbook — use jerboa_howto before writing code
- Jerboa is a niche Scheme dialect with limited training data — always verify with live tools

## CRITICAL: Gerbil vs Jerboa API Differences

Your training data conflates Gerbil Scheme and Jerboa. These are DIFFERENT. You MUST use the Jerboa names:

### Hash Tables (from (jerboa prelude) or (jerboa runtime))
- hash-set! → USE hash-put!
- hash-delete! → USE hash-remove!
- hash-contains? → USE hash-key?
- hash-ref (2 args) → USE hash-get (returns #f if missing) or hash-ref (3 args with default)
- make-equal-hashtable → USE make-hash-table
- make-eqv-hashtable → USE make-hash-table-eq
- hash-table-set! → USE hash-put!
- hashtable-set! → USE hash-put! (Chez name exists but prelude wraps it)

### Strings
- read-line → USE get-line — (chezscheme) built-in
- string-split (without import) → MUST import from (std misc string)
- string-join (without import) → MUST import from (std misc string)

### Processes
- open-process → USE open-process-ports — (chezscheme) built-in, returns 4 values
- process-status → USE process-port-status — (std misc process)
- process-pid → USE process-port-pid — (std misc process)

### Threading
- thread-sleep! → exists in (std misc thread) but Chez native is (sleep (make-time 'time-duration ns s))
- make-thread → USE fork-thread (chezscheme) or spawn (std misc thread)
- mutex-lock! → USE mutex-acquire — (chezscheme)
- mutex-unlock! → USE mutex-release — (chezscheme)

### Error Handling
- Error? → USE condition?
- error-exception? → USE condition?
- with-catch handler thk → USE try/catch (prelude) or guard
- time->seconds → USE time-second

### Other Common Mistakes
- (void exn) → USE (lambda _ (void)) — Chez void takes 0 args!
- (bytevector-copy bv 0 n) → USE (subbytevector bv 0 n) — bytevector-copy is 1-arg in R6RS
- (export #t) → USE (export sym1 sym2 ...) — must enumerate exports
- Gerbil keyword args at call site → USE positional optionals — Jerboa def doesn't support keyword: at call sites

## Quick Import Reference

Most common imports and what they provide:

- **(jerboa prelude)** — The kitchen sink: 200+ symbols, all conflicts pre-resolved. USE THIS by default.
- **(std sort)** — sort, sort!, stable-sort, stable-sort!
- **(std misc string)** — string-split, string-join, string-trim, string-prefix?, string-suffix?, string-contains, string-empty?
- **(std misc thread)** — spawn, spawn/name, thread-yield!, thread-sleep!, mutex-lock!, mutex-unlock!, thread-send, thread-receive
- **(std misc process)** — run-process, run-process/batch, open-input-process, process-port-pid
- **(std misc list)** — flatten, unique, group-by, partition, take, drop, zip, frequencies
- **(std misc ports)** — read-all-as-string, read-all-as-lines, read-file-string, write-file-string
- **(std misc func)** — compose, curry, negate, identity, constantly, flip, memo-proc, juxt, partial
- **(std text json)** — read-json, write-json, string->json-object, json-object->string
- **(std csv)** — read-csv, write-csv, csv->alists, alists->csv
- **(std db sqlite)** — sqlite-open, sqlite-close, sqlite-exec, sqlite-eval, sqlite-query
- **(std db duckdb)** — DuckDB in-process OLAP database
- **(std net tcp)** — tcp-listen, tcp-accept, tcp-connect, tcp-close
- **(std net httpd)** — httpd-start, httpd-route, http-respond-json
- **(std os path)** — path-expand, path-normalize, path-join, path-absolute?
- **(std os env)** — getenv, setenv, unsetenv
- **(std crypto digest)** — md5, sha1, sha256, sha512, digest->hex-string
- **(std crypto random)** — random-bytes, random-u64, random-token, random-uuid
- **(std stm)** — make-tvar, atomically, tvar-read, tvar-write!, retry, or-else
- **(std srfi srfi-1)** — iota, filter-map, every, any, fold, reduce, delete-duplicates, take, drop, zip
- **(std srfi srfi-13)** — string-index, string-contains, string-trim, string-pad, string-tokenize
- **(std iter)** — for, for/collect, for/fold, in-list, in-range, in-hash-pairs
- **(std result)** — ok, err, ok?, unwrap, map-ok, and-then, try-result
- **(std datetime)** — datetime-now, parse-datetime, datetime->iso8601, datetime-add, datetime-diff
- **(std sugar)** — ->, ->>, as->, chain, awhen, aif, when-let, cut, dotimes, str, with-resource

## Chez Scheme Gotchas

These are the most common Chez-specific pitfalls:

1. **void takes 0 args**: (void) is correct. (void x) is WRONG. Use (lambda _ (void)) as a discard handler.
2. **bytevector-copy is 1-arg**: R6RS (bytevector-copy bv) copies the whole thing. For slicing, use subbytevector or bytevector-copy! with 5 args.
3. **Multiple return values**: open-process-ports returns 4 VALUES (not a list). Use (let-values ([(to from err pid) (open-process-ports cmd)]) ...).
4. **putenv takes 2 args**: (putenv "NAME" "VALUE"), NOT (putenv "NAME=VALUE").
5. **R6RS body ordering**: ALL definitions must come before expressions in a body. No interleaving.
6. **Record fields are immutable by default**: Use (mutable field-name) in define-record-type to allow mutation.
7. **Record ?-field mutators**: A field named closed? generates mutator record-closed?-set! (keeps the ?).
8. **--script vs --program mode**: In --script mode, forked threads DON'T run between top-level form evaluations. Use --program for concurrent code.
9. **EINTR from GC signals**: Chez's stop-the-world GC sends signals. Blocking syscalls (accept, read, write) can fail with EINTR. Always retry.
10. **GC double-close**: GC finalizers may close ports you already closed, potentially closing a REUSED fd. Use a closed? flag.
11. **(collect) deadlocks**: Never call (collect) while another thread is in a blocking foreign call.
12. **Stale .wpo files**: If compile-whole-program fails with a mysterious error, run make clean first. Stale .wpo files break builds.
13. **Stale daemon processes**: After rebuilding, kill the old daemon. Check /proc/PID/exe for (deleted).
14. **load-shared-object in static binaries**: Crashes at startup. Wrap in (guard ...) with a fallback.
15. **Phase separation**: Macros cannot reference runtime bindings. Use (meta define ...) or (for (module) expand) imports.

## Troubleshooting

- Tool returns empty results → check module path spelling, ensure module is installed
- Module not found → use jerboa_list_modules to discover available modules, check JERBOA_HOME
- REPL session hangs → destroy and recreate, check for infinite loops
- Compile check passes but tests fail → check for stale artifacts, verify module load order
- Wrong function name errors → use jerboa_module_exports to see what's actually exported
`;

const server = new McpServer(
  { name: 'jerboa-mcp', version: '1.0.0' },
  { instructions: INSTRUCTIONS },
);

// Essential tools
registerEvalTool(server);
registerCheckSyntaxTool(server);
registerCompileCheckTool(server);
registerBatchSyntaxCheckTool(server);
registerVerifyTool(server);
registerVersionTool(server);
registerPreflightCheckTool(server);
registerModuleExportsTool(server);
registerFunctionSignatureTool(server);
registerSmartCompleteTool(server);

// Module and dependency tools
registerModuleDepsTool(server);
registerListModulesTool(server);
registerStdlibSourceTool(server);
registerLoadFileTool(server);
registerDocTool(server);
registerAproposTool(server);
registerSuggestImportsTool(server);

// Evaluation and REPL
registerExpandMacroTool(server);
registerDescribeTool(server);
registerReplSessionTool(server);

// Build and test
registerRunTestsTool(server);
registerMakeTool(server);
registerBuildAndReportTool(server);
registerBuildConflictCheckTool(server);

// FFI tools
registerFfiScaffoldTool(server);
registerFfiTypeCheckTool(server);
registerFfiNullSafetyTool(server);

// Security
registerSecurityScanTool(server);
registerSecurityPatternAddTool(server);

// Error handling and debugging
registerExplainErrorTool(server);
registerErrorFixLookupTool(server);
registerErrorFixAddTool(server);
registerErrorHierarchyTool(server);
registerBisectCrashTool(server);
registerStackTraceDecodeTool(server);

// Static analysis
registerLintTool(server);
registerDeadCodeTool(server);
registerDependencyCyclesTool(server);
registerCheckArityTool(server);
registerCheckExportsTool(server);
registerCheckImportConflictsTool(server);
registerCheckDuplicatesTool(server);
registerMigrationCheckTool(server);

// Cookbook
registerHowtoTool(server);
registerHowtoAddTool(server);
registerHowtoGetTool(server);
registerHowtoRunTool(server);
registerHowtoVerifyTool(server);

// Refactoring and editing
registerRenameSymbolTool(server);
registerBalancedReplaceTool(server);
registerWrapFormTool(server);
registerSpliceFormTool(server);
registerCheckBalanceTool(server);
registerFormatTool(server);

// Navigation and discovery
registerFindCallersTool(server);
registerFindDefinitionTool(server);
registerDocumentSymbolsTool(server);
registerWorkspaceSymbolsTool(server);
registerFileSummaryTool(server);
registerReadFormsTool(server);
registerClassInfoTool(server);

// Project tools
registerProjectInfoTool(server);
registerProjectDepGraphTool(server);
registerProjectMapTool(server);
registerTestCoverageTool(server);
registerStaleStaticTool(server);
registerProjectHealthCheckTool(server);
registerPackageInfoTool(server);

// Documentation and reference
registerDiffModulesTool(server);
registerDynamicReferenceTool(server);
registerModuleQuickstartTool(server);
registerGenerateApiDocsTool(server);
registerModuleCatalogTool(server);

// Code generation and scaffolding
registerScaffoldTestTool(server);
registerGenerateModuleStubTool(server);
registerGenerateModuleTool(server);
registerProjectTemplateTool(server);
registerHttpdHandlerScaffoldTool(server);
registerActorEnsembleScaffoldTool(server);
registerDbPatternScaffoldTool(server);
registerGracefulShutdownScaffoldTool(server);
registerTranslateSchemeTool(server);

// Performance
registerBenchmarkTool(server);
registerBenchmarkCompareTool(server);
registerProfileTool(server);
registerHeapProfileTool(server);
registerTraceCallsTool(server);

// Macro analysis
registerTraceMacroTool(server);
registerMacroExpansionSizeTool(server);
registerMacroHygieneCheckTool(server);
registerMacroPatternDetectorTool(server);
registerBoilerplateConverterTool(server);
registerMacroTemplateLibraryTool(server);
registerSignalTraceTool(server);

// Tracing
registerTraceEvalTool(server);

// Concurrency and event guide
registerEventSystemGuideTool(server);

// Feature tracking
registerSuggestFeatureTool(server);
registerListFeaturesTool(server);
registerVoteFeatureTool(server);

// Jerboa-specific security audit
registerSecurityAuditTool(server);
registerImportPolicyCheckTool(server);
registerUnsafeImportLintTool(server);

// Safe-by-default tools
registerSafePreludeCheckTool(server);
registerResourceLeakCheckTool(server);
registerSafePreludeGeneratorTool(server);

// Static build and FFI tools
registerRustMuslBuildTool(server);
registerStaticSymbolAuditTool(server);
registerBootLibraryAuditTool(server);

// Cross-platform and testing
registerSandboxParityTool(server);
registerMtlsCertGenerateTool(server);

// Debugging
registerCommandTraceTool(server);
registerVerifyStaticBinaryTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('jerboa-mcp server started\n');
