# Jerboa Scheme — Common Patterns and Idioms

Jerboa is a Scheme dialect built on Chez Scheme, combining R6RS semantics with
ergonomic extensions. This reference covers the idioms you will use most often.

---

## 1. Basic Syntax

### `def` vs `define`

`def` is the preferred Jerboa form. It is a macro that expands to `define` but
supports additional shorthand:

```scheme
;; Simple value binding
(def x 42)
(def greeting "hello")

;; Function shorthand (no explicit lambda)
(def (square n) (* n n))

;; Equivalent plain define still works
(define x 42)
(define (square n) (* n n))
```

Prefer `def` for new code. Use `define` only when interoperating with R6RS
libraries that re-export `define`.

### `lambda`

```scheme
(lambda (x y) (+ x y))          ; basic
(lambda (x . rest) rest)         ; rest argument
(lambda args args)               ; all-args-as-list
```

### `let` / `let*` / `letrec`

```scheme
;; let — bindings are independent (no forward reference)
(let ((x 1) (y 2))
  (+ x y))

;; let* — bindings are sequential (each can see previous)
(let* ((x 1) (y (+ x 1)))
  y)   ; => 2

;; letrec — for mutually recursive local functions
(letrec ((even? (lambda (n) (if (= n 0) #t (odd?  (- n 1)))))
         (odd?  (lambda (n) (if (= n 0) #f (even? (- n 1))))))
  (even? 10))
```

Named `let` for loops:

```scheme
(let loop ((i 0) (acc '()))
  (if (= i 5)
      (reverse acc)
      (loop (+ i 1) (cons i acc))))
; => (0 1 2 3 4)
```

### `begin`

Groups expressions; evaluates all, returns last:

```scheme
(begin
  (display "step 1")
  (display "step 2")
  42)   ; => 42, after printing both messages
```

---

## 2. Defstruct / Defclass

### `defstruct` — Simple Record Types

```scheme
(import (jerboa core))

(defstruct point (x y))

;; Constructor
(def p (make-point 3 4))

;; Accessors
(point-x p)    ; => 3
(point-y p)    ; => 4

;; Predicate
(point? p)     ; => #t
(point? 42)    ; => #f
```

### `defstruct` with defaults and keywords

```scheme
(defstruct config
  (host "localhost")
  (port 8080)
  (debug #f))

(def cfg (make-config))          ; all defaults
(def cfg2 (make-config "example.com" 443 #t))
```

### `defclass` — Object-Oriented with Methods

```scheme
(import (jerboa core))

(defclass <animal>
  (fields name sound))

(defmethod (<animal> speak self)
  (format #t "~a says ~a\n" (animal-name self) (animal-sound self)))

(def dog (make-<animal> "Rex" "woof"))
(speak dog)   ; prints: Rex says woof
```

### Inheritance

```scheme
(defclass <dog> (<animal>)
  (fields breed))

(def d (make-<dog> "Buddy" "woof" "Labrador"))
(speak d)          ; inherits speak method
(dog-breed d)      ; => "Labrador"
```

---

## 3. Pattern Matching

See also: `jerboa-pattern-matching.md` for the comprehensive guide.

```scheme
(import (jerboa core))   ; or (jerboa prelude)

(match x
  (0          "zero")
  (#t         "true")
  ("hello"    "greeting")
  ((a b)      (list "pair of" a b))
  ((a . rest) (list "head" a "tail" rest))
  (_          "wildcard"))
```

---

## 4. Error Handling

### `guard` — R6RS standard condition handling

```scheme
(guard (exn
        ((string? (condition/report-string exn))
         (display "caught: ")
         (display (condition/report-string exn))))
  (error "something went wrong" 'details))
```

### `try` / `catch` — Jerboa shorthand

```scheme
(import (jerboa prelude))

(try
  (/ 1 0)
  (catch (exn)
    (display "division error")))

;; With specific condition types
(try
  (open-input-file "/nonexistent")
  (catch (exn (i/o-error? exn))
    (display "file not found"))
  (catch (exn)
    (display "unknown error")))
```

### `raise` / `error`

```scheme
(error "message" irritant1 irritant2)  ; raises &message condition
(raise (make-condition ...))            ; raise arbitrary condition
(raise-continuable val)                 ; continuable exception
```

### `with-exception-handler`

```scheme
(with-exception-handler
  (lambda (exn) (display "handled"))
  (lambda () (error "test")))
```

---

## 5. Hash Tables

```scheme
(import (jerboa prelude))

;; Literal construction
(def h (hash "key" "value" "n" 42))

;; Lookup — returns #f if missing
(hash-get h "key")     ; => "value"
(hash-get h "missing") ; => #f

;; Lookup with default
(hash-ref h "key" "default")     ; => "value"
(hash-ref h "missing" "default") ; => "default"

;; Mutation
(hash-set! h "new-key" 99)
(hash-delete! h "key")

;; Predicates
(hash? h)              ; => #t
(hash-contains? h "n") ; => #t

;; Iteration
(hash-for-each h (lambda (k v) (format #t "~a => ~a\n" k v)))

;; Conversion
(hash->list h)         ; => list of (key . value) pairs
(hash-keys h)          ; => list of keys
(hash-values h)        ; => list of values

;; Size
(hash-size h)          ; => number of entries

;; Build from association list
(def h2 (list->hash '(("a" . 1) ("b" . 2))))
```

### Equal-based vs EQ-based

```scheme
;; Default hash uses equal? for keys (string/list keys work)
(make-hash-table)

;; EQ hash (faster, pointer identity only)
(make-eq-hashtable)

;; EQV hash
(make-eqv-hashtable)
```

---

## 6. List Operations

```scheme
(import (jerboa prelude))

;; Construction
(list 1 2 3)
(cons 0 '(1 2 3))      ; => (0 1 2 3)
'(a b c)

;; Access
(car '(1 2 3))          ; => 1
(cdr '(1 2 3))          ; => (2 3)
(cadr '(1 2 3))         ; => 2  (second)
(list-ref '(a b c) 1)   ; => b

;; Predicates
(null? '())             ; => #t
(pair? '(1 2))          ; => #t
(list? '(1 2 3))        ; => #t

;; Higher-order
(map (lambda (x) (* x x)) '(1 2 3 4))   ; => (1 4 9 16)
(filter odd? '(1 2 3 4 5))              ; => (1 3 5)
(for-each display '(1 2 3))             ; prints 123, returns void

;; Fold
(fold-left  + 0 '(1 2 3 4))    ; => 10  (left-associative)
(fold-right cons '() '(1 2 3)) ; => (1 2 3)

;; Length and append
(length '(a b c))               ; => 3
(append '(1 2) '(3 4) '(5))    ; => (1 2 3 4 5)

;; Reverse
(reverse '(1 2 3))              ; => (3 2 1)

;; Searching
(member 3 '(1 2 3 4))          ; => (3 4)  or #f
(assoc "b" '(("a" 1) ("b" 2))) ; => ("b" 2) or #f
(assq 'b '((a 1) (b 2)))       ; => (b 2)  (eq? comparison)

;; Sort (requires (std sort) or (jerboa prelude))
(sort '(3 1 4 1 5 9) <)        ; => (1 1 3 4 5 9)
(sort '("banana" "apple" "cherry") string<?)
```

---

## 7. String Operations

```scheme
;; Basic
(string-length "hello")         ; => 5
(string-append "foo" "bar")     ; => "foobar"
(substring "hello" 1 3)        ; => "el"
(string-ref "hello" 0)         ; => #\h (char)
(string->list "abc")           ; => (#\a #\b #\c)
(list->string '(#\a #\b))      ; => "ab"

;; Case
(string-upcase "hello")         ; => "HELLO"
(string-downcase "WORLD")       ; => "world"

;; Predicates
(string? "x")                   ; => #t
(string=? "a" "a")             ; => #t
(string<? "apple" "banana")    ; => #t

;; Number conversion
(number->string 42)             ; => "42"
(number->string 255 16)        ; => "ff"  (hex)
(string->number "42")          ; => 42
(string->number "0xff" 16)     ; => 255

;; Format (Chez Scheme)
(format #f "Hello ~a, you are ~d years old" "Alice" 30)
; => "Hello Alice, you are 30 years old"

;; Output variants of format
(format #t "~a\n" value)           ; print to stdout
(format (current-error-port) "~a" err)  ; print to stderr

;; String split/join (from (std misc string) or (jerboa prelude))
(string-split "a,b,c" #\,)     ; => ("a" "b" "c")
(string-join '("a" "b" "c") ",") ; => "a,b,c"

;; Contains / search
(string-contains "hello world" "world")  ; => index or #f
```

---

## 8. I/O

```scheme
;; Simple output
(display "hello")               ; no newline
(newline)                       ; newline only
(write "hello")                 ; quoted: "hello"
(writeln "hello")               ; display + newline (jerboa extension)

;; Format output
(format #t "~a ~s ~d ~%\n" val quoted-val integer)
;; ~a = display, ~s = write, ~d = decimal, ~% = newline

;; Capture output to string
(with-output-to-string
  (lambda ()
    (display "captured")))      ; => "captured"

;; Current ports
(current-input-port)
(current-output-port)
(current-error-port)

;; File I/O
(call-with-input-file "path.txt"
  (lambda (port)
    (read port)))               ; reads one datum

(call-with-output-file "out.txt"
  (lambda (port)
    (display "content" port)))

;; Read all text (from (std misc ports))
(import (std misc ports))
(read-all-text "file.txt")      ; => string

;; String ports
(open-input-string "hello world")   ; string -> input port
(open-output-string)                 ; create output port
(get-output-string port)            ; extract accumulated string

;; with-input-from-string
(with-input-from-string "(+ 1 2)"
  (lambda () (read)))           ; => (+ 1 2)
```

---

## 9. Modules

### Importing

```scheme
;; The all-in-one prelude (recommended starting point)
(import (jerboa prelude))

;; Core macros only
(import (jerboa core))

;; Standard library modules
(import (std sort))
(import (std misc list))
(import (std misc string))
(import (std text json))

;; Multiple imports at once
(import
  (jerboa prelude)
  (std text json)
  (std os path))
```

### Library (module) definition

```scheme
(library (my-project utils)
  (export helper1 helper2 +public-const+)
  (import (jerboa prelude))

  (def +public-const+ 42)

  (def (helper1 x) (* x 2))
  (def (helper2 x y) (+ x y)))
```

### Selective imports

```scheme
;; Import only specific names
(import (only (std misc list) list-flatten list-take))

;; Import and rename
(import (rename (std misc string) (string-split split)))

;; Exclude specific names
(import (except (jerboa prelude) sort))
```

---

## 10. Macros

### `defrule` — pattern-based macros (Jerboa shorthand)

```scheme
(import (jerboa core))

;; Simple swap macro
(defrule (swap! a b)
  (let ((tmp a))
    (set! a b)
    (set! b tmp)))

;; Usage
(def x 1)
(def y 2)
(swap! x y)
;; x => 2, y => 1
```

### `define-syntax` with `syntax-rules`

```scheme
;; While loop
(define-syntax while
  (syntax-rules ()
    ((_ condition body ...)
     (let loop ()
       (when condition
         body ...
         (loop))))))

;; Usage
(def i 0)
(while (< i 5)
  (display i)
  (set! i (+ i 1)))
```

### `let-syntax` — locally scoped macros

```scheme
(let-syntax ((inc! (syntax-rules ()
                     ((_ x) (set! x (+ x 1))))))
  (def n 0)
  (inc! n)
  (inc! n)
  n)   ; => 2
```

### `syntax-rules` patterns

```scheme
(define-syntax my-and
  (syntax-rules ()
    ((_)          #t)
    ((_ e)        e)
    ((_ e1 e2 ...) (if e1 (my-and e2 ...) #f))))

(define-syntax my-or
  (syntax-rules ()
    ((_)          #f)
    ((_ e)        e)
    ((_ e1 e2 ...) (let ((t e1)) (if t t (my-or e2 ...))))))
```

### Ellipsis (`...`) patterns

```scheme
;; Zero-or-more repetition
(define-syntax my-list
  (syntax-rules ()
    ((_ x ...) (list x ...))))

(my-list 1 2 3)   ; => (1 2 3)

;; Keyword patterns
(define-syntax my-let
  (syntax-rules ()
    ((_ ((var val) ...) body ...)
     ((lambda (var ...) body ...) val ...))))
```

---

## Quick Reference: Common Predicates

| Predicate        | Tests for               |
|------------------|-------------------------|
| `null?`          | empty list `'()`        |
| `pair?`          | cons cell               |
| `list?`          | proper list             |
| `number?`        | any number              |
| `integer?`       | integer                 |
| `string?`        | string                  |
| `symbol?`        | symbol                  |
| `boolean?`       | `#t` or `#f`            |
| `char?`          | character               |
| `vector?`        | vector                  |
| `procedure?`     | callable                |
| `hash?`          | hash table              |
| `port?`          | I/O port                |
| `eof-object?`    | end-of-file marker      |

---

## Quick Reference: Tail Calls

Jerboa/Chez guarantees proper tail calls. Any call in tail position does not
grow the stack:

```scheme
;; This is an infinite loop, not a stack overflow
(def (forever n)
  (forever (+ n 1)))

;; Named let loop — always tail-recursive if loop call is last
(let loop ((n 1000000) (acc 0))
  (if (= n 0)
      acc
      (loop (- n 1) (+ acc n))))
```

---

*See also: `jerboa-pattern-matching.md`, `jerboa-chez-interop.md`, `jerboa-stdlib-map.md`*
