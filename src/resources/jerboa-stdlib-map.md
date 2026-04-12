# Jerboa Standard Library Module Map

This is a navigational overview of the modules available in Jerboa and its
standard library. Use it to find what to import for a given task.

---

## Core Modules

### `(jerboa prelude)` — The All-in-One Starting Point

Import this first in most programs. It re-exports everything you need for
everyday work: `def`, `defstruct`, `defclass`, `match`, `try`/`catch`, hash
operations, sorted lists, `format`, I/O helpers, and the full Jerboa reader.

```scheme
(import (jerboa prelude))
```

Included from prelude:
- `def`, `def*` — binding forms
- `defstruct`, `defclass`, `defmethod` — types
- `match` — pattern matching
- `try`, `catch` — exception handling
- `hash`, `hash-ref`, `hash-get`, `hash-put!`, `hash-remove!`, `hash-key?`,
  `hash-for-each`, `hash->list`, `hash-merge`, `hash-length`
- `sort`, `sort!`
- `format` — string formatting
- `string-split`, `string-join`, `string-contains`, `string-prefix?`,
  `string-suffix?`
- `read-line`, `writeln`, `with-output-to-string`
- `when`, `unless`, `and`, `or`, `not`
- `for-each`, `map`, `filter`, `fold-left`, `fold-right`
- `make-hash-table`, `hash?`, `hash-size`, `hash-keys`, `hash-values`
- `gensym`

### `(jerboa reader)` — Extended Reader Syntax

Enables Jerboa's extended reader macros:
- `[...]` — alternative list syntax (same as `(...)`)
- `{key val ...}` — hash literal (same as `(hash key val ...)`)
- `keyword:` — keyword argument syntax

```scheme
(import (jerboa reader))

;; Now you can write:
{name "Alice" age 30}   ; => hash table
;; Brackets are plain parens (like Gerbil/Chez), use freely in let/match/cond
```

### `(jerboa core)` — Core Macros Only

The macro layer without I/O helpers. Use when you want `def`, `defstruct`,
`match`, but not the full prelude's re-exports.

```scheme
(import (jerboa core))

;; Provides: def, defstruct, defclass, defmethod, match,
;;           defrule, try, catch, when, unless
```

---

## Data Structures

### `(std sort)` — Sorting Algorithms

```scheme
(import (std sort))

(sort '(3 1 4 1 5 9 2 6) <)
; => (1 1 2 3 4 5 6 9)

(sort '("banana" "apple" "cherry") string<?)
; => ("apple" "banana" "cherry")

;; Sort by key
(sort-by car '((3 . a) (1 . b) (2 . c)) <)
; => ((1 . b) (2 . c) (3 . a))

;; In-place sort (mutates vector)
(vector-sort! < #(3 1 4 1 5))
```

### Hash Operations — in `(jerboa runtime)`, re-exported by prelude

Hash operations are in `(jerboa runtime)` and re-exported by `(jerboa prelude)`.
There is no separate `(std misc hash)` module.

```scheme
(import (jerboa prelude))

;; Create
(def h (hash 'a 1 'b 2 'c 3))
(make-hash-table)            ;; empty, equal?-based
(make-hash-table-eq)         ;; empty, eq?-based

;; Access
(hash-get h 'a)              ;; => 1 (macro, returns #f if missing)
(hash-ref h 'a)              ;; => 1 (error if missing with 2 args)
(hash-ref h 'z "default")   ;; => "default" (3 args: with default)

;; Mutate
(hash-put! h 'new 99)        ;; NOT hash-set!
(hash-remove! h 'a)          ;; NOT hash-delete!
(hash-update! h 'b (lambda (v) (+ v 1)) 0)

;; Query
(hash-key? h 'b)             ;; NOT hash-contains?
(hash-length h)              ;; count of entries

;; Merge and copy
(hash-merge h1 h2)           ;; new table, h2 wins on conflict
(hash-copy h)                ;; shallow copy

;; Convert
(hash->list h)               ;; => ((key . val) ...)
(hash-keys h)                ;; => (key ...)
(hash-values h)              ;; => (val ...)
(list->hash-table alist)     ;; from ((k . v) ...) pairs
(plist->hash-table plist)    ;; from (k1 v1 k2 v2 ...)
```

### `(std misc list)` — Extended List Operations

Exports 10 functions, all re-exported by `(jerboa prelude)`.

```scheme
(import (std misc list))  ;; or just (import (jerboa prelude))

;; Flatten nested lists
(flatten '(1 (2 (3 4) 5) 6))     ; => (1 2 3 4 5 6)

;; Take/drop
(take '(a b c d e) 3)             ; => (a b c)
(drop '(a b c d e) 3)             ; => (d e)

;; Append to end (opposite of cons)
(snoc '(1 2) 3)                   ; => (1 2 3)

;; Zip multiple lists
(zip '(1 2 3) '(a b c))          ; => ((1 a) (2 b) (3 c))

;; Group by key function
(group-by car '((a 1) (b 2) (a 3)))
; => ((a (a 1) (a 3)) (b (b 2)))

;; Remove duplicates
(unique '(1 2 1 3 2 4))          ; => (1 2 3 4)
(unique '(a b a) eq?)             ; custom comparator

;; Universal/existential quantifiers
(every number? '(1 2 3))          ; => #t
(any string? '(1 "a" 3))         ; => #t

;; Filter + map in one pass
(filter-map (lambda (x) (and (> x 2) (* x x))) '(1 2 3 4))
; => (9 16)
```

### `(std misc string)` — String Utilities

Exports 7 functions (not 14+), all re-exported by `(jerboa prelude)`.

```scheme
(import (std misc string))  ;; or just (import (jerboa prelude))

;; Split / join
(string-split "hello world foo" " ")   ; => ("hello" "world" "foo")
(string-split "hello world")           ; => ("hello" "world") — default space
(string-join '("a" "b" "c") "-")      ; => "a-b-c"
(string-join '("a" "b" "c"))          ; => "a b c" — default space

;; Trim whitespace (BOTH sides — not just leading!)
(string-trim "  hello  ")             ; => "hello"

;; Search
(string-contains "hello world" "world") ; => 6 (INDEX, not boolean!)
(string-contains "hello" "xyz")         ; => #f
(string-index "hello" #\l)             ; => 2 (takes a CHAR, not predicate)

;; Predicates
(string-prefix? "hel" "hello")        ; => #t
(string-suffix? "rld" "world")        ; => #t
(string-empty? "")                    ; => #t
```

**Important:** The module exports exactly 7 functions: `string-split`,
`string-join`, `string-trim`, `string-prefix?`, `string-suffix?`,
`string-contains`, `string-index`, `string-empty?`. Functions like
`string-replace`, `string-pad-left`, `string-capitalize`, `string-repeat` are
NOT in this module — use Chez builtins or implement manually.

---

## I/O and Files

### `(std misc ports)` — Port Utilities

Exports 7 functions, all re-exported by `(jerboa prelude)`.

```scheme
(import (std misc ports))  ;; or just (import (jerboa prelude))

;; Read from filename
(read-file-string "file.txt")        ; => string
(read-file-lines "file.txt")        ; => list of strings

;; Read from port
(read-all-as-string port)           ; => string
(read-all-as-lines port)            ; => list of strings

;; Write to filename
(write-file-string "out.txt" "content here")

;; String I/O helpers
(with-output-to-string (lambda () (display "hello")))  ; => "hello"
(with-input-from-string "42" (lambda () (read)))       ; => 42
```

**Note:** Function names are `read-file-string` (NOT `read-all-text`) and
`write-file-string` (NOT `write-all-text`).

### `(std os path)` — Path Manipulation

```scheme
(import (std os path))

;; Join path components
(path-join "/home/user" "projects" "my-app")
; => "/home/user/projects/my-app"

;; Split path
(path-split "/home/user/file.txt")
; => ("/home/user" "file.txt")

(path-dirname  "/home/user/file.txt")   ; => "/home/user"
(path-basename "/home/user/file.txt")   ; => "file.txt"
(path-extension "file.txt")             ; => ".txt"
(path-stem "file.txt")                  ; => "file"

;; Existence checks
(path-exists? "/etc/hosts")    ; => #t or #f
(path-directory? "/home")      ; => #t
(path-file? "/etc/hosts")      ; => #t

;; Absolute/relative
(path-absolute? "/etc")        ; => #t
(path-absolute "/etc")         ; => "/etc"  (resolve relative)

;; List directory
(directory-list "/tmp")        ; => list of filenames
```

### `(std os env)` — Environment Variables

```scheme
(import (std os env))

(getenv "HOME")                ; => "/home/user" or #f
(getenv "MISSING" "default")  ; => "default" if not set

(setenv! "MY_VAR" "value")
(unsetenv! "MY_VAR")

;; All environment variables
(environ)   ; => association list of ("NAME" . "value")
```

---

## Text Processing

### `(std text json)` — JSON Parse/Generate

JSON functions are re-exported by `(jerboa prelude)`.

```scheme
(import (jerboa prelude))  ;; or (import (std text json))

;; Parse JSON string -> Scheme value
(string->json-object "{\"name\": \"Alice\", \"age\": 30}")
; => hash table: {"name" => "Alice", "age" => 30}

;; Parse from port
(read-json (open-input-string "{\"x\": 1}"))

;; Generate JSON string from Scheme value
(json-object->string (hash "name" "Alice" "age" 30))
; => "{\"age\":30,\"name\":\"Alice\"}"

;; Write JSON to port
(write-json (hash "key" "value") (current-output-port))

;; Type mapping:
;;   JSON object  -> hash table
;;   JSON array   -> vector
;;   JSON string  -> string
;;   JSON number  -> number (exact if integer)
;;   JSON true    -> #t
;;   JSON false   -> #f
;;   JSON null    -> 'null or '()  (implementation-specific)
```

### `(std text csv)` — CSV Parsing

```scheme
(import (std text csv))

;; Parse CSV string
(csv-read-string "a,b,c\n1,2,3\n4,5,6")
; => (("a" "b" "c") ("1" "2" "3") ("4" "5" "6"))

;; Parse from file
(call-with-input-file "data.csv"
  (lambda (p) (csv-read p)))

;; Write CSV
(csv-write-string '(("name" "age") ("Alice" "30") ("Bob" "25")))
; => "name,age\nAlice,30\nBob,25\n"

;; Custom delimiter
(csv-read-string "a;b;c" #\;)
```

### `(std text yaml)` — YAML Support

```scheme
(import (std text yaml))   ; may require optional dependency

(yaml-read-string "name: Alice\nage: 30")
; => hash table

(yaml-write-string (hash "name" "Alice" "age" 30))
; => "age: 30\nname: Alice\n"
```

---

## Networking

### `(std net httpd)` — HTTP Server

```scheme
(import (std net httpd))

;; Start a basic HTTP server
(def server
  (make-httpd
    #:port 8080
    #:handler (lambda (req)
                (make-response 200 "OK"
                  '(("content-type" . "text/plain"))
                  "Hello, World!"))))

(httpd-start! server)
;; ... later ...
(httpd-stop! server)

;; Request accessors
(request-method  req)  ; => "GET", "POST", etc.
(request-path    req)  ; => "/path/to/resource"
(request-headers req)  ; => association list
(request-body    req)  ; => string or #f
```

### `(std net http)` — HTTP Client

```scheme
(import (std net http))

;; GET request
(def resp (http-get "https://example.com/api/data"))
(response-status  resp)   ; => 200
(response-headers resp)   ; => association list
(response-body    resp)   ; => string

;; POST with JSON body
(def resp
  (http-post "https://example.com/api"
    #:headers '(("content-type" . "application/json"))
    #:body (json-write-string (hash "key" "value"))))

;; PUT, DELETE, PATCH
(http-put    url #:body body)
(http-delete url)
(http-patch  url #:body body)
```

---

## Concurrency

### `(std misc channel)` — Channel-Based Communication

```scheme
(import (std misc channel))

;; Create a channel
(def ch (make-channel))

;; Send and receive (blocking)
(channel-put ch value)
(def val (channel-get ch))

;; Non-blocking variants
(channel-try-put ch value)    ; => #t or #f
(channel-try-get ch)          ; => value or #f

;; Close channel
(channel-close ch)

;; Check state
(channel-empty? ch)
```

### `(std misc thread)` — Thread Management (SRFI-18)

**Note:** Module name is `thread` (singular), NOT `threads`.
Re-exported by `(jerboa prelude)`.

```scheme
(import (std misc thread))  ;; or just (import (jerboa prelude))

;; Create and start
(def t (make-thread (lambda () (+ 1 2))))
(thread-start! t)
(thread-join! t)       ; => 3

;; spawn shorthand (starts immediately)
(def t2 (spawn (lambda () (* 6 7))))
(thread-join! t2)      ; => 42

;; Thread utilities
(thread-yield!)
(thread-sleep! 0.5)    ; 500ms
(current-thread)

;; Mutexes
(def m (make-mutex))
(mutex-lock! m)
(mutex-unlock! m)

;; Condition variables
(def cv (make-condition-variable))
(condition-variable-signal! cv)
(condition-variable-broadcast! cv)

;; Message passing
(thread-send t "hello")
(thread-receive)        ; blocks until message arrives
```

### `(std fiber)` — M:N Green Threads

Engine-based preemptive/cooperative fibers scheduled across OS worker threads.
Includes channels, cancellation, structured concurrency, and fiber-local storage.

```scheme
(import (std fiber))

;; Basic: spawn fibers and run
(with-fibers
  (fiber-spawn* (lambda () (displayln "hello from fiber")))
  (fiber-spawn* (lambda () (displayln "hello from another"))))

;; Yield and sleep
(fiber-yield)
(fiber-sleep 100)  ;; milliseconds

;; Fiber identity
(fiber-self)        ;; current fiber
(fiber-id f)        ;; unique integer id
(fiber-done? f)     ;; completion check

;; Channels (fiber-aware, buffered or unbounded)
(def ch (make-fiber-channel))      ;; unbounded
(def ch (make-fiber-channel 10))   ;; bounded capacity 10
(fiber-channel-send ch value)
(def val (fiber-channel-recv ch))
(fiber-channel-try-send ch value)  ;; non-blocking => #t/#f
(fiber-channel-try-recv ch)        ;; non-blocking => value or #f
(fiber-channel-close! ch)

;; Cancellation (cooperative)
(fiber-cancel! f)                  ;; set cancelled flag, wake if parked
(fiber-cancel! f 5000)             ;; cooperative, then force after 5s
(fiber-cancelled? f)               ;; check flag
(fiber-check-cancelled!)           ;; raise &fiber-cancelled if set
;; Cancellation points: yield, sleep, channel send/recv, select

;; Fiber-local storage
(def fp (make-fiber-parameter 'default))
(fp)           ;; read
(fp 'new-val)  ;; write
(fiber-parameterize ([fp 'temp-val])
  (fp))  ;; => temp-val  (restored after)

;; Join — block until fiber completes
(fiber-join f)          ;; returns result, re-raises exceptions
(fiber-join f 5000)     ;; with timeout (raises &fiber-timeout)

;; Link — Erlang-style crash propagation
(fiber-link! f)         ;; if f crashes, current fiber gets &fiber-linked-crash
(fiber-unlink! f)

;; Select — wait on multiple channels
(fiber-select
  [ch1 val => (handle val)]              ;; recv from ch1
  [ch2 :send msg => (sent)]             ;; send msg to ch2
  [:timeout 5000 => (timed-out)]        ;; timeout clause
  [:default => (nothing-ready)])        ;; non-blocking

;; Timeout — channel that fires after delay
(def tch (fiber-timeout 5000))
(fiber-channel-recv tch)  ;; blocks until timeout fires

;; Structured concurrency — scoped fiber groups
(with-fiber-group
  (lambda (g)
    (fiber-group-spawn g (lambda () (do-work-a)))
    (fiber-group-spawn g (lambda () (do-work-b)))
    ;; implicit: waits for all children
    ;; if any child raises, cancels siblings, re-raises in parent
    ))

;; Condition types
;; &fiber-cancelled   — raised at cancellation points
;; &fiber-timeout     — raised by fiber-join with timeout
;; &fiber-linked-crash — raised when a linked fiber crashes
```

### `(std misc process)` — Process Spawning

```scheme
(import (std misc process))

;; Run a command, capture stdout as string
(def output (run-process '("ls" "-la" "/tmp")))
; => stdout as string

;; Run command, get exit status only
(def status (run-process/batch '("touch" "file.txt")))
; => 0 (success)

;; With working directory
(run-process '("ls") directory: "/tmp")

;; Open process as readable port
(def port (open-input-process '("cat" "data.txt")))

;; Open process as writable port
(def out (open-output-process '("sort")))

;; Bidirectional process (returns process-port-rec)
(def proc (open-process '("grep" "pattern")))
```

---

## Database

### `(std db sqlite)` — SQLite

```scheme
(import (std db sqlite))

;; Open database
(def db (sqlite-open "my.db"))
(def db (sqlite-open ":memory:"))   ; in-memory

;; Execute DDL
(sqlite-exec db "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")

;; Insert
(sqlite-exec db "INSERT INTO users (name) VALUES (?)" "Alice")

;; Query — returns list of row vectors
(sqlite-query db "SELECT id, name FROM users WHERE id = ?" 1)
; => (#(1 "Alice"))

;; Prepared statement
(def stmt (sqlite-prepare db "SELECT * FROM users WHERE name = ?"))
(sqlite-step stmt "Alice")  ; => row or #f
(sqlite-finalize stmt)

;; Transaction
(sqlite-with-transaction db
  (lambda ()
    (sqlite-exec db "INSERT ..." ...)
    (sqlite-exec db "UPDATE ..." ...)))

;; Close
(sqlite-close db)
```

### `(std db postgresql)` — PostgreSQL

```scheme
(import (std db postgresql))

;; Connect
(def conn (pg-connect "host=localhost dbname=mydb user=myuser"))

;; Query
(pg-query conn "SELECT id, name FROM users WHERE active = $1" #t)
; => list of row association lists

;; Execute (non-SELECT)
(pg-exec conn "UPDATE users SET last_seen = NOW() WHERE id = $1" 42)

;; Transaction
(pg-with-transaction conn
  (lambda ()
    (pg-exec conn "INSERT ..." ...)
    (pg-exec conn "UPDATE ..." ...)))

;; Disconnect
(pg-close conn)
```

---

## Testing

### `(std test)` — Test Framework

```scheme
(import (std test))

;; Define a test suite
(test-suite "my-module tests"

  (test "addition works"
    (check (+ 1 2) => 3))

  (test "list operations"
    (check (length '(a b c)) => 3)
    (check (car '(1 2 3)) => 1))

  (test "exception is raised"
    (check-raises error? (error "test error"))))

;; Run tests
(run-tests)

;; check variants
(check expr => expected-value)
(check expr (? predicate))
(check-raises predicate body)
(check-not-raises body)

;; Benchmarking in tests
(test-bench "sorting performance"
  (sort (iota 10000) <))
```

---

## Utilities

### `(std misc getopt)` — CLI Argument Parsing

```scheme
(import (std misc getopt))

(def opts
  (getopt-parse
    '((verbose #\v "verbose output" #f)
      (output  #\o "output file" "out.txt")
      (count   #\n "repeat count" 1))
    (command-line-arguments)))

(option-value opts 'verbose)   ; => #t or #f
(option-value opts 'output)    ; => string
(option-value opts 'count)     ; => number
(option-remaining opts)        ; => non-option args
```

### `(std misc binary)` — Binary Data Operations

```scheme
(import (std misc binary))

;; Bytevector operations
(u8-ref  bv offset)
(u16-ref bv offset 'big)     ; big-endian
(u32-ref bv offset 'little)  ; little-endian
(u64-ref bv offset 'native)
(s8-ref  bv offset)
(s16-ref bv offset 'big)
(f32-ref bv offset 'big)
(f64-ref bv offset 'little)

;; Write
(u8-set!  bv offset 255)
(u32-set! bv offset 12345 'big)

;; Hex encoding
(bytevector->hex bv)           ; => "deadbeef"
(hex->bytevector "deadbeef")   ; => #vu8(222 173 190 239)

;; XOR, AND, OR over bytevectors
(bytevector-xor bv1 bv2)
(bytevector-and bv1 bv2)
```

### `(std crypto)` — Cryptography

```scheme
(import (std crypto))   ; may require optional library

;; Hashing
(sha256 "hello")                  ; => hex string
(sha256-bytevector bv)            ; => bytevector
(md5 "hello")                     ; => hex string

;; HMAC
(hmac-sha256 key message)

;; Random bytes
(random-bytevector 32)            ; 32 cryptographically random bytes

;; Base64
(base64-encode bv)                ; => string
(base64-decode "aGVsbG8=")        ; => bytevector
(base64url-encode bv)             ; URL-safe variant
```

---

## Module Organization Summary

```
(jerboa prelude)      ← start here for almost everything
(jerboa core)         ← just the macros (def/defstruct/match)
(jerboa reader)       ← {...} and [...] reader extensions

(std sort)            ← sorting
(jerboa runtime)      ← hash ops (hash-put!, hash-remove!, hash-key?)
(std misc list)       ← flatten, take, drop, zip, group-by, unique
(std misc string)     ← split, join, trim, contains, prefix?, suffix?

(std misc ports)      ← read-file-string, write-file-string
(std os path)         ← path-join, path-dirname, directory-list
(std os env)          ← getenv, setenv!

(std text json)       ← read-json, write-json, string->json-object
(std text csv)        ← CSV parse/write
(std text yaml)       ← YAML (optional)

(std net httpd)       ← HTTP server
(std net http)        ← HTTP client

(std fiber)           ← fiber-spawn*, fiber-join, fiber-cancel!, fiber-select, with-fiber-group
(std misc channel)    ← channel-put, channel-get
(std misc thread)     ← spawn, thread-start!, thread-join!, mutexes
(std misc process)    ← run-process, spawn-process

(std db sqlite)       ← SQLite
(std db postgresql)   ← PostgreSQL

(std test)            ← test-suite, check, run-tests

(std misc getopt)     ← CLI arg parsing
(std misc binary)     ← binary/bytevector utils
(std crypto)          ← hash, HMAC, random, base64 (optional)
```

---

*See also: `jerboa-idioms.md`, `jerboa-chez-interop.md`, `jerboa-pattern-matching.md`*
