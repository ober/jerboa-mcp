/**
 * jerboa_stdlib_search — Intent-based search over Jerboa's stdlib and cookbook.
 *
 * Searches by intent/keywords across:
 * 1. Cookbook recipes (id, title, tags, notes)
 * 2. Standard library module names and import paths
 * 3. Known symbol groupings from the prelude quick-reference
 *
 * Unlike jerboa_howto (which searches recipes) or jerboa_apropos (which searches
 * symbols by name prefix), this tool is for "what do I use when I want to X?" —
 * e.g. "safe file read", "sort a list", "parse JSON", "send HTTP request".
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COOKBOOKS_PATH = resolve(__dirname, '..', '..', 'cookbooks.json');

interface CookbookEntry {
  id: string;
  title: string;
  tags: string[];
  imports: string[];
  code: string;
  notes?: string;
  related?: string[];
}

/** Known stdlib modules with their purpose and key exports. */
const STDLIB_MODULES: Array<{
  path: string;
  description: string;
  keywords: string[];
  keyExports: string[];
}> = [
  {
    path: '(jerboa prelude)',
    description: 'Kitchen sink: 200+ symbols. Start here for any Jerboa file.',
    keywords: ['import', 'start', 'basic', 'prelude', 'setup', 'default', 'all'],
    keyExports: ['def', 'defstruct', 'defclass', 'match', 'try', 'for', 'format', 'hash-put!', 'hash-ref', 'sort'],
  },
  {
    path: '(std sort)',
    description: 'Sorting and ordering',
    keywords: ['sort', 'order', 'arrange', 'compare', 'rank'],
    keyExports: ['sort', 'sort!', 'stable-sort', 'stable-sort!'],
  },
  {
    path: '(std text json)',
    description: 'JSON parsing and serialization',
    keywords: ['json', 'parse', 'serialize', 'deserialize', 'decode', 'encode', 'api', 'rest'],
    keyExports: ['read-json', 'write-json', 'string->json-object', 'json-object->string'],
  },
  {
    path: '(std csv)',
    description: 'CSV reading and writing',
    keywords: ['csv', 'spreadsheet', 'tabular', 'comma', 'table'],
    keyExports: ['read-csv', 'write-csv', 'csv->alists', 'alists->csv'],
  },
  {
    path: '(std misc string)',
    description: 'String utilities: split, join, trim, search',
    keywords: ['string', 'text', 'split', 'join', 'trim', 'substring', 'search', 'contains'],
    keyExports: ['string-split', 'string-join', 'string-trim', 'string-prefix?', 'string-contains', 'string-empty?'],
  },
  {
    path: '(std misc list)',
    description: 'List utilities: flatten, group-by, zip, partition, take, drop',
    keywords: ['list', 'flatten', 'group', 'zip', 'partition', 'take', 'drop', 'slice', 'chunk'],
    keyExports: ['flatten', 'unique', 'group-by', 'zip', 'take', 'drop', 'partition', 'frequencies'],
  },
  {
    path: '(std misc thread)',
    description: 'Concurrency: threads, mutexes, channels',
    keywords: ['thread', 'concurrent', 'parallel', 'mutex', 'channel', 'spawn', 'async', 'sync'],
    keyExports: ['spawn', 'spawn/name', 'mutex-lock!', 'mutex-unlock!', 'thread-send', 'thread-receive'],
  },
  {
    path: '(std misc process)',
    description: 'Run external shell commands and processes',
    keywords: ['process', 'shell', 'command', 'subprocess', 'exec', 'run', 'spawn'],
    keyExports: ['run-process', 'run-process/batch', 'open-input-process'],
  },
  {
    path: '(std misc ports)',
    description: 'Port/file I/O utilities',
    keywords: ['file', 'read', 'write', 'port', 'io', 'input', 'output', 'stream'],
    keyExports: ['read-file-string', 'read-file-lines', 'write-file-string', 'read-all-as-string'],
  },
  {
    path: '(std misc func)',
    description: 'Functional programming combinators',
    keywords: ['compose', 'curry', 'partial', 'functional', 'higher-order', 'lambda', 'pipe'],
    keyExports: ['compose', 'curry', 'negate', 'identity', 'constantly', 'flip', 'juxt', 'partial'],
  },
  {
    path: '(std net tcp)',
    description: 'TCP client and server sockets',
    keywords: ['tcp', 'socket', 'network', 'connect', 'listen', 'server', 'client'],
    keyExports: ['tcp-listen', 'tcp-accept', 'tcp-connect', 'tcp-close'],
  },
  {
    path: '(std net request)',
    description: 'HTTP client: GET, POST, headers',
    keywords: ['http', 'https', 'request', 'get', 'post', 'api', 'rest', 'fetch', 'web', 'curl'],
    keyExports: ['http-get', 'http-post', 'http-request'],
  },
  {
    path: '(std net httpd)',
    description: 'HTTP server: routes, handlers, responses',
    keywords: ['httpd', 'server', 'web', 'route', 'handler', 'serve', 'api', 'endpoint'],
    keyExports: ['httpd-start', 'httpd-route', 'http-respond-json'],
  },
  {
    path: '(std db sqlite)',
    description: 'SQLite database: open, query, exec',
    keywords: ['sqlite', 'database', 'db', 'sql', 'query', 'persist', 'store'],
    keyExports: ['sqlite-open', 'sqlite-close', 'sqlite-exec', 'sqlite-query'],
  },
  {
    path: '(std db duckdb)',
    description: 'DuckDB in-process OLAP database',
    keywords: ['duckdb', 'olap', 'analytics', 'database', 'parquet', 'columnar'],
    keyExports: ['duckdb-open', 'duckdb-query', 'duckdb-exec'],
  },
  {
    path: '(std os env)',
    description: 'Environment variables',
    keywords: ['env', 'environment', 'variable', 'getenv', 'config'],
    keyExports: ['getenv', 'setenv', 'unsetenv'],
  },
  {
    path: '(std os path)',
    description: 'Path manipulation',
    keywords: ['path', 'directory', 'file', 'join', 'expand', 'normalize'],
    keyExports: ['path-join', 'path-expand', 'path-normalize', 'path-absolute?'],
  },
  {
    path: '(std os signal)',
    description: 'Unix signal handling (SIGINT, SIGTERM, etc.)',
    keywords: ['signal', 'sigint', 'sigterm', 'ctrl-c', 'shutdown', 'interrupt'],
    keyExports: ['signal-handler', 'handle-signal', 'default-signal-handler'],
  },
  {
    path: '(std crypto digest)',
    description: 'Cryptographic hash functions: MD5, SHA-1, SHA-256, SHA-512',
    keywords: ['hash', 'sha', 'md5', 'sha256', 'digest', 'checksum', 'crypto'],
    keyExports: ['md5', 'sha1', 'sha256', 'sha512', 'digest->hex-string'],
  },
  {
    path: '(std crypto random)',
    description: 'Cryptographically secure random numbers',
    keywords: ['random', 'uuid', 'token', 'secure', 'nonce', 'crypto'],
    keyExports: ['random-bytes', 'random-u64', 'random-token', 'random-uuid'],
  },
  {
    path: '(std text regex)',
    description: 'Regular expression matching',
    keywords: ['regex', 'regexp', 'pattern', 'match', 'search', 'replace'],
    keyExports: ['regex-match', 'regex-search', 'regex-replace'],
  },
  {
    path: '(std text xml)',
    description: 'XML/HTML parsing and generation',
    keywords: ['xml', 'html', 'sxml', 'parse', 'document', 'dom'],
    keyExports: ['xml->sxml', 'sxml->xml', 'html->sxml'],
  },
  {
    path: '(std text yaml)',
    description: 'YAML parsing and serialization',
    keywords: ['yaml', 'config', 'parse', 'serialize'],
    keyExports: ['yaml->object', 'object->yaml', 'read-yaml'],
  },
  {
    path: '(std actor)',
    description: 'Actor system: actors, messages, supervision',
    keywords: ['actor', 'message', 'concurrent', 'supervision', 'mailbox', 'erlang'],
    keyExports: ['make-actor', 'actor-send!', 'actor-receive', 'actor-supervisor'],
  },
  {
    path: '(std async)',
    description: 'Async/await style concurrency',
    keywords: ['async', 'await', 'promise', 'future', 'non-blocking'],
    keyExports: ['async', 'await', 'async-let', 'make-promise'],
  },
  {
    path: '(std stm)',
    description: 'Software transactional memory with Clojure-style refs',
    keywords: ['stm', 'transaction', 'atomic', 'tvar', 'concurrent', 'shared', 'ref', 'dosync', 'alter', 'commute'],
    keyExports: ['make-tvar', 'atomically', 'tvar-read', 'tvar-write!', 'retry', 'or-else', 'make-ref', 'ref?', 'ref-deref', 'dosync', 'alter', 'ref-set', 'commute', 'ensure'],
  },
  {
    path: '(std seq)',
    description: 'Lazy sequences, transducers, and parallel collections',
    keywords: ['lazy', 'sequence', 'transducer', 'parallel', 'infinite', 'range', 'iterate', 'cycle', 'repeat', 'map', 'filter'],
    keyExports: ['lazy-cons', 'lazy-first', 'lazy-rest', 'lazy-nil', 'lazy-range', 'lazy-iterate', 'lazy-repeat', 'lazy-cycle', 'lazy-map', 'lazy-filter', 'lazy-take', 'lazy-drop', 'lazy-take-while', 'lazy-drop-while', 'lazy->list', 'list->lazy', 'lazy-concat', 'lazy-interleave', 'lazy-mapcat', 'lazy-interpose', 'lazy-partition', 'transduce', 'into', 'sequence', 'par-map', 'par-filter', 'par-reduce'],
  },
  {
    path: '(std fiber)',
    description: 'M:N green threads with engine-based preemption, channels, cancellation, structured concurrency',
    keywords: ['fiber', 'green-thread', 'coroutine', 'concurrency', 'channel', 'cancel', 'timeout', 'group', 'select', 'join', 'link', 'structured'],
    keyExports: ['fiber-spawn*', 'fiber-yield', 'fiber-sleep', 'fiber-join', 'fiber-cancel!', 'fiber-select', 'with-fiber-group', 'fiber-group-spawn', 'make-fiber-parameter', 'fiber-parameterize', 'fiber-link!', 'fiber-timeout', 'make-fiber-channel', 'fiber-channel-send', 'fiber-channel-recv', 'with-fibers'],
  },
  {
    path: '(std result)',
    description: 'Rust-inspired Result type: ok/err/unwrap/map',
    keywords: ['result', 'ok', 'err', 'error', 'option', 'maybe', 'unwrap', 'rust'],
    keyExports: ['ok', 'err', 'ok?', 'unwrap', 'unwrap-or', 'map-ok', 'and-then'],
  },
  {
    path: '(std datetime)',
    description: 'Date and time: parse, format, arithmetic',
    keywords: ['date', 'time', 'datetime', 'timestamp', 'parse', 'format', 'duration'],
    keyExports: ['datetime-now', 'parse-datetime', 'datetime->iso8601', 'datetime-add', 'datetime-diff'],
  },
  {
    path: '(std iter)',
    description: 'Iteration forms with :when, :while, :let clause extensions',
    keywords: ['iterator', 'iterate', 'lazy', 'stream', 'range', 'sequence', 'for-each', 'when', 'while', 'let', 'clause', 'comprehension'],
    keyExports: ['for', 'for/collect', 'for/fold', 'for/or', 'for/and', 'in-list', 'in-range', 'in-hash-pairs', 'in-lines'],
  },
  {
    path: '(std sugar)',
    description: 'Syntactic sugar: ->, ->>, when-let, awhen, str, with-resource',
    keywords: ['sugar', 'macro', 'thread', 'pipe', 'when', 'anaphora', 'resource'],
    keyExports: ['->', '->>', 'as->', 'awhen', 'aif', 'when-let', 'with-resource', 'str'],
  },
  {
    path: '(std security sandbox)',
    description: 'Sandboxing: restrict capabilities of untrusted code',
    keywords: ['sandbox', 'security', 'restrict', 'capability', 'isolation'],
    keyExports: ['make-sandbox', 'sandbox-eval', 'sandbox-restrict'],
  },
  {
    path: '(std lazy-seq)',
    description: 'Clojure-style lazy sequences with memoized thunks',
    keywords: ['lazy', 'sequence', 'infinite', 'stream', 'cycle', 'repeat', 'iterate', 'memoize', 'clojure'],
    keyExports: ['lazy-seq', 'lazy-cons', 'lz-first', 'lz-rest', 'lz-seq', 'lz-empty?', 'lz-map', 'lz-filter', 'lz-take', 'lz-drop', 'lz-range', 'lz-repeat', 'lz-cycle', 'lz-iterate', 'lz-concat', 'lz-interleave', 'lz->list'],
  },
  {
    path: '(std zipper)',
    description: 'Huet-style functional zippers for tree navigation and editing',
    keywords: ['zipper', 'tree', 'navigate', 'edit', 'functional', 'cursor', 'huet', 'ast'],
    keyExports: ['list-zip', 'vector-zip', 'zip-node', 'zip-down', 'zip-up', 'zip-left', 'zip-right', 'zip-replace', 'zip-edit', 'zip-insert-left', 'zip-insert-right', 'zip-remove', 'zip-root', 'zip-end?', 'zip-next', 'zip-prev'],
  },
  {
    path: '(std test check)',
    description: 'Property-based testing with generators, shrinking, and check',
    keywords: ['property', 'test', 'generative', 'quickcheck', 'shrink', 'random', 'generator', 'check'],
    keyExports: ['gen:integer', 'gen:boolean', 'gen:char', 'gen:string', 'gen:list', 'gen:one-of', 'gen:such-that', 'gen:fmap', 'gen:bind', 'gen:tuple', 'for-all', 'check-property', 'quick-check'],
  },
  {
    path: '(std text edn)',
    description: 'EDN (Extensible Data Notation) reader and writer with tagged literals',
    keywords: ['edn', 'data', 'serialize', 'clojure', 'tagged', 'literal', 'notation', 'read', 'write'],
    keyExports: ['read-edn', 'read-edn-string', 'write-edn', 'write-edn-string', 'edn-tag', 'edn-register-tag!', 'edn-tagged?'],
  },
  {
    path: '(std specter)',
    description: 'Specter-style composable path navigation for nested data',
    keywords: ['specter', 'path', 'navigate', 'transform', 'nested', 'lens', 'select', 'update', 'setval'],
    keyExports: ['sp-select', 'sp-transform', 'sp-setval', 'ALL', 'FIRST', 'LAST', 'MAP-KEYS', 'MAP-VALS', 'INDEXED-VALS', 'sp-filterer', 'sp-pred', 'sp-keypath', 'sp-must', 'sp-nil->val', 'sp-multi-path', 'sp-if-path', 'sp-cond-path', 'sp-comp'],
  },
  {
    path: '(std component)',
    description: 'Stuart Sierra-style component lifecycle with dependency ordering',
    keywords: ['component', 'lifecycle', 'system', 'dependency', 'start', 'stop', 'service', 'server', 'sierra'],
    keyExports: ['component', 'component?', 'component-name', 'component-state', 'component-config', 'register-lifecycle!', 'system-map', 'system-using', 'start', 'stop', 'component-started?', 'system-started?'],
  },
  {
    path: '(std clojure)',
    description: 'Clojure-style persistent data structures and idioms',
    keywords: ['clojure', 'persistent', 'immutable', 'hash-map', 'hash-set', 'vector', 'assoc', 'dissoc', 'conj', 'get', 'reduce', 'atom', 'deref', 'swap'],
    keyExports: ['hash-map', 'hash-set', 'persistent-vector', 'assoc', 'dissoc', 'conj', 'get', 'contains?', 'keys', 'vals', 'merge', 'update', 'select-keys', 'get-in', 'assoc-in', 'update-in', 'make-atom', 'deref', 'swap!', 'reset!', 'delay', 'force', 'future', 'promise', 'deliver', 'realized?', 'set-select', 'set-project', 'set-rename', 'set-index', 'set-join', 'map-invert'],
  },
];

function loadCookbooks(): CookbookEntry[] {
  try {
    const raw = readFileSync(COOKBOOKS_PATH, 'utf-8');
    return JSON.parse(raw) as CookbookEntry[];
  } catch {
    return [];
  }
}

/** Tokenize a query string into lowercase words. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s\-_./,;:()[\]{}]+/)
    .filter((t) => t.length >= 2);
}

/** Expand common synonyms. */
function expandSynonyms(tokens: string[]): string[] {
  const synonyms: Record<string, string[]> = {
    'read': ['parse', 'load', 'input', 'import'],
    'write': ['output', 'save', 'export', 'dump'],
    'file': ['path', 'disk', 'io', 'port'],
    'web': ['http', 'request', 'api', 'rest', 'url'],
    'db': ['database', 'sqlite', 'sql', 'persist'],
    'safe': ['secure', 'validate', 'check', 'protect'],
    'async': ['concurrent', 'parallel', 'thread', 'non-blocking'],
    'map': ['transform', 'convert', 'apply'],
    'filter': ['select', 'keep', 'where'],
    'find': ['search', 'lookup', 'locate'],
    'format': ['print', 'display', 'stringify', 'serialize'],
    'error': ['exception', 'condition', 'fail'],
    'test': ['check', 'assert', 'verify', 'spec'],
  };
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const syns = synonyms[t];
    if (syns) syns.forEach((s) => expanded.add(s));
  }
  return [...expanded];
}

/** Score a cookbook entry against query tokens (higher = better). */
function scoreCookbook(entry: CookbookEntry, tokens: string[]): number {
  let score = 0;
  const fields = [
    entry.title.toLowerCase(),
    entry.id.toLowerCase(),
    (entry.tags ?? []).join(' ').toLowerCase(),
    (entry.notes ?? '').toLowerCase(),
  ];
  const allText = fields.join(' ');

  for (const tok of tokens) {
    // Title / id / tag match = high value
    if (entry.title.toLowerCase().includes(tok)) score += 5;
    if (entry.id.toLowerCase().includes(tok)) score += 3;
    for (const tag of entry.tags ?? []) {
      if (tag.toLowerCase().includes(tok) || tok.includes(tag.toLowerCase())) score += 4;
    }
    // Notes match
    if ((entry.notes ?? '').toLowerCase().includes(tok)) score += 1;
    // Code match
    if (entry.code.toLowerCase().includes(tok)) score += 1;
    // Any field
    if (allText.includes(tok)) score += 1;
  }
  return score;
}

/** Score a stdlib module entry against query tokens. */
function scoreModule(mod: (typeof STDLIB_MODULES)[0], tokens: string[]): number {
  let score = 0;
  const allText = [
    mod.path.toLowerCase(),
    mod.description.toLowerCase(),
    mod.keywords.join(' ').toLowerCase(),
    mod.keyExports.join(' ').toLowerCase(),
  ].join(' ');

  for (const tok of tokens) {
    if (mod.path.toLowerCase().includes(tok)) score += 6;
    if (mod.description.toLowerCase().includes(tok)) score += 4;
    for (const kw of mod.keywords) {
      if (kw === tok) score += 5;
      else if (kw.includes(tok) || tok.includes(kw)) score += 2;
    }
    for (const ex of mod.keyExports) {
      if (ex.toLowerCase().includes(tok)) score += 3;
    }
    if (allText.includes(tok)) score += 1;
  }
  return score;
}

export function registerStdlibSearchTool(server: McpServer): void {
  server.registerTool(
    'jerboa_stdlib_search',
    {
      title: 'Search Jerboa Stdlib and Cookbook by Intent',
      description:
        'Intent-based search over Jerboa\'s standard library modules and cookbook recipes. ' +
        'Unlike jerboa_howto (recipe search) or jerboa_apropos (symbol-name search), ' +
        'this tool answers "what module/recipe do I use when I want to X?" ' +
        'Examples: "safe file read", "sort a list", "parse JSON", "send HTTP request", ' +
        '"concurrent threads", "crypto hash", "sql database". ' +
        'Searches module paths, descriptions, keywords, exports, cookbook titles, and tags. ' +
        'Returns ranked results with import paths and key exports.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        query: z.string().describe('Intent or keyword query (e.g. "parse json", "safe file read", "sort list")'),
        max_results: z.coerce.number().optional()
          .describe('Maximum results to return per category (default: 5)'),
        include_cookbook: z.coerce.boolean().optional()
          .describe('Include cookbook recipe matches (default: true)'),
        include_modules: z.coerce.boolean().optional()
          .describe('Include stdlib module matches (default: true)'),
      },
    },
    async ({ query, max_results, include_cookbook, include_modules }) => {
      const maxN = max_results ?? 5;
      const showCookbook = include_cookbook !== false;
      const showModules = include_modules !== false;

      const rawTokens = tokenize(query);
      if (rawTokens.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Query too short or empty.' }],
          isError: true,
        };
      }
      const tokens = expandSynonyms(rawTokens);

      const lines: string[] = [];
      lines.push(`Search results for: "${query}"`);
      lines.push(`(tokens: ${rawTokens.join(', ')})`);
      lines.push('');

      // Module results
      if (showModules) {
        const scoredModules = STDLIB_MODULES
          .map((m) => ({ m, score: scoreModule(m, tokens) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxN);

        if (scoredModules.length > 0) {
          lines.push(`## Standard Library Modules`);
          lines.push('');
          for (const { m } of scoredModules) {
            lines.push(`**\`${m.path}\`** — ${m.description}`);
            lines.push(`  Key exports: ${m.keyExports.slice(0, 6).join(', ')}`);
            lines.push(`  Import: \`(import ${m.path})\``);
            lines.push('');
          }
        } else {
          lines.push('## Standard Library Modules');
          lines.push('');
          lines.push('No matching modules found for this query.');
          lines.push('');
        }
      }

      // Cookbook results
      if (showCookbook) {
        const cookbooks = loadCookbooks();
        const scoredRecipes = cookbooks
          .map((e) => ({ e, score: scoreCookbook(e, tokens) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxN);

        if (scoredRecipes.length > 0) {
          lines.push(`## Cookbook Recipes`);
          lines.push('');
          for (const { e } of scoredRecipes) {
            lines.push(`**[${e.id}]** ${e.title}`);
            if (e.tags?.length) lines.push(`  Tags: ${e.tags.join(', ')}`);
            if (e.imports?.length) lines.push(`  Imports: ${e.imports.join(', ')}`);
            if (e.notes) lines.push(`  Note: ${e.notes.slice(0, 120)}${e.notes.length > 120 ? '...' : ''}`);
            lines.push(`  → Use \`jerboa_howto_get\` with id="${e.id}" for full code.`);
            lines.push('');
          }
        } else {
          lines.push('## Cookbook Recipes');
          lines.push('');
          lines.push('No matching recipes found. Try jerboa_howto for broader recipe search.');
          lines.push('');
        }
      }

      if (lines.every((l) => !l.startsWith('**'))) {
        lines.push('No results found. Try:');
        lines.push('  - jerboa_howto for cookbook search');
        lines.push('  - jerboa_apropos for symbol-name search');
        lines.push('  - jerboa_list_modules to browse all modules');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
