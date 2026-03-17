# Jerboa / Chez Scheme Interoperability

Jerboa runs on top of Chez Scheme. Everything available in Chez is available in
Jerboa, but Jerboa adds its own layer of macros and conventions. This guide
covers when and how to reach for Chez APIs directly.

---

## 1. When to Use Chez Directly

Use Chez APIs directly when:

- You need **R6RS record types** (`define-record-type`) for interop with R6RS
  libraries.
- You need the full **numeric tower** (exact rationals, complex numbers).
- You need **Chez-specific introspection** (`inspect`, `trace`, `pretty-print`).
- You need **environment manipulation** (`eval`, `interaction-environment`).
- You need **low-level FFI** (`foreign-procedure`, `load-shared-object`).
- You need **binary I/O** or specific port types not in the Jerboa prelude.
- You need **native threads** via Chez's own thread API.

Prefer `(jerboa prelude)` for everyday code. Drop down to Chez only for
features it does not cover.

---

## 2. Record Types — R6RS `define-record-type`

Chez implements the R6RS record system. Jerboa's `defstruct` compiles to this
underneath, but you can use it directly for interop:

```scheme
;; R6RS record type — no import needed (built in to Chez)
(define-record-type point
  (fields x y))

;; With mutable fields
(define-record-type counter
  (fields (mutable count)))

(def c (make-counter 0))
(counter-count c)           ; => 0
(counter-count-set! c 5)
(counter-count c)           ; => 5
```

### Full R6RS form

```scheme
(define-record-type <person>
  (make-person name age)    ; custom constructor name
  person?                   ; predicate name
  (name   person-name)      ; (field-name accessor)
  (age    person-age person-set-age!))  ; (field accessor mutator)

(def p (make-person "Alice" 30))
(person-name p)             ; => "Alice"
(person-set-age! p 31)
```

### Inheritance (R6RS parent)

```scheme
(define-record-type <employee>
  (parent <person>)
  (fields department))

(def e (make-<employee> "Bob" 25 "Engineering"))
(person-name e)             ; inherited
(<employee>-department e)
```

---

## 3. Numeric Tower

Chez supports the full R7RS numeric tower:

```scheme
;; Exact arithmetic
(exact? 1/3)          ; => #t
(+ 1/3 1/6)           ; => 1/2  (exact rational)
(* 1/3 3)             ; => 1

;; Inexact (floating point)
(inexact 1/3)         ; => 0.3333333333333333
(exact->inexact 1/4)  ; => 0.25

;; Conversion
(inexact->exact 0.5)  ; => 1/2
(inexact->exact 0.1)  ; => 3602879701896397/36028797018963968 (float artifact)

;; Complex (Chez extension)
(make-rectangular 3 4)   ; => 3+4i
(make-polar 1.0 (/ pi 4)) ; => 0.7071+0.7071i
(real-part 3+4i)         ; => 3
(imag-part 3+4i)         ; => 4
(magnitude 3+4i)         ; => 5.0

;; Large exact integers (bignums — automatic)
(expt 2 100)
; => 1267650600228229401496703205376

;; Numeric predicates
(exact? 1/3)    ; => #t
(inexact? 0.5)  ; => #t
(rational? 1/3) ; => #t
(real? 1.5)     ; => #t
(complex? 1+2i) ; => #t
(integer? 4)    ; => #t
(zero? 0)       ; => #t
(positive? 1)   ; => #t
(negative? -1)  ; => #t
```

---

## 4. Chez-Specific APIs

### `format`

Chez's `format` is more powerful than R6RS `display`/`write`:

```scheme
;; Output to port or string
(format #t "value: ~a\n" x)           ; stdout
(format #f "value: ~a\n" x)           ; returns string
(format (current-error-port) "~a" e)  ; stderr

;; Format directives
;; ~a   — display (no quotes)
;; ~s   — write (with quotes)
;; ~d   — decimal integer
;; ~x   — hex integer
;; ~o   — octal
;; ~b   — binary
;; ~e   — scientific notation
;; ~f   — fixed-point float
;; ~%   — newline
;; ~&   — fresh line (newline unless already at column 0)
;; ~~   — literal tilde
;; ~n   — newline (same as ~%)
;; ~t   — tab
```

### `pretty-print`

```scheme
;; Pretty-print any datum
(pretty-print '(lambda (x y) (+ x y)))
;; Prints formatted Scheme code

;; To a port
(pretty-print datum (current-output-port))

;; To a string
(with-output-to-string
  (lambda ()
    (pretty-print datum)))
```

### `inspect`

Chez's interactive inspector (useful at a REPL):

```scheme
;; Inspect a value interactively
(inspect some-value)

;; Programmatic inspection
(inspect/object some-value)   ; returns inspector object
```

### `trace` / `untrace`

```scheme
;; Trace all calls to a function
(trace my-function)

;; Multiple at once
(trace foo bar baz)

;; Remove tracing
(untrace my-function)
(untrace)    ; untrace all
```

---

## 5. Environment and `eval`

```scheme
;; Evaluate in the interaction environment
(eval '(+ 1 2) (interaction-environment))   ; => 3

;; Create a pristine R6RS environment
(def env (environment '(rnrs)))
(eval '(+ 1 2) env)

;; Jerboa environment with prelude
(def jerboa-env (environment '(jerboa prelude)))
(eval '(def (sq x) (* x x)) jerboa-env)

;; scheme-environment — access Chez built-ins
(def chez-env (scheme-environment))
(eval '(pretty-print '(a b c)) chez-env)
```

### `compile` — ahead-of-time compilation

```scheme
;; Compile a file
(compile-file "my-module.ss")

;; Compile to specific output
(compile-file "src.ss" "src.so")

;; Load compiled artifact
(load "src.so")
```

---

## 6. FFI Basics

Chez provides a direct C FFI.

### Loading a shared library

```scheme
;; Load at runtime
(load-shared-object "libz.so")           ; zlib
(load-shared-object "libssl.so")
(load-shared-object #f)                  ; current process (self)
```

### `foreign-procedure` — call a C function

```scheme
;; (foreign-procedure "c-name" (arg-types ...) return-type)
(def strlen
  (foreign-procedure "strlen" (string) size_t))

(strlen "hello")   ; => 5

;; Common types: int, unsigned, long, double, string, void, boolean
;; Pointer types: void* is (* void), char* is string or (& char)

(def malloc
  (foreign-procedure "malloc" (size_t) void*))

(def free
  (foreign-procedure "free" (void*) void))
```

### `foreign-callable` — expose Scheme to C

```scheme
;; Create a C-callable pointer to a Scheme procedure
(def callback
  (foreign-callable
    (lambda (x) (* x x))   ; Scheme proc
    (int)                   ; C arg types
    int))                   ; C return type

;; Unlock for GC safety when passing to C
(foreign-callable-entry-point callback)   ; raw void*
(lock-object callback)    ; prevent GC from moving it
```

### `foreign-ref` / `foreign-set!` — memory access

```scheme
;; Read/write raw memory
(foreign-ref 'int ptr 0)          ; read int at ptr+0
(foreign-set! 'int ptr 0 42)      ; write int at ptr+0

;; Supported types: char, unsigned-char, short, unsigned-short,
;;   int, unsigned-int, long, unsigned-long, long-long,
;;   unsigned-long-long, float, double, void*
```

---

## 7. Ports and I/O

### String ports

```scheme
;; Input from string
(def p (open-input-string "(+ 1 2)"))
(read p)    ; => (+ 1 2)
(read p)    ; => eof-object

;; Output to string
(def out (open-output-string))
(display "hello" out)
(write " world" out)
(get-output-string out)   ; => "hello\" world\""
```

### Binary ports

```scheme
;; Open binary file
(def in  (open-file-input-port "data.bin"))
(def out (open-file-output-port "out.bin"))

;; Read/write bytes
(get-u8 in)                   ; read one byte
(put-u8 out 255)              ; write one byte
(get-bytevector-n in 16)      ; read N bytes -> bytevector
(put-bytevector out bv)       ; write bytevector

;; Close
(close-port in)
(close-port out)
```

### Bytevectors

```scheme
(make-bytevector 10 0)         ; => #vu8(0 0 0 0 0 0 0 0 0 0)
(bytevector-u8-ref bv 0)       ; read byte at index
(bytevector-u8-set! bv 0 42)   ; write byte

;; Conversions
(utf8->string bv)              ; bytevector -> string
(string->utf8 "hello")         ; string -> bytevector
```

### Transcoded ports (text over binary)

```scheme
(def bin-port (open-file-input-port "text.txt"))
(def txt-port (transcoded-port bin-port (native-transcoder)))
(get-string-all txt-port)    ; read entire file as string
```

---

## 8. Thread APIs

Chez provides native OS threads.

```scheme
;; Create a thread (does not start immediately)
(def t (make-thread
          (lambda ()
            (display "hello from thread\n"))))

;; Start it
(thread-start! t)

;; Wait for completion
(thread-join! t)

;; Current thread
(current-thread)

;; Thread sleep
(thread-sleep! 1000)   ; milliseconds
```

### Mutexes

```scheme
(def m (make-mutex))

(mutex-acquire m)
;; ... critical section ...
(mutex-release m)

;; With-mutex pattern (not built-in, define it):
(define-syntax with-mutex
  (syntax-rules ()
    ((_ m body ...)
     (dynamic-wind
       (lambda () (mutex-acquire m))
       (lambda () body ...)
       (lambda () (mutex-release m))))))
```

### Condition variables

```scheme
(def cv (make-condition))

;; Wait (atomically releases mutex, waits, re-acquires)
(condition-wait cv m)

;; Signal one waiter
(condition-signal cv)

;; Signal all waiters
(condition-broadcast cv)
```

---

## 9. GC and Memory

```scheme
;; Force a garbage collection
(collect)               ; minor GC
(collect 1)             ; generation 1 GC
(collect (collect-maximum-generation))  ; full GC

;; Memory statistics
(bytes-allocated)       ; bytes allocated since last collect
(statistics)            ; full GC stats (time, collections, bytes)

;; Lock object from GC movement (needed for FFI callbacks)
(lock-object obj)
(unlock-object obj)

;; Weak references
(def wp (make-weak-pair val 'placeholder))
(weak-pair/car wp)   ; #f if GCed, original value otherwise
```

---

## 10. Chez Extensions vs R6RS Standard

| Feature                  | R6RS Standard         | Chez Extension          |
|--------------------------|-----------------------|-------------------------|
| `format`                 | not in R6RS           | built-in                |
| `pretty-print`           | not standard          | built-in                |
| `trace`/`untrace`        | not standard          | built-in                |
| `eval`                   | `(rnrs eval)`         | also in top-level       |
| `define-record-type`     | `(rnrs records)`      | also in top-level       |
| Hash tables              | `(rnrs hashtables)`   | also `make-hashtable`   |
| Threads                  | not in R6RS           | Chez native threads     |
| FFI                      | not in R6RS           | `foreign-procedure` etc.|
| `with-output-to-string`  | not in R6RS           | Chez extension          |
| `read-char`/`peek-char`  | `(rnrs io simple)`    | top-level               |
| `gensym`                 | not in R6RS           | Chez extension          |
| `getenv`                 | not in R6RS           | Chez extension          |
| `system`                 | not in R6RS           | Chez extension          |
| Complex numbers          | `(rnrs arithmetic)`   | top-level               |

### Chez-specific utilities

```scheme
;; Unique symbol generation
(gensym)         ; => g1234  (fresh each call)
(gensym "prefix") ; => prefix1234

;; Environment variables
(getenv "HOME")   ; => "/home/user" or #f

;; Shell command
(system "ls -la")  ; => exit code

;; Timing
(time (my-expensive-computation))
;; Prints: (time ...) took X ms

;; Error display
(error-message exn)   ; extract string from condition
```

---

*See also: `jerboa-idioms.md`, `jerboa-pattern-matching.md`, `jerboa-stdlib-map.md`*
