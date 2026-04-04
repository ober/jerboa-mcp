## The Jerboa Language — Quick Reference

Jerboa is a Scheme dialect built on Chez Scheme. It is Gerbil-inspired but its own language. **All user-facing code is `.ss` files. Never write `.sls` files for the user** — those are internal implementation files.

### File Structure

Every Jerboa file looks like this:

```scheme
(import (jerboa prelude))    ;; ONE import gives you the ENTIRE language
;; Optional extra imports for modules NOT in the prelude:
;; (import (std net request))

(def (my-function x y)
  (+ x y))

(displayln (my-function 1 2))
```

Run with: `scheme --libdirs lib --script file.ss`

**NEVER** write `(library ...)` forms — that's `.sls` internal syntax.

### Reader Syntax Extensions

```
[...]                → plain parentheses — same as Gerbil and Chez Scheme
{method obj args}    → (~ obj 'method args)  — method dispatch
name:                → keyword #:name
:std/sort            → (std sort)        — Gerbil-style module path
#<<END ... END       → heredoc string
```

Square brackets `[...]` are interchangeable with `(...)`, exactly like Gerbil and stock Chez Scheme. You can freely use them in bindings, match clauses, and anywhere you'd use parentheses:
```scheme
;; All of these are correct:
(let ([x 1] [y 2]) (+ x y))
(for/collect ([x (in-range 5)]) (* x x))
(match val ([list a b] (+ a b)))
(cond [(> x 0) "positive"] [else "non-positive"])
```

### CRITICAL: Things That DO NOT EXIST in Jerboa/Chez

Claude frequently hallucinates these from Gerbil, Gambit, Racket, or R7RS training data.
**NONE of them are real in Jerboa/Chez. STOP and use the correct form.**

#### AI Compatibility Aliases (these now work in the prelude)
The following names from other Scheme dialects are aliased in `(jerboa prelude)`:
- `hash-has-key?` → `hash-key?` (Racket)
- `hash-table-set!` → `hash-put!` (Racket)
- `directory-exists?` → `file-directory?` (Gambit)
- `eql?` → `eqv?` (Common Lisp)
- `random-integer` → `random` (Gambit)
- `read-line` → `get-line` wrapper (Gambit) — works with or without port arg
- `force-output` → `flush-output-port` wrapper (Gambit) — works with or without port arg
- `string-map` → char-level map (Racket/R7RS) — `(string-map f str)`

#### Hallucinated Functions (still do NOT exist)
- `symbol<?` — use `(lambda (a b) (string<? (symbol->string a) (symbol->string b)))`
- `string-contains?` — use `(string-contains str sub)` (returns index or #f, NOT boolean)
- `define-struct` — use `(defstruct name (fields ...))`
- `raise` with a string — use `(error 'who "message" irritants ...)`
- `environment-bound?` — Gerbil-only. No direct Chez equivalent

#### Gerbil/Gambit-isms (from training data — wrong in Jerboa)
- `time->seconds` — use `(time-second (current-time))` for epoch seconds
- `thread-sleep!` — Gambit. Use `(sleep (make-time 'time-duration 0 seconds))`
- `thread-yield` — no Chez equivalent. Use `(sleep (make-time 'time-duration 0 0))` as workaround
- `path-expand` with 2 args — Gerbil takes `(path-expand rel base)`. Jerboa takes 1 arg. Use `(path-join base rel)` for 2-arg version
- `process-status` — Gerbil. Use `(std misc process)` API in Jerboa
- `user-info-home` — Gerbil. Use `(getenv "HOME")`
- `the-environment` — Gerbil. Use `(interaction-environment)` in Chez
- `condition/report-string` — Gerbil. Use `(with-output-to-string (lambda () (display-condition c)))`
- `make-class-type` — Gerbil. Use `(defstruct ...)` or `(defclass ...)` in Jerboa
- `string-subst` — Gerbil. Not in prelude. Use `(string-replace str old new)` or implement manually
- `open-fd-pair` — Gambit. Does not exist in Chez; requires different API

#### R6RS/Racket-isms (wrong variant)
- `make-equal-hashtable` — R6RS. Use `(make-hash-table)` from Jerboa prelude
- `arithmetic-shift` — Racket. Use `(bitwise-arithmetic-shift n k)` or `(ash n k)` in Chez
- `pregexp-match` — Racket. Use `(std text regex)` or `(std pregexp)` API in Jerboa

### CRITICAL: Common Arity Mistakes

- `(list-of? pred)` → returns a PREDICATE. It takes 1 arg. Use: `((list-of? number?) lst)`
- `(maybe pred)` → returns a PREDICATE. It takes 1 arg. Use: `((maybe string?) val)`
- `(in-range end)` or `(in-range start end)` or `(in-range start end step)` — NOT `(in-range start step end)`
- `(hash-ref ht key)` or `(hash-ref ht key default)` — NOT `(hash-ref key ht)`
- `(string-split str delimiter)` where delimiter is a CHAR: `(string-split "a,b" #\,)`
- `(make-rwlock)` — takes **0 args**, NOT `(make-rwlock 'name)` (Gerbil takes a name; Jerboa does not)
- `(path-expand path)` — takes **1 arg**, NOT `(path-expand rel base)` (Gerbil takes 2; use `path-join` for 2-arg)
- `(sort predicate list)` — Chez arg order. NOT `(sort list predicate)` which is Gerbil/SRFI order

### Core Forms (all from `(import (jerboa prelude))`)

#### Definitions
```scheme
(def x 42)                              ;; variable
(def (f x y) (+ x y))                  ;; function
(def (f x (y 10)) body)                ;; optional param with default
(def (f x . rest) body)                ;; rest args
(def* f ((x) ...) ((x y) ...))         ;; multi-arity
(defrule (name pat) template)           ;; macro
```

#### Data Structures
```scheme
(defstruct point (x y))                ;; → make-point, point?, point-x, point-y, point-x-set!
(defstruct (circle shape) (radius))    ;; inheritance (single only)
(defmethod (area (self circle)) body)  ;; method on type
(~ obj 'method arg ...)                ;; dispatch (or {method obj arg ...})
(defrecord person (name age))          ;; struct + pretty-print + ->alist
(define-enum color (red green blue))   ;; → color-red, color?, color->name
```

#### Pattern Matching
```scheme
(match value
  (42 "exact")                          ;; literal
  ((list a b c) (+ a b c))             ;; list destructure
  ((cons h t) h)                        ;; pair
  ((? number?) "num")                   ;; predicate
  ((? string? s) (string-upcase s))    ;; predicate + bind
  ((and (? number?) (? positive?)) "positive number")
  ((or "yes" "y") #t)
  ((=> string->number n) n)            ;; view pattern
  (n (where (> n 0)) "positive")       ;; guard
  (_ "default"))                        ;; wildcard
```

#### Error Handling
```scheme
(try expr (catch (e) handler) (finally cleanup))
(try expr (catch (error? e) handler))
(unwind-protect body cleanup)
(with-resource (var init cleanup) body)
```

#### Result Type (Rust-inspired ok/err)
```scheme
(ok 42)  (err "bad")  (ok? r)  (err? r)
(unwrap (ok 42))         ;; → 42 (raises on err)
(unwrap-or (err "x") 0)  ;; → 0
(map-ok f result)  (map-err f result)
(and-then result f)       ;; monadic bind
(try-result expr)         ;; exceptions → (err condition)
(try-result* expr)        ;; exceptions → (err "message string")
(sequence-results list-of-results)  ;; → (ok list) or first (err)
(->? (ok 10) (+ 5) (* 2))  ;; → (ok 30), short-circuits on err
```

#### Iterators
```scheme
(for ((x (in-range 5))) (displayln x))
(for/collect ((x (in-range 5))) (* x x))           ;; → (0 1 4 9 16)
(for/fold ((sum 0)) ((x (in-range 10))) (+ sum x)) ;; → 45
(for/or ((x lst)) (and (pred? x) x))               ;; first truthy
(for/and ((x lst)) (pred? x))                       ;; all truthy

;; Iterators: in-list, in-vector, in-string, in-range, in-hash-keys,
;; in-hash-values, in-hash-pairs, in-naturals, in-indexed,
;; in-port, in-lines, in-chars, in-bytes, in-producer
```

#### Threading Macros
```scheme
(-> x (f a) (g b))       ;; thread first: (g (f x a) b)
(->> x (f a) (g b))      ;; thread last:  (g b (f a x))
(as-> x v (f v) (g v))   ;; named
(some-> x (f) (g))       ;; short-circuit on #f
(cond-> x test (f) t2 (g))  ;; conditional steps
(->? (ok x) (f) (g))     ;; result-aware thread first
```

#### Ergo Typing
```scheme
(: expr pred?)                    ;; checked cast
(using (p (make-point 1 2) : point?)
  (+ p.x p.y))                   ;; dot-access → (point-x p) etc.
((list-of? number?) '(1 2 3))    ;; predicate factory → #t
((maybe string?) #f)              ;; accepts #f or string → #t
```

#### Hash Tables
```scheme
(def ht (make-hash-table))
(hash-put! ht "key" "val")
(hash-ref ht "key")              ;; error if missing
(hash-ref ht "key" "default")    ;; with default
(hash-get ht "key")              ;; → val or #f
(hash-key? ht "key")             ;; → #t/#f
(hash-remove! ht "key")
(hash->list ht)  (hash-keys ht)  (hash-values ht)
(hash-for-each (lambda (k v) ...) ht)
(list->hash-table '(("a" . 1) ("b" . 2)))
```

#### Strings
```scheme
(string-split "a,b,c" #\,)       ;; → ("a" "b" "c")  NOTE: char delimiter
(string-join '("a" "b") ",")     ;; → "a,b"
(string-trim "  hi  ")           ;; → "hi"
(string-prefix? "he" "hello")    ;; → #t
(string-suffix? "lo" "hello")    ;; → #t
(string-contains "hello" "ell")  ;; → 1 (index, not boolean!)
(string-empty? "")               ;; → #t
(str "age: " 42 "!")             ;; → "age: 42!" (auto-coerce)
```

#### Lists
```scheme
(flatten '(1 (2 (3))))    ;; → (1 2 3)
(unique '(1 2 2 3))       ;; → (1 2 3)
(take lst n)  (drop lst n)  (take-last lst n)  (drop-last lst n)
(every pred lst)  (any pred lst)  (filter-map f lst)
(group-by f lst)  (zip lst1 lst2)  (frequencies lst)
(partition pred lst)  (interleave l1 l2)  (mapcat f lst)
(distinct lst)  (keep f lst)  (split-at lst n)
(append-map f lst)  (snoc lst elem)
```

#### Functional Combinators
```scheme
(compose f g)  (comp f g)       ;; (f (g x))
(partial f arg ...)              ;; partial application
(complement pred)  (negate pred) ;; logical not
(identity x)  (constantly v)     ;; basic combinators
(curry f arg)  (flip f)          ;; currying, arg swap
(conjoin p1 p2)  (disjoin p1 p2) ;; predicate AND/OR
(juxt f g)                        ;; → (lambda (x) (list (f x) (g x)))
(cut f <> y)                      ;; SRFI-26 partial: (lambda (x) (f x y))
```

#### JSON
```scheme
(string->json-object "{\"key\":\"val\"}")  ;; → hash table
(json-object->string ht)                    ;; → JSON string
(read-json port)  (write-json obj port)
```

#### CSV
```scheme
(csv->alists "name,age\nAlice,30")  ;; → (((name . "Alice") (age . "30")))
(read-csv-file "data.csv")          ;; → list of row lists
(write-csv-file "out.csv" rows)
```

#### DateTime
```scheme
(datetime-now)  (datetime-utc-now)
(make-datetime 2026 3 27 12 0 0)
(parse-datetime "2026-03-27T12:00:00Z")
(datetime->iso8601 dt)  (datetime->epoch dt)
(datetime-add dt duration)  (datetime-diff dt1 dt2)
(datetime<? dt1 dt2)  (day-of-week dt)  (leap-year? 2024)
```

#### Paths
```scheme
(path-join "/home" "user" "f.txt")  ;; → "/home/user/f.txt"
(path-directory "/a/b/f.txt")       ;; → "/a/b"
(path-extension "file.txt")         ;; → "txt"
(path-absolute? "/home")            ;; → #t
```

#### File I/O
```scheme
(read-file-string "f.txt")         ;; → entire file
(read-file-lines "f.txt")          ;; → list of lines
(write-file-string "f.txt" "data")
```

#### Pretty Printing
```scheme
(pp expr)  (pp-to-string expr)  (pprint expr)
```

#### Formatting
```scheme
(format "~a is ~a" "Alice" 30)  ;; → "Alice is 30"
(printf "x = ~a\n" 42)
(displayln "hello" " " "world")
```

#### Anaphoric / Conditional Binding
```scheme
(awhen (find x) (use it))          ;; binds result to `it`
(aif (find x) (use it) (default))
(when-let (x (find y)) (use x))
(if-let (x (find y)) (use x) (default))
```

#### Loops
```scheme
(while test body ...)
(until test body ...)
(dotimes (i 10) body ...)   ;; 0..9
```

#### Misc Sugar
```scheme
(assert! (> x 0))  (assert! (> x 0) "message")
(alist (name "Alice") (age 30))  ;; → ((name . "Alice") (age . 30))
(let-alist data (name age) body)
```

### What's NOT in the Prelude (requires separate import)

```scheme
(import (std net request))      ;; HTTP client
(import (std net httpd))        ;; HTTP server
(import (std db sqlite))        ;; SQLite
(import (std actor))            ;; Actor system
(import (std async))            ;; Async/await
(import (std crypto digest))    ;; SHA, MD5
(import (std text regex))       ;; Regex
(import (std text xml))         ;; XML
(import (std text yaml))        ;; YAML
(import (std os env))           ;; Environment variables
(import (std os signal))        ;; Signal handling
(import (std security sandbox)) ;; Sandboxing
```

### Chez Scheme Conflicts (handled by prelude)

The prelude shadows these Chez builtins with Jerboa versions:
`make-hash-table`, `hash-table?`, `sort`, `sort!`, `printf`, `fprintf`,
`path-extension`, `path-absolute?`, `with-input-from-string`,
`with-output-to-string`, `iota`, `1+`, `1-`, `partition`,
`make-date`, `make-time`

All standard Chez Scheme is still available — the prelude just re-exports
improved versions of the above.

---

## Repository Boundaries

When working in a Jerboa project, **ONLY modify files in the current repo** unless the user explicitly names another path.

Common sibling repos that exist but must NOT be touched without explicit instruction:
- `~/mine/jerboa-emacs` — **NEVER touch**. Another model owns it.
- `~/mine/jerboa-mcp` — Only modify when user explicitly says to work there.
- `~/mine/jerboa-shell` — Only modify when user explicitly says to work there.
- `~/mine/gerbil-mcp` — **NEVER touch**. Deprecated.
- `~/mine/gerbil-orig` — Read-only reference for upstream Gerbil. Never modify.

If a user instruction mentions a file path, use EXACTLY that path. Do not substitute a similar-looking path from another repo.

---

## Build & Verification

After modifying any `.ss` or `.sls` (Jerboa Scheme) source files, always run the build command and fix any errors before moving on. Common issues include: missing imports, wrong function names, and duplicate definitions.

### Stale Artifacts

If edits seem to have no effect after `make build`, delete stale compiled files:
```bash
find lib -name "*.so" -delete && find lib -name "*.wpo" -delete && make build
```
Run `jerboa_stale_static` to detect stale `.so` files before debugging "why doesn't my edit work?".

## Jerboa MCP Tools — MANDATORY Usage

Jerboa is a niche Scheme dialect with limited training data. **Never guess — always verify** with MCP tools. Tool descriptions are available at runtime via the MCP server; this section covers **when** and **why** to use each tool.

### MANDATORY Workflow Order (for writing new code)

1. **`jerboa_howto`** — BEFORE writing code, search cookbook for verified patterns
2. **`jerboa_module_exports`** / **`jerboa_function_signature`** — confirm APIs exist and check arities
3. Write the code
4. **`jerboa_verify`** — combined syntax + compile + lint + arity + duplicate check (use instead of individual tools)
5. **`jerboa_security_scan`** — for code involving FFI, shell commands, or file I/O

### Essential Tools (use proactively)

| When | Tool |
|---|---|
| Before writing ANY Jerboa code | `jerboa_howto` — cookbook has verified patterns with correct imports |
| Check what a module exports | `jerboa_module_exports` — never guess function names |
| Check function arity/args | `jerboa_function_signature` — prevents wrong-arg-count errors |
| Validate your code | `jerboa_verify` — one-stop syntax+compile+lint+arity check |
| Test expressions interactively | `jerboa_eval` — use `imports` param for modules, `env` for FFI paths |
| Persistent interactive testing | `jerboa_repl_session` — maintains state across evaluations |
| Debug an error message | `jerboa_explain_error` + `jerboa_error_fix_lookup` |
| Understand unfamiliar code | `jerboa_file_summary` + `jerboa_document_symbols` |
| Find where something is defined | `jerboa_find_definition` — source file, module, kind, arity |
| Search for symbol by substring | `jerboa_apropos` or `jerboa_smart_complete` |
| Build the project | `jerboa_build_and_report` or `jerboa_make` — prefer over bash `make` |
| Run tests | `jerboa_run_tests` — prefer over bash `scheme --script` |
| Check for stale .so artifacts | `jerboa_stale_static` — common cause of "edit has no effect" |
| Macro expansion | `jerboa_expand_macro` / `jerboa_trace_macro` |
| Inspect struct/class types | `jerboa_class_info` — fields, inheritance, constructor signature |
| FFI work | `jerboa_ffi_scaffold` / `jerboa_ffi_type_check` / `jerboa_ffi_null_safety` |
| Port Gerbil code | `jerboa_migration_check` + `jerboa_translate_scheme` |
| Detect paren imbalance | `jerboa_check_balance` — use BEFORE `make build` after deep edits |
| Full project audit | `jerboa_project_health_check` — balance, exports, cycles, duplicates |
| Security audit | `jerboa_security_audit` + `jerboa_import_policy_check` |
| Static build audit | `jerboa_static_symbol_audit` + `jerboa_boot_library_audit` |
| Explore a module | `jerboa_module_catalog` (replaces multiple `jerboa_doc` calls) |
| Look up any symbol | `jerboa_doc` — type, arity, qualified name, related symbols |
| Read stdlib source | `jerboa_stdlib_source` — see internal implementations |

### Cookbook & Knowledge Management

- **`jerboa_howto`** / **`jerboa_howto_get`**: Search and retrieve verified recipes
- **`jerboa_howto_add`**: Save new patterns to cookbook (MANDATORY when you discover something non-trivial)
- **`jerboa_howto_run`** / **`jerboa_howto_verify`**: Validate recipes still work
- **`jerboa_error_fix_add`**: Save error→fix mappings for common mistakes

### Code Generation & Refactoring

`jerboa_rename_symbol`, `jerboa_balanced_replace`, `jerboa_wrap_form`, `jerboa_splice_form`, `jerboa_scaffold_test`, `jerboa_generate_module`, `jerboa_translate_scheme`, `jerboa_project_template`, `jerboa_httpd_handler_scaffold`, `jerboa_db_pattern_scaffold`, `jerboa_actor_ensemble_scaffold`

### Feature Suggestions

- **`jerboa_list_features`** / **`jerboa_suggest_feature`** / **`jerboa_vote_feature`**: Track and submit tooling improvement ideas

---

## MANDATORY: Save What You Learn

Jerboa is niche — every non-trivial pattern you discover prevents future sessions from re-discovering it.

### Save to cookbook (`jerboa_howto_add`) whenever you:
- Discover a working pattern through `jerboa_eval` or trial-and-error
- Figure out correct imports, arities, or calling conventions that weren't obvious
- Find a workaround for a Jerboa quirk or undocumented behavior

**Before saving**: check `jerboa_howto` to avoid duplicates. **Do NOT save**: trivial one-liners, project-specific logic, or existing recipes.

**Recipe format**: `id` (kebab-case), `tags` (4-6 search keywords incl. module name), `imports` (all required), `code` (complete working example), `notes` (gotchas/alternatives).

### Suggest tooling improvements (`jerboa_suggest_feature`) whenever you:
- Make multiple sequential tool calls that could be one tool
- Fall back to bash because an MCP tool is missing or insufficient

**Before suggesting**: check `jerboa_list_features`; vote with `jerboa_vote_feature` if it already exists.

### Save Discoveries Mechanisms
- **`/save-discoveries` skill**: invoke anytime to review session and save patterns + suggestions
- **PreCompact hook**: add `PreCompact` hook with `type: "prompt"` in `.claude/settings.json` to auto-save before context compaction

---

## Common Workflows

- **Write new code**: `jerboa_howto` -> `jerboa_module_exports` -> write code -> `jerboa_verify` -> `jerboa_security_scan`
- **Debug an error**: `jerboa_explain_error` -> follow suggested tools -> `jerboa_howto` for fix patterns
- **Understand unfamiliar code**: `jerboa_file_summary` -> `jerboa_document_symbols` -> `jerboa_module_deps`
- **Refactor a module**: `jerboa_check_exports` -> `jerboa_find_callers` -> `jerboa_rename_symbol` -> `jerboa_check_import_conflicts`
- **Build project**: `jerboa_build_conflict_check` -> `jerboa_make` -> `jerboa_build_and_report`
- **Port from Gerbil**: `jerboa_migration_check` -> `jerboa_translate_scheme` -> `jerboa_verify` -> `jerboa_check_syntax`
- **Audit project quality**: `jerboa_verify` -> `jerboa_lint` -> `jerboa_dead_code` -> `jerboa_dependency_cycles`
- **Debug a crash**: `jerboa_stale_static` -> `jerboa_bisect_crash` -> `jerboa_ffi_type_check`
- **Learn a module**: `jerboa_stdlib_source` -> `jerboa_module_catalog` -> `jerboa_module_quickstart`
- **Security audit**: `jerboa_security_audit` -> `jerboa_import_policy_check` -> `jerboa_unsafe_import_lint`
- **Static build audit**: `jerboa_static_symbol_audit` -> `jerboa_boot_library_audit` -> `jerboa_rust_musl_build`
- **Safe-by-default check**: `jerboa_safe_prelude_check` -> `jerboa_resource_leak_check` -> `jerboa_safe_prelude_generate`
- **Debug editor command**: `jerboa_command_trace` with `project_path` and `buffer_type`

## Workflow Conventions

When implementing new features, always complete the documentation update in the same session. Document non-trivial solutions as howto recipes in the cookbook system.
