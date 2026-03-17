# Jerboa Pattern Matching — Comprehensive Guide

Jerboa's `match` form provides exhaustive, readable pattern matching over any
Scheme value. It is available from `(jerboa core)` or `(jerboa prelude)`.

```scheme
(import (jerboa prelude))

(match expression
  (pattern1 result1)
  (pattern2 result2)
  ...)
```

Each clause is tried in order. The first matching pattern wins. If no pattern
matches, an error is raised (add a wildcard `_` to make it exhaustive).

---

## 1. Basic Literal Patterns

Literals match by `equal?`:

```scheme
(match x
  (0       "zero")
  (1       "one")
  (#t      "true")
  (#f      "false")
  ("hello" "the greeting")
  ('done   "the symbol done"))

;; Symbols must be quoted to match as literals
(match sym
  ('ok    "success")
  ('error "failure"))

;; Unquoted symbols are variable bindings (see below)
(match sym
  (x (format #f "bound ~a to x" x)))   ; x captures anything
```

### Character literals

```scheme
(match ch
  (#\a  "lowercase a")
  (#\newline "newline character")
  (#\space   "space"))
```

---

## 2. Variable Binding Patterns

An unquoted identifier in pattern position binds the matched value:

```scheme
(match '(1 2 3)
  ((a b c)
   (list "got" a b c)))
; => ("got" 1 2 3)

;; Variables can appear multiple times — they must match the same value
(match '(1 1)
  ((x x) "both equal")  ; matches only if car = cadr
  ((x y) "different"))
```

### Wildcard `_`

`_` matches anything and binds nothing:

```scheme
(match x
  (_ "catch-all"))   ; always matches

(match '(1 2 3)
  ((a _ c) a))       ; binds a=1, c=3, ignores middle
```

---

## 3. List Patterns

### Fixed-length list

```scheme
(match lst
  (()      "empty")
  ((a)     (list "one element" a))
  ((a b)   (list "two elements" a b))
  ((a b c) (list "three elements" a b c)))
```

### Pair / improper list

```scheme
;; (head . tail) — matches any non-empty list
(match lst
  (()        "empty")
  ((x . rest) (list "head" x "rest" rest)))

;; Multiple heads before rest
(match lst
  ((a b . rest) (list "first two" a b "then" rest)))
```

### Dotted pairs

```scheme
;; Match an association list entry
(match entry
  ((key . value) (list key "maps to" value)))
```

---

## 4. Vector Patterns

```scheme
(match v
  (#()        "empty vector")
  (#(x)       (list "one element" x))
  (#(x y)     (list "two elements" x y))
  (#(x y z)   (list "three" x y z))
  (#(x . rest) (list "first element" x "rest not available")))
```

Note: vector rest patterns are not universally supported; prefer fixed-size
matches for vectors.

---

## 5. Predicate Patterns `(? pred var)`

`(? pred)` matches when `pred` returns true. `(? pred var)` also binds the
value to `var`:

```scheme
;; Match by type
(match x
  ((? string?)       "it's a string")
  ((? number?)       "it's a number")
  ((? symbol?)       "it's a symbol")
  ((? list?)         "it's a list")
  ((? procedure?)    "it's a procedure"))

;; Bind as well
(match x
  ((? string? s)  (string-length s))
  ((? number? n)  (* n 2))
  (_              "other"))

;; Custom predicate
(match n
  ((? even? n) (list "even" n))
  ((? odd?  n) (list "odd" n)))

;; Inline lambda predicate
(match x
  ((? (lambda (v) (> v 100)) big) (list "big number" big))
  ((? number? small)               (list "small number" small)))
```

---

## 6. And Patterns

`(and pat1 pat2 ...)` — must match all patterns simultaneously:

```scheme
;; Common use: bind a value while also checking a predicate
(match x
  ((and (? number? n) (? positive? _))
   (list "positive number" n))
  ((and (? number? n))
   (list "non-positive number" n)))

;; Bind at multiple levels
(match '(1 2)
  ((and whole (a b))
   (list "whole list is" whole "first is" a "second is" b)))
```

---

## 7. Or Patterns

`(or pat1 pat2 ...)` — matches if any pattern matches:

```scheme
;; Multiple literals in one clause
(match x
  ((or 1 2 3) "small positive integer")
  ((or 'yes 'ok 'true) "affirmative symbol")
  (_ "other"))

;; Combined with binding (all alternatives must bind same variables)
(match x
  ((or (? string? s) (? symbol? s))
   (list "stringish" s)))
```

---

## 8. Record / Struct Patterns

Patterns for `defstruct` instances use the struct name as pattern head:

```scheme
(import (jerboa core))

(defstruct point (x y))
(defstruct circle (center radius))

(def p (make-point 3 4))
(def c (make-circle (make-point 0 0) 5))

;; Match struct type and bind fields
(match p
  ((point x y) (list "point at" x y)))
; => ("point at" 3 4)

;; Nested struct matching
(match c
  ((circle (point cx cy) r)
   (format #f "circle centered at ~a,~a radius ~a" cx cy r)))
; => "circle centered at 0,0 radius 5"

;; Pattern with predicate guard on field
(match p
  ((point (? positive? x) y) (list "positive x" x y))
  ((point x y)               (list "non-positive x" x y)))
```

---

## 9. Guard Clauses

`(when condition)` after a pattern body adds a boolean guard. If the guard is
false, matching continues to the next clause:

```scheme
(match n
  (x (when (even? x)) (list "even" x))
  (x (when (odd?  x)) (list "odd" x)))

;; Guards can use bound pattern variables
(match lst
  ((a b) (when (> a b)) (list "a is larger" a b))
  ((a b)                (list "b is larger or equal" a b)))
```

---

## 10. Ellipsis Patterns (`...`)

Zero-or-more repetition (available in some match implementations):

```scheme
;; Match a list of any length and collect all elements
(match '(1 2 3 4 5)
  ((x ...) x))   ; => (1 2 3 4 5)

;; Prefix + rest
(match '(a b 1 2 3)
  ((p q n ...) (list "prefix" p q "rest" n)))
; => ("prefix" a b "rest" (1 2 3))

;; Apply transformation to each matched element
(match '(1 2 3)
  ((x ...) (map (lambda (v) (* v v)) x)))
; => (1 4 9)
```

Note: ellipsis support depends on the match implementation. Test in your
environment before relying on it.

---

## 11. `let` Patterns — Destructuring Binding

Some Jerboa variants support `match-let` for direct destructuring:

```scheme
;; match-let — like let but with pattern on the left
(match-let (((a b c) '(1 2 3)))
  (+ a b c))   ; => 6

;; Equivalent using match
(match '(1 2 3)
  ((a b c) (+ a b c)))
```

---

## 12. Nested Patterns — Complex Examples

### Parsing a simple AST

```scheme
(def (eval-expr expr env)
  (match expr
    ((? number? n)
     n)
    ((? symbol? s)
     (hash-get env (symbol->string s)))
    (('+ a b)
     (+ (eval-expr a env) (eval-expr b env)))
    (('* a b)
     (* (eval-expr a env) (eval-expr b env)))
    (('if test then else)
     (if (eval-expr test env)
         (eval-expr then env)
         (eval-expr else env)))
    (_
     (error "unknown expression" expr))))
```

### Parsing HTTP-like request records

```scheme
(defstruct request (method path headers body))

(def (handle req)
  (match req
    ((request 'GET  "/" _ _)            "home page")
    ((request 'GET  path _ _)
     (when (string-prefix? "/static/" path))
     (serve-static path))
    ((request 'POST "/api/data" _ body) (process-data body))
    ((request method _ _ _)
     (format #f "405 Method Not Allowed: ~a" method))))
```

### Recursive list processing

```scheme
(def (flatten lst)
  (match lst
    (()           '())
    (((? list? h) . t)
     (append (flatten h) (flatten t)))
    ((h . t)
     (cons h (flatten t)))))

(flatten '(1 (2 3) (4 (5 6)) 7))
; => (1 2 3 4 5 6 7)
```

---

## 13. `match` vs `cond` vs `case` — When to Use Which

| Situation                                | Recommended form     |
|------------------------------------------|----------------------|
| Dispatch on structure (list shape, type) | `match`              |
| Destructure and bind fields              | `match`              |
| Simple predicate chain (no binding)      | `cond`               |
| Dispatch on exact values (enum-like)     | `case`               |
| Single condition check                   | `if` or `when`       |
| Nested structure or recursive patterns   | `match`              |

### `cond` — predicate chain

```scheme
(cond
  ((< x 0) "negative")
  ((= x 0) "zero")
  ((> x 0) "positive"))
```

### `case` — equality dispatch

```scheme
(case x
  ((1 2 3)    "small")
  ((10 20 30) "medium")
  (else       "other"))
```

### Why choose `match`

- Destructures data and binds components in one step.
- Handles nested structure naturally.
- More readable than nested `if`/`cond` for sum types.
- Exhaustiveness is visible — a missing `_` will raise at runtime on no-match.

---

## Common Pitfalls

1. **Unquoted symbols are variables, not literals:**
   ```scheme
   ;; WRONG — 'ok matches anything, bound to ok
   (match x (ok "matched ok symbol"))

   ;; CORRECT — quote the symbol
   (match x ('ok "matched ok symbol"))
   ```

2. **Pattern order matters — put specific patterns before general ones:**
   ```scheme
   ;; WRONG — (? number? n) shadows (0 ...) if listed first
   (match x
     ((? number? n) ...)
     (0 "special zero"))   ; never reached

   ;; CORRECT — specific before general
   (match x
     (0 "special zero")
     ((? number? n) ...))
   ```

3. **No-match raises an error — always add `_` if all cases are possible:**
   ```scheme
   (match x
     ('a "a")
     ('b "b")
     (_ (error "unexpected value" x)))
   ```

---

*See also: `jerboa-idioms.md` for general Jerboa patterns.*
