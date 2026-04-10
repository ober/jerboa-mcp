/**
 * jerboa_semantic_search — TF-IDF based search over Jerboa cookbook and stdlib.
 *
 * Improves on jerboa_stdlib_search by:
 * - Indexing the full code + notes + imports of every cookbook recipe (not just tags/title)
 * - Using TF-IDF scoring so rare/specific terms (e.g. "duckdb", "mtls", "guardian") score
 *   higher than common terms ("parse", "read", "use")
 * - Cosine similarity ranking across both cookbook recipes and stdlib modules
 * - Stop word filtering to reduce noise
 *
 * Use when keyword search (jerboa_howto, jerboa_stdlib_search) returns too many or
 * the wrong results, or when your query is intent-based ("safely open and query SQLite",
 * "parallel thread fan-out with result collection").
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

// ── Stop words ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'be', 'been', 'being',
  'to', 'of', 'and', 'or', 'in', 'at', 'by', 'for', 'with',
  'this', 'that', 'it', 'as', 'on', 'can', 'will', 'would',
  'could', 'should', 'may', 'might', 'do', 'does', 'did',
  'not', 'so', 'but', 'if', 'when', 'then', 'all', 'any',
  'from', 'has', 'have', 'had', 'which', 'how', 'what', 'where',
  'each', 'also', 'than', 'its', 'you', 'your', 'we', 'our',
  'std', 'use', 'used', 'using', 'new', 'get', 'set', 'let',
  'via', 'into', 'up', 'out', 'just', 'more', 'some', 'like',
]);

// ── Tokenizer ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Split camelCase: e.g. "JsonObject" → "json object"
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Split on non-alphanumeric
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
  );
}

// ── Document model ─────────────────────────────────────────────────────────

interface Document {
  id: string;
  title: string;
  type: 'recipe' | 'module';
  /** Normalized TF vector: term → tf value (count/totalTokens) */
  tf: Map<string, number>;
  /** Total token count (for normalization) */
  totalTokens: number;
  /** Set of unique terms (for IDF calculation) */
  termSet: Set<string>;
  meta: {
    imports?: string[];
    tags?: string[];
    notes?: string;
    description?: string;
  };
}

function buildRecipeDoc(entry: CookbookEntry): Document {
  // Weight fields: title/id/tags get repeated tokens (boosted),
  // code/notes get indexed once
  const text = [
    entry.title,          // weight: 1x
    entry.title,          // weight: 2x (boost title)
    entry.id.replace(/-/g, ' '),
    (entry.tags ?? []).join(' '),
    (entry.tags ?? []).join(' '), // boost tags
    (entry.imports ?? []).join(' '),
    (entry.notes ?? ''),
    entry.code,
  ].join(' ');

  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  // Normalize TF by document length
  for (const [t, c] of tf) tf.set(t, c / tokens.length);

  return {
    id: entry.id,
    title: entry.title,
    type: 'recipe',
    tf,
    totalTokens: tokens.length,
    termSet: new Set(tf.keys()),
    meta: { imports: entry.imports, tags: entry.tags, notes: entry.notes },
  };
}

// ── Stdlib module corpus ────────────────────────────────────────────────────

interface StdlibModule {
  path: string;
  description: string;
  keywords: string[];
  keyExports: string[];
}

const STDLIB_MODULES: StdlibModule[] = [
  { path: '(jerboa prelude)', description: 'Kitchen sink: 200+ symbols, all conflicts pre-resolved. Start here.', keywords: ['import', 'start', 'basic', 'prelude', 'setup', 'default', 'all'], keyExports: ['def', 'defstruct', 'match', 'try', 'for', 'format', 'hash-put', 'sort', 'ok', 'err'] },
  { path: '(std sort)', description: 'Sorting and ordering lists', keywords: ['sort', 'order', 'arrange', 'compare', 'rank', 'ascending', 'descending'], keyExports: ['sort', 'sort!', 'stable-sort', 'stable-sort!'] },
  { path: '(std text json)', description: 'JSON parsing and serialization', keywords: ['json', 'parse', 'serialize', 'deserialize', 'decode', 'encode', 'api', 'rest'], keyExports: ['read-json', 'write-json', 'string->json-object', 'json-object->string'] },
  { path: '(std csv)', description: 'CSV reading and writing', keywords: ['csv', 'spreadsheet', 'tabular', 'comma', 'table', 'tsv'], keyExports: ['read-csv', 'write-csv', 'csv->alists'] },
  { path: '(std misc string)', description: 'String utilities: split, join, trim, contains, prefix, suffix', keywords: ['string', 'text', 'split', 'join', 'trim', 'substring', 'search', 'contains', 'prefix', 'suffix'], keyExports: ['string-split', 'string-join', 'string-trim', 'string-prefix?', 'string-contains', 'string-empty?'] },
  { path: '(std misc list)', description: 'List utilities: flatten, group-by, zip, partition, take, drop, frequencies', keywords: ['list', 'flatten', 'group', 'zip', 'partition', 'take', 'drop', 'slice', 'chunk', 'frequency', 'unique'], keyExports: ['flatten', 'unique', 'group-by', 'zip', 'take', 'drop', 'partition', 'frequencies'] },
  { path: '(std misc thread)', description: 'Concurrency: threads, mutexes, channels, send, receive', keywords: ['thread', 'concurrent', 'parallel', 'mutex', 'channel', 'spawn', 'sync', 'lock', 'barrier'], keyExports: ['spawn', 'spawn/name', 'mutex-lock!', 'mutex-unlock!', 'thread-send', 'thread-receive'] },
  { path: '(std misc process)', description: 'Run external shell commands and subprocesses', keywords: ['process', 'shell', 'command', 'subprocess', 'exec', 'run', 'system', 'pipe'], keyExports: ['run-process', 'run-process/batch', 'open-input-process'] },
  { path: '(std misc ports)', description: 'Port and file I/O utilities: read, write, lines', keywords: ['file', 'read', 'write', 'port', 'io', 'input', 'output', 'stream', 'line', 'lines'], keyExports: ['read-file-string', 'read-file-lines', 'write-file-string', 'read-all-as-string'] },
  { path: '(std misc func)', description: 'Functional combinators: compose, curry, partial, memoize', keywords: ['compose', 'curry', 'partial', 'functional', 'higher-order', 'memoize', 'pipe', 'flip', 'juxt'], keyExports: ['compose', 'curry', 'negate', 'identity', 'constantly', 'flip', 'juxt', 'partial', 'memo-proc'] },
  { path: '(std net tcp)', description: 'TCP client and server sockets', keywords: ['tcp', 'socket', 'network', 'connect', 'listen', 'server', 'client', 'port'], keyExports: ['tcp-listen', 'tcp-accept', 'tcp-connect', 'tcp-close'] },
  { path: '(std net request)', description: 'HTTP client: GET, POST, headers, JSON body', keywords: ['http', 'https', 'request', 'get', 'post', 'api', 'rest', 'fetch', 'web', 'curl', 'client'], keyExports: ['http-get', 'http-post', 'http-request'] },
  { path: '(std net httpd)', description: 'HTTP server: routes, handlers, responses', keywords: ['httpd', 'server', 'web', 'route', 'handler', 'serve', 'endpoint', 'response'], keyExports: ['httpd-start', 'httpd-route', 'http-respond-json'] },
  { path: '(std db sqlite)', description: 'SQLite database: open, query, exec, prepared statements', keywords: ['sqlite', 'database', 'db', 'sql', 'query', 'persist', 'store', 'relational'], keyExports: ['sqlite-open', 'sqlite-close', 'sqlite-exec', 'sqlite-query'] },
  { path: '(std db duckdb)', description: 'DuckDB in-process OLAP analytical database', keywords: ['duckdb', 'olap', 'analytics', 'analytical', 'parquet', 'columnar', 'database'], keyExports: ['duckdb-open', 'duckdb-query', 'duckdb-exec'] },
  { path: '(std os env)', description: 'Environment variables: get, set, unset', keywords: ['env', 'environment', 'variable', 'getenv', 'config', 'shell'], keyExports: ['getenv', 'setenv', 'unsetenv'] },
  { path: '(std os path)', description: 'File path manipulation: join, expand, normalize, absolute', keywords: ['path', 'directory', 'file', 'join', 'expand', 'normalize', 'absolute', 'relative'], keyExports: ['path-join', 'path-expand', 'path-normalize', 'path-absolute?'] },
  { path: '(std os signal)', description: 'Unix signal handling: SIGINT, SIGTERM, SIGHUP', keywords: ['signal', 'sigint', 'sigterm', 'ctrl', 'shutdown', 'interrupt', 'unix', 'posix'], keyExports: ['signal-handler', 'handle-signal'] },
  { path: '(std crypto digest)', description: 'Cryptographic hash functions: SHA-256, MD5, SHA-512', keywords: ['hash', 'sha', 'md5', 'sha256', 'sha512', 'digest', 'checksum', 'crypto', 'hmac'], keyExports: ['md5', 'sha1', 'sha256', 'sha512', 'digest->hex-string'] },
  { path: '(std crypto random)', description: 'Cryptographically secure random bytes, UUIDs, tokens', keywords: ['random', 'uuid', 'token', 'secure', 'nonce', 'crypto', 'entropy'], keyExports: ['random-bytes', 'random-u64', 'random-token', 'random-uuid'] },
  { path: '(std text xml)', description: 'XML and HTML parsing and generation via SXML', keywords: ['xml', 'html', 'sxml', 'parse', 'document', 'dom', 'markup'], keyExports: ['xml->sxml', 'sxml->xml', 'html->sxml'] },
  { path: '(std text yaml)', description: 'YAML parsing and serialization', keywords: ['yaml', 'config', 'configuration', 'parse', 'serialize', 'markup'], keyExports: ['yaml->object', 'object->yaml', 'read-yaml'] },
  { path: '(std actor)', description: 'Actor model: actors, messages, supervision trees', keywords: ['actor', 'message', 'concurrent', 'supervision', 'mailbox', 'erlang', 'agent'], keyExports: ['make-actor', 'actor-send!', 'actor-receive', 'actor-supervisor'] },
  { path: '(std async)', description: 'Async/await style concurrency with promises', keywords: ['async', 'await', 'promise', 'future', 'non-blocking', 'callback'], keyExports: ['async', 'await', 'async-let', 'make-promise'] },
  { path: '(std stm)', description: 'Software transactional memory: tvars, atomically, retry', keywords: ['stm', 'transaction', 'atomic', 'tvar', 'concurrent', 'shared', 'lock-free'], keyExports: ['make-tvar', 'atomically', 'tvar-read', 'tvar-write!', 'retry', 'or-else'] },
  { path: '(std result)', description: 'Result type: ok/err, unwrap, map, monadic bind', keywords: ['result', 'ok', 'err', 'error', 'option', 'maybe', 'unwrap', 'rust', 'monad'], keyExports: ['ok', 'err', 'ok?', 'unwrap', 'unwrap-or', 'map-ok', 'and-then', 'try-result'] },
  { path: '(std datetime)', description: 'Date and time: parse ISO8601, format, arithmetic, diff', keywords: ['date', 'time', 'datetime', 'timestamp', 'parse', 'format', 'duration', 'calendar', 'iso8601'], keyExports: ['datetime-now', 'parse-datetime', 'datetime->iso8601', 'datetime-add', 'datetime-diff'] },
  { path: '(std iter)', description: 'Lazy iterators: for, for/collect, for/fold, in-range, in-lines', keywords: ['iterator', 'iterate', 'lazy', 'stream', 'range', 'sequence', 'generator', 'lazy-sequence'], keyExports: ['for', 'for/collect', 'for/fold', 'in-list', 'in-range', 'in-hash-pairs', 'in-lines'] },
  { path: '(std sugar)', description: 'Syntactic sugar: ->, ->>, when-let, awhen, str, with-resource, cut', keywords: ['sugar', 'macro', 'thread', 'pipe', 'anaphora', 'resource', 'threading', 'chain'], keyExports: ['->', '->>', 'as->', 'awhen', 'aif', 'when-let', 'with-resource', 'str', 'cut'] },
  { path: '(std peg)', description: 'PEG grammar: define-grammar, parse, rule composition', keywords: ['peg', 'grammar', 'parse', 'parser', 'combinator', 'rule', 'language', 'dsl'], keyExports: ['define-grammar', 'peg-parse', 'peg-match'] },
  { path: '(std security sandbox)', description: 'Sandbox untrusted code: restrict capabilities', keywords: ['sandbox', 'security', 'restrict', 'capability', 'isolation', 'safe', 'untrusted'], keyExports: ['make-sandbox', 'sandbox-eval', 'sandbox-restrict'] },
  { path: '(std rx patterns)', description: 'Pre-built regex patterns: email, URL, UUID, IP address', keywords: ['regex', 'pattern', 'email', 'url', 'uuid', 'ip', 'phone', 'validate', 'prebuilt'], keyExports: ['rx:email', 'rx:url', 'rx:uuid', 'rx:ip4', 'rx:phone'] },
];

function buildModuleDoc(mod: StdlibModule): Document {
  const text = [
    mod.path,
    mod.path,           // boost path match
    mod.description,
    mod.description,    // boost description
    mod.keywords.join(' '),
    mod.keywords.join(' '), // boost keywords
    mod.keyExports.join(' '),
  ].join(' ');

  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, c] of tf) tf.set(t, c / tokens.length);

  return {
    id: mod.path,
    title: `${mod.path} — ${mod.description}`,
    type: 'module',
    tf,
    totalTokens: tokens.length,
    termSet: new Set(tf.keys()),
    meta: { imports: [mod.path], description: mod.description },
  };
}

// ── TF-IDF scoring ─────────────────────────────────────────────────────────

/** Compute IDF for a term across the corpus: log(N / df(t) + 1) */
function computeIdf(term: string, docs: Document[]): number {
  const df = docs.filter((d) => d.termSet.has(term)).length;
  return Math.log((docs.length + 1) / (df + 1)) + 1; // smoothed IDF
}

interface ScoredResult {
  doc: Document;
  score: number;
  matchedTerms: string[];
}

function scoreDocuments(queryTokens: string[], docs: Document[]): ScoredResult[] {
  // Compute IDF for each query term
  const idf = new Map<string, number>();
  for (const t of queryTokens) {
    idf.set(t, computeIdf(t, docs));
  }

  // Compute query vector norm (for cosine similarity)
  let queryNorm = 0;
  for (const t of queryTokens) {
    const idfVal = idf.get(t) ?? 0;
    queryNorm += idfVal * idfVal;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  return docs.map((doc) => {
    let dotProduct = 0;
    let docNormSq = 0;
    const matchedTerms: string[] = [];

    for (const t of queryTokens) {
      const tfVal = doc.tf.get(t) ?? 0;
      const idfVal = idf.get(t) ?? 0;
      const tfidf = tfVal * idfVal;
      dotProduct += tfidf * idfVal; // query term weight = idf (tf=1 for query)
      if (tfVal > 0) matchedTerms.push(t);
      docNormSq += tfidf * tfidf;
    }

    const docNorm = Math.sqrt(docNormSq) || 1;
    const cosine = dotProduct / (queryNorm * docNorm);

    return { doc, score: cosine, matchedTerms };
  });
}

// ── Synonym expansion ───────────────────────────────────────────────────────

const SYNONYMS: Record<string, string[]> = {
  read: ['parse', 'load', 'input', 'import', 'ingest'],
  write: ['output', 'save', 'export', 'dump', 'persist', 'store'],
  file: ['path', 'disk', 'io', 'port', 'filesystem'],
  web: ['http', 'request', 'api', 'rest', 'url', 'endpoint'],
  database: ['sqlite', 'sql', 'db', 'persist', 'store', 'relational'],
  safe: ['secure', 'validate', 'check', 'protect', 'guard'],
  async: ['concurrent', 'parallel', 'thread', 'non-blocking', 'future'],
  map: ['transform', 'convert', 'apply', 'project'],
  filter: ['select', 'keep', 'where', 'predicate'],
  search: ['find', 'lookup', 'locate', 'query'],
  format: ['print', 'display', 'stringify', 'serialize', 'render'],
  error: ['exception', 'condition', 'failure', 'fault'],
  hash: ['sha', 'digest', 'checksum', 'md5', 'crypto'],
  random: ['uuid', 'nonce', 'token', 'entropy', 'secure'],
  sort: ['order', 'arrange', 'rank', 'compare'],
  string: ['text', 'str', 'chars', 'bytes'],
  network: ['tcp', 'socket', 'connect', 'server', 'client'],
  config: ['env', 'environment', 'settings', 'yaml'],
  test: ['check', 'assert', 'verify', 'spec', 'unit'],
  actor: ['agent', 'message', 'mailbox', 'erlang', 'supervision'],
  parse: ['read', 'decode', 'lex', 'grammar', 'peg'],
  stream: ['iterator', 'lazy', 'sequence', 'generator', 'in-range'],
};

function expandQuery(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const syns = SYNONYMS[t];
    if (syns) syns.forEach((s) => expanded.add(s));
  }
  return [...expanded];
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerSemanticSearchTool(server: McpServer): void {
  server.registerTool(
    'jerboa_semantic_search',
    {
      title: 'Semantic Search over Stdlib and Cookbook (TF-IDF)',
      description:
        'Intent-based search using TF-IDF scoring over Jerboa cookbook recipes and stdlib modules. ' +
        'Better than jerboa_stdlib_search for: specific/rare terms ("guardian", "duckdb", "mtls", "stm"), ' +
        'multi-concept queries ("safely open SQLite and map rows"), and when keyword search returns noise. ' +
        'Indexes full recipe code+notes+imports, not just tags. Rare terms score higher than common ones. ' +
        'Use jerboa_howto_get with the returned id to fetch full code for a recipe result.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        query: z
          .string()
          .describe(
            'Natural language or keyword query describing what you want to do. ' +
              'Examples: "guardian GC resource cleanup", "safely open SQLite with transactions", ' +
              '"parallel fan-out collect results", "parse ISO date string"',
          ),
        max_results: z
          .number()
          .optional()
          .describe('Maximum results per category (default: 5)'),
        include_recipes: z
          .boolean()
          .optional()
          .describe('Include cookbook recipe results (default: true)'),
        include_modules: z
          .boolean()
          .optional()
          .describe('Include stdlib module results (default: true)'),
        min_score: z
          .number()
          .optional()
          .describe('Minimum cosine similarity score 0-1 (default: 0.01)'),
      },
    },
    async ({ query, max_results, include_recipes, include_modules, min_score }) => {
      const maxN = max_results ?? 5;
      const showRecipes = include_recipes !== false;
      const showModules = include_modules !== false;
      const threshold = min_score ?? 0.01;

      const rawTokens = tokenize(query);
      if (rawTokens.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Query too short or contains only stop words.' }],
          isError: true,
        };
      }
      const queryTokens = expandQuery(rawTokens);

      const lines: string[] = [];
      lines.push(`Semantic search: "${query}"`);
      lines.push(`Terms: ${rawTokens.join(', ')}${queryTokens.length > rawTokens.length ? ` (expanded: ${queryTokens.slice(rawTokens.length, rawTokens.length + 5).join(', ')}${queryTokens.length > rawTokens.length + 5 ? '...' : ''})` : ''}`);
      lines.push('');

      // ── Stdlib modules ──
      if (showModules) {
        const moduleDocs = STDLIB_MODULES.map(buildModuleDoc);
        const scored = scoreDocuments(queryTokens, moduleDocs)
          .filter((r) => r.score >= threshold && r.matchedTerms.length > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxN);

        lines.push('## Standard Library Modules');
        lines.push('');
        if (scored.length === 0) {
          lines.push('No matching modules found.');
        } else {
          for (const { doc, score, matchedTerms } of scored) {
            const mod = STDLIB_MODULES.find((m) => m.path === doc.id)!;
            lines.push(`**\`${mod.path}\`** (score: ${score.toFixed(3)})`);
            lines.push(`  ${mod.description}`);
            lines.push(`  Key exports: ${mod.keyExports.slice(0, 6).join(', ')}`);
            if (matchedTerms.length > 0) {
              lines.push(`  Matched: ${matchedTerms.slice(0, 6).join(', ')}`);
            }
            lines.push(`  \`(import ${mod.path})\``);
            lines.push('');
          }
        }
      }

      // ── Cookbook recipes ──
      if (showRecipes) {
        let cookbooks: CookbookEntry[] = [];
        try {
          cookbooks = JSON.parse(readFileSync(COOKBOOKS_PATH, 'utf-8'));
        } catch {
          cookbooks = [];
        }

        const recipeDocs = cookbooks.map(buildRecipeDoc);
        const scored = scoreDocuments(queryTokens, recipeDocs)
          .filter((r) => r.score >= threshold && r.matchedTerms.length > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxN);

        lines.push('## Cookbook Recipes');
        lines.push('');
        if (scored.length === 0) {
          lines.push('No matching recipes found.');
          lines.push('Try jerboa_howto for broader recipe search.');
        } else {
          for (const { doc, score, matchedTerms } of scored) {
            const entry = cookbooks.find((e) => e.id === doc.id)!;
            lines.push(`**[${entry.id}]** ${entry.title} (score: ${score.toFixed(3)})`);
            if (entry.tags?.length) lines.push(`  Tags: ${entry.tags.join(', ')}`);
            if (entry.imports?.length) lines.push(`  Imports: ${entry.imports.join(', ')}`);
            if (matchedTerms.length > 0) lines.push(`  Matched: ${matchedTerms.slice(0, 8).join(', ')}`);
            if (entry.notes) {
              const note = entry.notes.slice(0, 100);
              lines.push(`  Note: ${note}${entry.notes.length > 100 ? '...' : ''}`);
            }
            lines.push(`  → \`jerboa_howto_get id="${entry.id}"\` for full code`);
            lines.push('');
          }
        }
      }

      if (!lines.some((l) => l.startsWith('**'))) {
        lines.push('No results above threshold. Try:');
        lines.push('  - Lower min_score (current: ' + threshold + ')');
        lines.push('  - Different keywords');
        lines.push('  - jerboa_howto for recipe search');
        lines.push('  - jerboa_apropos for symbol-name search');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
