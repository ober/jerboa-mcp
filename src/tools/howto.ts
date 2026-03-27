import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the repo-local cookbook that accumulates recipes across sessions. */
export const REPO_COOKBOOK_PATH = resolve(__dirname, '..', '..', 'cookbooks.json');

/**
 * Cached cookbook entries keyed by file path.
 * Each entry stores the parsed recipes and the file's mtime for invalidation.
 * This prevents re-reading and re-parsing the same file on every parallel call.
 */
const cookbookCache = new Map<string, { mtimeMs: number; recipes: Recipe[] }>();

export function loadCookbook(path: string): Recipe[] {
  try {
    const st = statSync(path);
    const cached = cookbookCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      return cached.recipes;
    }
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Defensive: ensure every entry has an iterable tags array
      const recipes = (parsed as Recipe[]).map(r => ({
        ...r,
        tags: Array.isArray(r.tags) ? r.tags : [],
        imports: Array.isArray(r.imports) ? r.imports : [],
      }));
      cookbookCache.set(path, { mtimeMs: st.mtimeMs, recipes });
      return recipes;
    }
  } catch {
    // Missing or invalid file — skip silently
  }
  return [];
}

/** Invalidate the cookbook cache for a specific path (used after howto_add writes). */
export function invalidateCookbookCache(path: string): void {
  cookbookCache.delete(path);
}

export interface Recipe {
  id: string;
  title: string;
  tags: string[];
  imports: string[];
  code: string;
  notes?: string;
  related?: string[];
  deprecated?: boolean;
  superseded_by?: string;
  valid_for?: string[];  // versions confirmed working
}

export const RECIPES: Recipe[] = [
  // ── JSON ──────────────────────────────────────────────────────────
  {
    id: 'json-parse',
    title: 'Parse JSON string',
    tags: ['json', 'parse', 'read', 'string', 'deserialize'],
    imports: ['(std text json)'],
    code: `(import (std text json))
(define data
  (call-with-string-input-port "{\\"name\\":\\"alice\\",\\"age\\":30}" read-json))
;; data is a hashtable: (hashtable-ref data "name" #f) => "alice"`,
    notes: 'read-json returns Chez hashtables for JSON objects, lists for JSON arrays.',
    related: ['json-generate', 'json-file'],
  },
  {
    id: 'json-generate',
    title: 'Generate JSON string',
    tags: ['json', 'write', 'generate', 'string', 'serialize', 'output'],
    imports: ['(std text json)'],
    code: `(import (std text json))
(define json-str
  (call-with-string-output-port
    (lambda (p)
      (write-json (hash ("name" "alice") ("age" 30)) p))))
;; => "{\\"name\\":\\"alice\\",\\"age\\":30}"`,
    related: ['json-parse'],
  },
  {
    id: 'json-file',
    title: 'Read/write JSON files',
    tags: ['json', 'file', 'read', 'write', 'io'],
    imports: ['(std text json)'],
    code: `(import (std text json))
;; Read:
(define config (call-with-input-file "config.json" read-json))
;; Write:
(call-with-output-file "output.json"
  (lambda (p) (write-json config p)))`,
    related: ['json-parse', 'json-generate'],
  },

  // ── File I/O ──────────────────────────────────────────────────────
  {
    id: 'file-read',
    title: 'Read file to string',
    tags: ['file', 'read', 'string', 'io', 'input'],
    imports: [],
    code: `(call-with-input-file "path.txt" read-line)
;; or read all lines:
(call-with-input-file "path.txt"
  (lambda (port)
    (let loop ([lines '()] [line (read-line port)])
      (if (eof-object? line)
        (string-join (reverse lines) "\\n")
        (loop (cons line lines) (read-line port))))))`,
    notes: 'For large files, consider reading in chunks with read-bytevector.',
  },
  {
    id: 'file-write',
    title: 'Write string to file',
    tags: ['file', 'write', 'string', 'io', 'output', 'save'],
    imports: [],
    code: `(call-with-output-file "output.txt"
  (lambda (port)
    (display "hello world" port)
    (newline port)))`,
  },

  // ── Sorting ───────────────────────────────────────────────────────
  {
    id: 'sort-list',
    title: 'Sort a list',
    tags: ['sort', 'order', 'list', 'compare'],
    imports: ['(std sort)'],
    code: `(import (std sort))
(sort '(3 1 4 1 5 9) <)          ;; => (1 1 3 4 5 9)
(sort '("banana" "apple" "cherry") string<?)
;; => ("apple" "banana" "cherry")

;; Sort by a key:
(sort '((3 "c") (1 "a") (2 "b"))
  (lambda (a b) (< (car a) (car b))))`,
  },

  // ── Hash Tables ───────────────────────────────────────────────────
  {
    id: 'hash-table-basics',
    title: 'Hash table operations',
    tags: ['hash', 'table', 'map', 'dictionary', 'lookup', 'create'],
    imports: [],
    code: `(def ht (hash ("name" "alice") ("age" 30)))   ;; literal syntax
(hash-ref ht "name")          ;; => "alice" (error if missing)
(hash-get ht "missing")       ;; => #f (safe lookup)
(hash-get ht "missing" 42)    ;; => 42 (custom default)
(hash-put! ht "email" "a@b")  ;; mutate
(hash-key? ht "name")         ;; => #t
(hash-remove! ht "age")
(hash->list ht)               ;; => (("name" . "alice") ...)`,
    notes: 'Use (hash ...) for string keys, (hash-eq ...) for symbol keys.',
    related: ['iterate-hash', 'hash-table-merge'],
  },
  {
    id: 'hash-table-merge',
    title: 'Merge hash tables',
    tags: ['hash', 'merge', 'combine', 'table'],
    imports: [],
    code: `(def defaults (hash ("port" 80) ("host" "localhost")))
(def overrides (hash ("port" 8080)))
(def config (hash-merge defaults overrides))
;; config has port=8080, host="localhost"`,
    related: ['hash-table-basics'],
  },
  {
    id: 'iterate-hash',
    title: 'Iterate over hash table',
    tags: ['hash', 'iterate', 'loop', 'for', 'keys', 'values'],
    imports: ['(std iter)'],
    code: `(import (std iter))
(def ht (hash ("a" 1) ("b" 2) ("c" 3)))
;; Key-value pairs:
(for ((k v) (in-hash ht)) (displayln k " => " v))
;; Keys only:
(for (k (in-hash-keys ht)) (displayln k))
;; Values only:
(for (v (in-hash-values ht)) (displayln v))`,
    related: ['hash-table-basics', 'for-collect'],
  },

  // ── Strings ───────────────────────────────────────────────────────
  {
    id: 'string-operations',
    title: 'String operations',
    tags: ['string', 'split', 'join', 'substring', 'text', 'manipulation'],
    imports: ['(std string)'],
    code: `(import (std string))
(string-split "a,b,c" #\\,)        ;; => ("a" "b" "c")
(string-join '("a" "b" "c") ",")   ;; => "a,b,c"
(string-prefix? "hello" "hello world")  ;; => #t
(string-contains "hello world" "world") ;; => index or #f`,
    related: ['regex-pattern'],
  },
  {
    id: 'regex-pattern',
    title: 'Regular expressions with pcre2',
    tags: ['regex', 'regexp', 'pattern', 'match', 'string', 'search', 'replace'],
    imports: ['(std pcre2)'],
    code: `(import (std pcre2))
(define pat (pcre2-compile "([a-z]+)@([a-z.]+)"))
(pcre2-match pat "user@example.com")
;; => ("user@example.com" "user" "example.com")`,
    related: ['string-operations'],
  },

  // ── Iteration ─────────────────────────────────────────────────────
  {
    id: 'for-collect',
    title: 'Collect results with for/collect',
    tags: ['for', 'collect', 'map', 'list', 'iterate', 'transform', 'loop'],
    imports: ['(std iter)'],
    code: `(import (std iter))
(for/collect (x '(1 2 3 4 5))
  (* x x))
;; => (1 4 9 16 25)

;; With filter:
(for/collect (x (in-range 1 20) when (zero? (modulo x 3)))
  x)
;; => (3 6 9 12 15 18)

;; With index:
(for/collect ((x i) (in-indexed '(a b c)))
  (list i x))
;; => ((0 a) (1 b) (2 c))`,
    related: ['for-fold'],
  },
  {
    id: 'for-fold',
    title: 'Reduce with for/fold',
    tags: ['for', 'fold', 'reduce', 'accumulate', 'sum', 'iterate', 'loop'],
    imports: ['(std iter)'],
    code: `(import (std iter))
;; Sum a list:
(for/fold (acc 0) (x '(1 2 3 4 5))
  (+ acc x))
;; => 15

;; Build a result hash:
(for/fold (ht (make-hash-table)) ((k v) (in-hash (hash ("a" 1) ("b" 2))))
  (hash-put! ht k (* v 10))
  ht)`,
    related: ['for-collect'],
  },

  // ── Error Handling ────────────────────────────────────────────────
  {
    id: 'error-handling',
    title: 'Error handling with guard',
    tags: ['error', 'exception', 'guard', 'catch', 'handle', 'finally'],
    imports: [],
    code: `;; R6RS guard form (Chez/Jerboa native):
(guard (e [else (displayln "Error: " (condition/report-string e))])
  (risky-operation))

;; Multiple clauses:
(guard (e
        [(string? (condition/report-string e))
         (displayln "string error")]
        [else
         (displayln "other: " (condition/report-string e))])
  (risky-operation))

;; with-exception-handler for non-error continuations:
(with-exception-handler
  (lambda (e)
    (displayln "caught: " (condition/report-string e))
    #f)
  (lambda () (risky-operation))
  #t)`,
    notes: 'Jerboa uses R6RS guard form. The #t third arg to with-exception-handler makes it a "raise-continuable" style handler.',
    related: ['custom-error'],
  },
  {
    id: 'custom-error',
    title: 'Define custom error/condition types',
    tags: ['error', 'custom', 'exception', 'condition', 'define', 'type'],
    imports: [],
    code: `;; Chez R6RS conditions:
(define-condition-type &my-error &error
  make-my-error my-error?
  (detail my-error-detail))

(define (validate x)
  (unless (number? x)
    (raise (condition
             (make-my-error "expected a number")
             (make-message-condition (format "got: ~a" x))))))

(guard (e [(my-error? e)
           (displayln "detail: " (my-error-detail e))])
  (validate "oops"))`,
    related: ['error-handling'],
  },

  // ── Structs & Classes ─────────────────────────────────────────────
  {
    id: 'defstruct-basics',
    title: 'Define and use structs',
    tags: ['struct', 'record', 'type', 'data', 'define', 'constructor', 'defstruct'],
    imports: [],
    code: `(defstruct point (x y) transparent: #t)
(def p (make-point 3 4))
(point-x p)              ;; => 3
(point? p)               ;; => #t
(point-x-set! p 10)      ;; mutate

;; Inheritance:
(defstruct (point3d point) (z) transparent: #t)
(def p3 (make-point3d 1 2 3))
(point-x p3)             ;; => 1 (inherited)
(point3d-z p3)           ;; => 3`,
  },
  {
    id: 'defclass-basics',
    title: 'Define classes with methods',
    tags: ['class', 'method', 'object', 'defclass', 'defmethod', 'oop'],
    imports: [],
    code: `(defclass animal (name sound))
(defmethod (speak (a animal))
  (displayln (animal-name a) " says " (animal-sound a)))

(def dog (make-animal "Rex" "woof"))
(speak dog)  ;; => Rex says woof

;; Inheritance:
(defclass (dog animal) (breed))
(defmethod (speak (d dog))
  (displayln (animal-name d) " barks!"))`,
    related: ['defstruct-basics'],
  },

  // ── Pattern Matching ─────────────────────────────────────────────
  {
    id: 'match-basics',
    title: 'Pattern matching with match',
    tags: ['match', 'pattern', 'destructure', 'case', 'dispatch'],
    imports: [],
    code: `(match value
  [42 "the answer"]
  [(? string?) (string-append "string: " value)]
  [(list x y) (+ x y)]
  [_ "default"])

;; Struct patterns:
(match p
  [(point x y) (sqrt (+ (* x x) (* y y)))])

;; Guard clauses:
(match n
  [(? number? x) (guard (> x 0)) "positive"]
  [(? number?) "non-positive"]
  [_ "not a number"])`,
  },

  // ── Optional/Keyword Args ─────────────────────────────────────────
  {
    id: 'optional-keyword-args',
    title: 'Optional and keyword arguments',
    tags: ['optional', 'keyword', 'argument', 'parameter', 'default', 'function', 'def'],
    imports: [],
    code: `;; Optional argument with default:
(def (greet name (greeting "Hello"))
  (string-append greeting ", " name "!"))
(greet "Alice")           ;; => "Hello, Alice!"
(greet "Alice" "Hi")      ;; => "Hi, Alice!"

;; Keyword argument:
(def (connect host port: (port 80) ssl: (ssl #f))
  (list host port ssl))
(connect "example.com")                    ;; => ("example.com" 80 #f)
(connect "example.com" port: 443 ssl: #t)  ;; => ("example.com" 443 #t)

;; Rest arguments:
(def (log level . messages)
  (displayln "[" level "] " (string-join (map object->string messages) " ")))`,
  },

  // ── Concurrency ───────────────────────────────────────────────────
  {
    id: 'spawn-thread',
    title: 'Spawn threads',
    tags: ['thread', 'spawn', 'concurrent', 'parallel', 'async'],
    imports: [],
    code: `(def t (spawn (lambda () (thread-sleep! 0.1) 42)))
(thread-join! t)  ;; => 42

;; Named thread:
(def worker (spawn/name 'my-worker
  (lambda ()
    (let loop ([i 0])
      (when (< i 10)
        (displayln "working " i)
        (loop (+ i 1)))))))
(thread-join! worker)`,
    related: ['channel-pattern', 'actor-pattern'],
  },
  {
    id: 'channel-pattern',
    title: 'Channel-based communication',
    tags: ['channel', 'thread', 'concurrent', 'message', 'producer', 'consumer', 'async'],
    imports: ['(std misc channel)'],
    code: `(import (std misc channel))
(def ch (make-channel))

;; Producer:
(spawn (lambda ()
  (for-each (lambda (x) (channel-put ch x)) '(1 2 3))
  (channel-close ch)))

;; Consumer — iterate until closed:
(let loop ()
  (let ([val (channel-try-get ch (eof-object))])
    (unless (eof-object? val)
      (displayln "got: " val)
      (loop))))`,
    notes: 'Use channel-get for blocking reads. Avoid tight spinning on channel-try-get — use channel-get instead.',
    related: ['spawn-thread'],
  },
  {
    id: 'actor-pattern',
    title: 'Actor pattern with spawn and mailbox',
    tags: ['actor', 'message', 'spawn', 'mailbox', 'concurrent', 'process'],
    imports: [],
    code: `(def (make-counter)
  (spawn (lambda ()
    (let loop ([n 0])
      (match (thread-receive)
        ['inc (loop (+ n 1))]
        ['get (thread-send (current-thread) n) (loop n)]
        ['stop (void)])))))

(def counter (make-counter))
(thread-send counter 'inc)
(thread-send counter 'inc)
(thread-send counter 'get)
(thread-receive)  ;; => 2
(thread-send counter 'stop)`,
    notes: 'thread-receive blocks until a message is available.',
    related: ['spawn-thread', 'channel-pattern'],
  },

  // ── Testing ───────────────────────────────────────────────────────
  {
    id: 'test-basics',
    title: 'Write tests with (std test)',
    tags: ['test', 'check', 'assert', 'suite', 'unit', 'testing'],
    imports: ['(std test)'],
    code: `(import (std test))
(export my-test)

(def my-test
  (test-suite "my module"
    (test-case "basic arithmetic"
      (check (+ 1 2) => 3)
      (check (* 3 4) => 12))
    (test-case "predicates"
      (check (string? "hi") ? values))
    (test-case "exceptions"
      (check-exception (error "boom") error-object?))))

;; Run: (run-tests! my-test) (test-report-summary!)`,
    notes: 'Test files should be named *-test.ss and export *-test symbols.',
  },

  // ── HTTP ──────────────────────────────────────────────────────────
  {
    id: 'http-client',
    title: 'HTTP GET request',
    tags: ['http', 'get', 'request', 'web', 'api', 'fetch', 'network', 'client'],
    imports: ['(std net http)'],
    code: `(import (std net http))
(def resp (http-get "https://api.example.com/data"
            headers: '(("Authorization" . "Bearer token"))))
(http-response-status resp)   ;; HTTP status code
(http-response-body resp)     ;; response body as string/bytes`,
    notes: 'Check the exact API of (std net http) with jerboa_module_exports — names may differ.',
    related: ['json-parse'],
  },

  // ── Import Modules ────────────────────────────────────────────────
  {
    id: 'import-module',
    title: 'Import Jerboa/Chez modules',
    tags: ['import', 'module', 'require', 'library', 'use'],
    imports: [],
    code: `;; Standard library modules use (std ...) form:
(import (std sort))
(import (std text json))
(import (std iter))
(import (std misc channel))

;; Jerboa prelude (auto-loaded in scripts run via jerboa):
(import (jerboa prelude))

;; Project-local modules:
(import (myproject utils))`,
    notes: 'Jerboa reader maps :std/foo -> (std foo) for compatibility with Gerbil-style imports.',
  },
];

const MAX_RESULTS = 5;

// ── Synonym expansion table ─────────────────────────────────────
// Maps common alternatives to their canonical forms for better recipe discovery.
const SYNONYM_MAP: Record<string, string[]> = {
  iterate: ['traverse', 'loop', 'for', 'each', 'walk'],
  traverse: ['iterate', 'loop', 'for', 'walk'],
  loop: ['iterate', 'for', 'each', 'traverse'],
  hash: ['hashtable', 'hash-table', 'dict', 'dictionary', 'map', 'hashmap'],
  dict: ['hash', 'hashtable', 'hash-table', 'dictionary', 'map'],
  map: ['hash', 'dict', 'transform', 'collect'],
  string: ['text', 'str'],
  text: ['string', 'str'],
  list: ['sequence', 'array', 'collection'],
  sequence: ['list', 'array', 'collection'],
  error: ['exception', 'catch', 'throw', 'raise', 'handle'],
  exception: ['error', 'catch', 'throw', 'raise'],
  catch: ['error', 'exception', 'handle', 'try', 'guard'],
  handle: ['error', 'exception', 'catch', 'try', 'guard'],
  guard: ['catch', 'error', 'exception', 'handle'],
  file: ['path', 'directory', 'io', 'fs'],
  path: ['file', 'directory', 'fs'],
  directory: ['file', 'path', 'dir', 'folder'],
  read: ['parse', 'load', 'input', 'get'],
  parse: ['read', 'load', 'deserialize', 'decode'],
  write: ['save', 'output', 'put', 'dump'],
  save: ['write', 'output', 'persist', 'store'],
  json: ['parse', 'serialize', 'deserialize'],
  http: ['web', 'request', 'api', 'fetch', 'network', 'url'],
  web: ['http', 'request', 'api', 'network'],
  request: ['http', 'web', 'api', 'fetch'],
  fetch: ['http', 'get', 'request', 'download'],
  thread: ['concurrent', 'parallel', 'spawn', 'async'],
  concurrent: ['thread', 'parallel', 'spawn', 'async'],
  async: ['thread', 'concurrent', 'parallel', 'spawn'],
  channel: ['message', 'queue', 'pipe', 'stream'],
  sort: ['order', 'rank', 'arrange'],
  filter: ['select', 'where', 'remove', 'keep'],
  reduce: ['fold', 'accumulate', 'aggregate'],
  fold: ['reduce', 'accumulate', 'aggregate'],
  collect: ['gather', 'map', 'transform', 'list'],
  test: ['check', 'assert', 'verify', 'unit', 'spec'],
  struct: ['record', 'type', 'data', 'class', 'object'],
  class: ['struct', 'record', 'type', 'object'],
  regex: ['regexp', 'pattern', 'match', 'search'],
  regexp: ['regex', 'pattern', 'match'],
  import: ['require', 'load', 'module', 'use'],
  module: ['import', 'package', 'library', 'lib'],
  database: ['db', 'sql', 'sqlite', 'postgres'],
  db: ['database', 'sql', 'sqlite', 'postgres'],
  actor: ['message', 'spawn', 'supervisor', 'process'],
  format: ['printf', 'sprintf', 'template', 'interpolate'],
  convert: ['transform', 'translate', 'cast', 'coerce'],
  create: ['make', 'new', 'build', 'construct', 'init'],
  delete: ['remove', 'drop', 'destroy', 'dispose'],
  update: ['modify', 'change', 'set', 'mutate', 'put'],
  find: ['search', 'lookup', 'locate', 'get', 'query'],
  search: ['find', 'lookup', 'locate', 'query'],
  split: ['tokenize', 'separate', 'break', 'divide'],
  join: ['concat', 'merge', 'combine', 'append'],
  merge: ['join', 'combine', 'concat'],
  keys: ['key', 'properties', 'fields', 'names'],
  values: ['value', 'entries', 'items'],
  bytes: ['binary', 'bytevector', 'byte', 'raw'],
  binary: ['bytes', 'bytevector', 'raw'],
  // ── Data structure aliases ──────────────────────────────────────
  alist: ['association', 'assoc', 'agetq', 'asetq', 'pairs'],
  association: ['alist', 'assoc', 'pairs'],
  pair: ['cons', 'tuple', 'dotted'],
  cons: ['pair', 'tuple'],
  vector: ['array', 'vec'],
  array: ['vector', 'list', 'sequence'],
  // ── List operation aliases ──────────────────────────────────────
  flatten: ['nest', 'unnest', 'deep'],
  unique: ['deduplicate', 'distinct', 'dedup', 'duplicates'],
  deduplicate: ['unique', 'distinct', 'dedup'],
  append: ['push', 'add', 'extend'],
  prepend: ['unshift', 'cons', 'push-front'],
  reverse: ['invert', 'flip', 'backwards'],
  take: ['head', 'first', 'prefix', 'slice'],
  drop: ['tail', 'rest', 'skip', 'slice'],
  chunk: ['partition', 'batch', 'group', 'split'],
  group: ['cluster', 'categorize', 'classify', 'chunk'],
  // ── Function composition ────────────────────────────────────────
  compose: ['pipe', 'chain', 'combine'],
  pipe: ['compose', 'chain', 'pipeline', 'thread'],
  // ── Concurrency ─────────────────────────────────────────────────
  mutex: ['lock', 'semaphore', 'synchronize'],
  lock: ['mutex', 'semaphore', 'critical'],
  timeout: ['delay', 'sleep', 'wait', 'timer'],
  delay: ['timeout', 'sleep', 'wait'],
  signal: ['event', 'notify', 'trigger'],
  // ── I/O and ports ───────────────────────────────────────────────
  port: ['stream', 'socket', 'io'],
  stream: ['port', 'socket', 'channel'],
  // ── Serialization ───────────────────────────────────────────────
  serialize: ['marshal', 'encode', 'dump', 'write'],
  deserialize: ['unmarshal', 'decode', 'load', 'read'],
  encode: ['serialize', 'marshal', 'convert'],
  decode: ['deserialize', 'unmarshal', 'parse'],
  // ── Collection operations ───────────────────────────────────────
  copy: ['clone', 'dup', 'duplicate'],
  clear: ['reset', 'empty', 'wipe'],
  count: ['length', 'size', 'cardinality'],
  length: ['count', 'size'],
  size: ['count', 'length'],
  // ── Macro / syntax ──────────────────────────────────────────────
  macro: ['syntax', 'defrule', 'defsyntax', 'sugar'],
  syntax: ['macro', 'defrule', 'rule'],
  callback: ['handler', 'hook', 'listener'],
  handler: ['callback', 'hook', 'listener'],
  // ── Predicate aliases ──────────────────────────────────────────
  predicate: ['test', 'check', 'query'],
  check: ['test', 'verify', 'assert', 'validate'],
};

/**
 * Expand a search word with synonyms.
 * Returns the original word plus all synonyms.
 */
function expandSynonyms(word: string): string[] {
  const result = [word];
  const synonyms = SYNONYM_MAP[word];
  if (synonyms) {
    result.push(...synonyms);
  }
  // Also check if any synonym map entry contains this word as a value
  for (const [key, values] of Object.entries(SYNONYM_MAP)) {
    if (values.includes(word) && !result.includes(key)) {
      result.push(key);
    }
  }
  return [...new Set(result)];
}

/**
 * Simple fuzzy matching: check if two strings are within edit distance 1
 * (single character insertion, deletion, or substitution).
 */
function fuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < 3 || b.length < 3) return false; // skip very short words

  // Check if one is a prefix of the other (partial match)
  if (a.length >= 3 && b.startsWith(a)) return true;
  if (b.length >= 3 && a.startsWith(b)) return true;

  // Levenshtein distance = 1
  let diffs = 0;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  }

  // Different lengths (insertion/deletion)
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  let j = 0;
  for (let i = 0; i < longer.length; i++) {
    if (j < shorter.length && longer[i] === shorter[j]) {
      j++;
    } else {
      diffs++;
      if (diffs > 1) return false;
    }
  }
  return true;
}

export function registerHowtoTool(server: McpServer): void {
  server.registerTool(
    'jerboa_howto',
    {
      title: 'Jerboa Cookbook',
      description:
        'Search curated Jerboa/Chez Scheme idioms and recipes by keyword. ' +
        'Returns code examples with imports and usage notes. ' +
        'Examples: "read json", "hash table iterate", "http get", "error handling", "spawn thread".',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        query: z
          .string()
          .describe(
            'Search keywords (e.g. "json parse", "file read", "channel thread")',
          ),
        cookbook_path: z
          .string()
          .optional()
          .describe(
            'Absolute path to a JSON cookbook file with additional recipes to merge (e.g. "/home/user/project/.claude/cookbooks.json")',
          ),
        compact: z
          .coerce.boolean()
          .optional()
          .describe(
            'If true, return only id, title, and tags for each match (no code). ' +
            'Use jerboa_howto_get to fetch full recipe by id. Default: false.',
          ),
        max_results: z
          .coerce.number()
          .optional()
          .describe(
            'Maximum number of results to return (default: 5).',
          ),
      },
    },
    async ({ query, cookbook_path, compact, max_results }) => {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0);

      if (words.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Please provide search keywords (e.g. "json parse", "file read").',
            },
          ],
          isError: true,
        };
      }

      // Always merge repo cookbook, then optionally an extra cookbook_path.
      let recipes: Recipe[] = RECIPES.slice();
      const sources = [REPO_COOKBOOK_PATH];
      if (cookbook_path) sources.push(cookbook_path);
      for (const src of sources) {
        const external = loadCookbook(src);
        if (external.length > 0) {
          const externalIds = new Set(external.map((r) => r.id));
          recipes = recipes.filter((r) => !externalIds.has(r.id)).concat(external);
        }
      }

      // Score each recipe (with synonym expansion and fuzzy matching)
      const scored = recipes.map((recipe) => {
        let score = 0;
        for (const word of words) {
          // Expand word with synonyms
          const expanded = expandSynonyms(word);

          for (const searchTerm of expanded) {
            // Weight: direct match = full weight, synonym match = half weight
            const weight = searchTerm === word ? 1.0 : 0.5;

            // Tags: weight 5
            for (const tag of recipe.tags) {
              if (tag.includes(searchTerm) || searchTerm.includes(tag)) {
                score += 5 * weight;
              } else if (fuzzyMatch(tag, searchTerm)) {
                score += 3 * weight; // fuzzy match gets lower weight
              }
            }
            // Title: weight 3
            if (recipe.title.toLowerCase().includes(searchTerm)) {
              score += 3 * weight;
            }
            // ID: weight 2
            if (recipe.id.includes(searchTerm)) {
              score += 2 * weight;
            }
            // Notes: weight 1
            if (recipe.notes?.toLowerCase().includes(searchTerm)) {
              score += 1 * weight;
            }
            // Code: weight 1
            if (recipe.code.toLowerCase().includes(searchTerm)) {
              score += 1 * weight;
            }
          }
        }
        // Deprioritize deprecated recipes
        if (recipe.deprecated) {
          score = Math.round(score * 0.1);
        }
        return { recipe, score };
      });

      // Sort by score descending, take top results
      const effectiveMaxResults = max_results ?? MAX_RESULTS;
      const matches = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, effectiveMaxResults);

      if (matches.length === 0) {
        const available = [...new Set(recipes.flatMap((r) => r.tags))]
          .sort()
          .join(', ');
        return {
          content: [
            {
              type: 'text' as const,
              text: `No recipes found for "${query}".\n\nAvailable topics: ${available}`,
            },
          ],
        };
      }

      // Compact mode: return only id, title, tags — no code
      if (compact) {
        const sections: string[] = [
          `Found ${matches.length} recipe(s) for "${query}" (compact):`,
          '',
        ];
        for (const { recipe } of matches) {
          const deprecated = recipe.deprecated ? ' [DEPRECATED]' : '';
          sections.push(`  ${recipe.id}${deprecated} — ${recipe.title}`);
          sections.push(`    tags: ${recipe.tags.join(', ')}`);
          if (recipe.imports.length > 0) {
            sections.push(`    imports: ${recipe.imports.join(' ')}`);
          }
        }
        sections.push('');
        sections.push('Use jerboa_howto_get with recipe id to fetch full code.');
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
        };
      }

      const sections: string[] = [
        `Found ${matches.length} recipe(s) for "${query}":`,
      ];

      for (const { recipe } of matches) {
        sections.push('');
        if (recipe.deprecated) {
          sections.push(`## [DEPRECATED] ${recipe.title}`);
          if (recipe.superseded_by) {
            sections.push(`Superseded by: "${recipe.superseded_by}"`);
          }
        } else {
          sections.push(`## ${recipe.title}`);
        }
        if (recipe.imports.length > 0) {
          sections.push(`Imports: ${recipe.imports.join(' ')}`);
        }
        sections.push('```scheme');
        sections.push(recipe.code);
        sections.push('```');
        if (recipe.notes) {
          sections.push(`Note: ${recipe.notes}`);
        }
        if (recipe.related && recipe.related.length > 0) {
          sections.push(`Related: ${recipe.related.join(', ')}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
