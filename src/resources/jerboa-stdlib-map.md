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
- `hash`, `hash-ref`, `hash-get`, `hash-set!`, `hash-for-each`, `hash->list`
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
[1 2 3]                  ; => list (1 2 3)
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

### `(std misc hash)` — Additional Hash Operations

```scheme
(import (std misc hash))

;; Merge two hash tables (second wins on conflict)
(hash-merge h1 h2)

;; Map over values
(hash-map (lambda (k v) (* v 2)) h)

;; Filter entries
(hash-filter (lambda (k v) (> v 0)) h)

;; Update a key with a function
(hash-update! h "count" (lambda (v) (+ v 1)) 0)

;; Construct from two lists
(alist->hash '((a . 1) (b . 2)))
(zip->hash keys values)
```

### `(std misc list)` — Extended List Operations

```scheme
(import (std misc list))

;; Flatten nested lists
(list-flatten '(1 (2 (3 4) 5) 6))
; => (1 2 3 4 5 6)

;; Take/drop
(list-take '(a b c d e) 3)    ; => (a b c)
(list-drop '(a b c d e) 3)    ; => (d e)

;; Zip multiple lists
(list-zip '(1 2 3) '(a b c))
; => ((1 a) (2 b) (3 c))

;; Group by key function
(list-group-by even? '(1 2 3 4 5 6))
; => ((#t 2 4 6) (#f 1 3 5))

;; Remove duplicates
(list-unique '(1 2 1 3 2 4))  ; => (1 2 3 4)

;; Find first matching
(list-find odd? '(2 4 5 6))   ; => 5

;; Partition
(list-partition odd? '(1 2 3 4 5))
; => (values '(1 3 5) '(2 4))

;; Last element
(list-last '(1 2 3))          ; => 3
```

### `(std misc string)` — String Utilities

```scheme
(import (std misc string))

;; Split / join
(string-split "hello world foo" " ")   ; => ("hello" "world" "foo")
(string-join '("a" "b" "c") "-")      ; => "a-b-c"

;; Trim whitespace
(string-trim "  hello  ")             ; => "hello"
(string-trim-left "  hello  ")        ; => "hello  "
(string-trim-right "  hello  ")       ; => "  hello"

;; Prefix/suffix
(string-prefix? "hel" "hello")        ; => #t
(string-suffix? "rld" "world")        ; => #t

;; Replace
(string-replace "hello world" "world" "there")
; => "hello there"

;; Pad
(string-pad-left "42" 5)              ; => "   42"
(string-pad-right "hi" 5 #\.)        ; => "hi..."

;; Case conversion
(string-capitalize "hello world")     ; => "Hello World"

;; Repeat
(string-repeat "ab" 3)                ; => "ababab"
```

---

## I/O and Files

### `(std misc ports)` — Port Utilities

```scheme
(import (std misc ports))

;; Read entire file as string
(read-all-text "file.txt")

;; Read entire file as lines
(read-all-lines "file.txt")   ; => list of strings

;; Write string to file
(write-all-text "out.txt" "content here")

;; Read all bytes
(read-all-bytes "binary.bin")  ; => bytevector

;; Port predicate helpers
(input-port? p)
(output-port? p)
(binary-port? p)
(textual-port? p)
```

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

```scheme
(import (std text json))

;; Parse JSON string -> Scheme value
(json-read-string "{\"name\": \"Alice\", \"age\": 30}")
; => hash table: {"name" => "Alice", "age" => 30}

;; Parse from port
(call-with-input-file "data.json"
  (lambda (p) (json-read p)))

;; Generate JSON string from Scheme value
(json-write-string (hash "name" "Alice" "age" 30))
; => "{\"age\":30,\"name\":\"Alice\"}"

;; Pretty JSON
(json-write-string value #t)  ; #t = pretty print

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

;; Create a buffered or unbuffered channel
(def ch  (make-channel))        ; unbuffered (synchronous)
(def bch (make-channel 10))     ; buffered (capacity 10)

;; Send (blocks if full)
(channel-send! ch value)

;; Receive (blocks until available)
(def val (channel-receive! ch))

;; Non-blocking variants
(channel-try-send! ch value)    ; => #t or #f
(channel-try-receive! ch)       ; => value or #f

;; Close channel (receivers get #!eof after drain)
(channel-close! ch)

;; Check state
(channel-empty? ch)
(channel-full? ch)
(channel-closed? ch)
```

### `(std misc threads)` — Thread Management

```scheme
(import (std misc threads))

;; Spawn a thread
(def t (thread-spawn (lambda () (+ 1 2))))

;; Wait for result
(thread-join t)    ; => 3

;; Detached thread (fire and forget)
(thread-spawn/detach (lambda () (do-background-work)))

;; Thread pool
(def pool (make-thread-pool 4))   ; 4 worker threads
(thread-pool-submit! pool thunk)
(thread-pool-wait! pool)          ; wait for all pending
(thread-pool-shutdown! pool)
```

### `(std misc process)` — Process Spawning

```scheme
(import (std misc process))

;; Run a command, capture output
(def result (run-process '("ls" "-la" "/tmp")))
(process-stdout result)   ; => string
(process-stderr result)   ; => string
(process-exit-code result) ; => integer

;; Pipeline (chain stdout to next stdin)
(run-pipeline
  '("echo" "hello world")
  '("tr" "a-z" "A-Z"))
; => "HELLO WORLD\n"

;; Async process
(def proc (spawn-process '("long-running" "command")))
(process-wait proc)       ; block until done
(process-kill proc)       ; send SIGTERM
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
(std misc hash)       ← extra hash ops
(std misc list)       ← flatten, take, drop, zip, group-by
(std misc string)     ← split, join, trim, pad, replace

(std misc ports)      ← read-all-text, write-all-text
(std os path)         ← path-join, path-dirname, directory-list
(std os env)          ← getenv, setenv!

(std text json)       ← JSON parse/generate
(std text csv)        ← CSV parse/write
(std text yaml)       ← YAML (optional)

(std net httpd)       ← HTTP server
(std net http)        ← HTTP client

(std misc channel)    ← channel send/receive
(std misc threads)    ← thread-spawn, thread-join, thread-pool
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
