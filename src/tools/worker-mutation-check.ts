import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Hit {
  file: string;
  line: number;
  spawnLine: number;
  mutator: string;
  target: string;
  fragment: string;
}

const FILE_EXTS = new Set(['.ss', '.sls']);

const DEFAULT_SPAWN_FORMS = [
  'spawn',
  'spawn-worker',
  'thread-fork',
  'fork-thread',
  'make-thread',
  'thread-spawn',
];

const DEFAULT_MUTATING_OPS = [
  'hash-put!',
  'hash-remove!',
  'hash-set!',
  'hash-update!',
  'hash-clear!',
  'hash-table-set!',
  'hash-table-delete!',
  'hash-table-update!',
  'set-car!',
  'set-cdr!',
  'vector-set!',
  'vector-fill!',
  'string-set!',
  'bytevector-u8-set!',
  'bytevector-set!',
  'set!',
];

const DEFAULT_BUILTIN_SAFE = new Set([
  'current-output-port',
  'current-error-port',
  'current-input-port',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

function lineEnd(source: string, offset: number): number {
  const idx = source.indexOf('\n', offset);
  return idx === -1 ? source.length : idx;
}

/**
 * Find the matching close-paren for the open-paren at openOffset.
 * Returns the offset of the closing ')' / ']' or -1 if unbalanced.
 * Skips string literals and line comments.
 */
function findMatchingClose(source: string, openOffset: number): number {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  for (let i = openOffset; i < source.length; i++) {
    const ch = source[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === ';') {
      inLineComment = true;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findSpawnRanges(
  source: string,
  spawnForms: string[],
): Array<{ start: number; end: number; spawnLine: number }> {
  const re = new RegExp(`\\(\\s*(${spawnForms.map(escapeRegex).join('|')})\\b`, 'g');
  const ranges: Array<{ start: number; end: number; spawnLine: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    const end = findMatchingClose(source, start);
    if (end !== -1) {
      ranges.push({ start, end, spawnLine: offsetToLine(source, start) });
    }
  }
  return ranges;
}

const ID_CHARS = '[^\\s()\\[\\]"\';,`]';

/**
 * Heuristically collect identifiers introduced by binding forms in `body`.
 * Over-collecting is preferred to under-collecting — false positives in the
 * lint are worse than missed bindings.
 */
function collectLocalBindings(body: string): Set<string> {
  const ids = new Set<string>();

  // (let|let*|letrec|letrec*|let-values|let*-values [name?] ((id ...) ...) ...)
  const letRe = new RegExp(
    `\\(\\s*(?:let|let\\*|letrec|letrec\\*|let-values|let\\*-values)\\s+(?:${ID_CHARS}+\\s+)?\\(\\s*((?:\\(\\s*${ID_CHARS}+(?:\\s+${ID_CHARS}+)*\\s+[^()]*\\)\\s*)+)\\)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = letRe.exec(body)) !== null) {
    const inner = new RegExp(`\\(\\s*(${ID_CHARS}+)`, 'g');
    let im: RegExpExecArray | null;
    while ((im = inner.exec(m[1])) !== null) ids.add(im[1]);
  }

  // (lambda (a b ...) ...) | (lambda a ...) | (lambda (a . b) ...) | (λ ...)
  const lambdaRe = new RegExp(
    `\\(\\s*(?:lambda|λ)\\s+(?:\\(\\s*([^)]*)\\)|(${ID_CHARS}+))`,
    'g',
  );
  while ((m = lambdaRe.exec(body)) !== null) {
    const params = m[1] ?? m[2] ?? '';
    for (const id of params.split(/[\s.]+/)) {
      if (id) ids.add(id);
    }
  }

  // (define id ...) and (define (f a b) ...)
  const defRe = new RegExp(
    `\\(\\s*define\\s+(?:\\(\\s*(${ID_CHARS}+)((?:\\s+${ID_CHARS}+)*)(?:\\s*\\.\\s*${ID_CHARS}+)?\\s*\\)|(${ID_CHARS}+))`,
    'g',
  );
  while ((m = defRe.exec(body)) !== null) {
    if (m[1]) {
      ids.add(m[1]);
      if (m[2]) for (const id of m[2].split(/\s+/)) if (id) ids.add(id);
    } else if (m[3]) {
      ids.add(m[3]);
    }
  }

  // (def id ...) — Jerboa shorthand
  const defShortRe = new RegExp(
    `\\(\\s*def\\s+(?:\\(\\s*(${ID_CHARS}+)((?:\\s+${ID_CHARS}+)*)\\s*\\)|(${ID_CHARS}+))`,
    'g',
  );
  while ((m = defShortRe.exec(body)) !== null) {
    if (m[1]) {
      ids.add(m[1]);
      if (m[2]) for (const id of m[2].split(/\s+/)) if (id) ids.add(id);
    } else if (m[3]) {
      ids.add(m[3]);
    }
  }

  // (do ((id init step) ...) ...) iteration
  const doRe = /\(\s*do\s+\(((?:\([^)]+\)\s*)+)\)/g;
  while ((m = doRe.exec(body)) !== null) {
    const inner = new RegExp(`\\(\\s*(${ID_CHARS}+)`, 'g');
    let im: RegExpExecArray | null;
    while ((im = inner.exec(m[1])) !== null) ids.add(im[1]);
  }

  return ids;
}

interface ScanOptions {
  spawnForms: string[];
  mutators: string[];
  builtinSafelist: Set<string>;
}

function scanSource(file: string, source: string, opts: ScanOptions): Hit[] {
  const hits: Hit[] = [];
  const ranges = findSpawnRanges(source, opts.spawnForms);
  if (ranges.length === 0) return hits;

  const mutatorRe = new RegExp(
    `\\(\\s*(${opts.mutators.map(escapeRegex).join('|')})\\s+(${ID_CHARS}+)`,
    'g',
  );

  for (const range of ranges) {
    const body = source.slice(range.start, range.end + 1);
    const locals = collectLocalBindings(body);
    let m: RegExpExecArray | null;
    mutatorRe.lastIndex = 0;
    while ((m = mutatorRe.exec(body)) !== null) {
      const mutator = m[1];
      const target = m[2];
      if (locals.has(target)) continue;
      if (opts.builtinSafelist.has(target)) continue;
      // Skip numeric / quoted / string literals that slipped through
      if (/^['"`#0-9]/.test(target)) continue;
      const absoluteOffset = range.start + m.index;
      const lineNum = offsetToLine(source, absoluteOffset);
      const ls = lineStart(source, absoluteOffset);
      const le = lineEnd(source, absoluteOffset);
      const fragment = source.slice(ls, le).trim();
      hits.push({
        file,
        line: lineNum,
        spawnLine: range.spawnLine,
        mutator,
        target,
        fragment,
      });
    }
  }
  return hits;
}

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot === -1 ? '' : e.name.slice(dot);
        if (FILE_EXTS.has(ext)) out.push(full);
      }
    }
  }

  const s = await stat(root);
  if (s.isFile()) {
    out.push(root);
  } else {
    await walk(root);
  }
  return out;
}

export function registerWorkerMutationCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_worker_mutation_check',
    {
      title: 'Worker-Thread Shared Mutation Lint',
      description:
        'Scan .ss/.sls files for mutating operations (hash-put!, hash-remove!, set-car!, set-cdr!, ' +
        'vector-set!, set!, etc.) inside (spawn ...) / (spawn-worker ...) / (thread-fork ...) ' +
        'bodies whose target identifier is captured from outer scope rather than bound locally. ' +
        'This is the canonical race-condition setup — two threads writing to the same hash table ' +
        'or list without a mutex. The static heuristic cannot prove the captured value is shared, ' +
        'so it overreports rather than underreports. The recommended fix is the mailbox pattern ' +
        '(thread-send + thread-receive) so each piece of state has exactly one owning thread.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single .ss/.sls file to scan'),
        project_path: z.string().optional().describe('Directory to recursively scan'),
        spawn_forms: z
          .array(z.string())
          .optional()
          .describe(`Names of spawn-like forms to consider. Default: ${DEFAULT_SPAWN_FORMS.join(', ')}`),
        extra_mutators: z
          .array(z.string())
          .optional()
          .describe('Additional mutator names to flag (e.g. project-specific record setters)'),
      },
    },
    async ({ file_path, project_path, spawn_forms, extra_mutators }) => {
      const root = file_path ?? project_path;
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or project_path.' }],
          isError: true,
        };
      }

      const spawnForms = Array.from(new Set([...DEFAULT_SPAWN_FORMS, ...(spawn_forms ?? [])]));
      const mutators = Array.from(new Set([...DEFAULT_MUTATING_OPS, ...(extra_mutators ?? [])]));

      let files: string[];
      try {
        files = await listSourceFiles(root);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Cannot access: ${root}` }],
          isError: true,
        };
      }

      if (files.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No .ss/.sls files found under ${root}` }],
        };
      }

      const allHits: Hit[] = [];
      for (const f of files) {
        try {
          const src = await readFile(f, 'utf-8');
          allHits.push(
            ...scanSource(f, src, {
              spawnForms,
              mutators,
              builtinSafelist: DEFAULT_BUILTIN_SAFE,
            }),
          );
        } catch {
          // unreadable file — skip
        }
      }

      const lines: string[] = [];
      lines.push(`Worker mutation check: scanned ${files.length} file(s)`);
      lines.push('');

      if (allHits.length === 0) {
        lines.push('No captured-mutation hits inside spawn-like bodies.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      lines.push(`Found ${allHits.length} captured-mutation hit(s):`);
      lines.push('');
      const baseDir = (await stat(root)).isDirectory() ? root : '';
      for (const h of allHits) {
        const rel = baseDir ? relative(baseDir, h.file) : h.file;
        lines.push(`  ${rel}:${h.line}  ${h.mutator} ${h.target}   (spawn at line ${h.spawnLine})`);
        lines.push(`    ${h.fragment}`);
      }
      lines.push('');
      lines.push(
        'Fix: replace direct mutation with a mailbox message so each piece of state has exactly one writer.\n' +
          '  ;; before — racy:\n' +
          '  (spawn (lambda () ... (hash-put! shared key val)))\n' +
          '  ;; after — single-owner via thread-send / thread-receive:\n' +
          '  (define worker\n' +
          '    (spawn (lambda ()\n' +
          '             (let loop ()\n' +
          '               (let ([msg (thread-receive)])\n' +
          '                 (process msg) (loop))))))\n' +
          '  ;; parent enqueues without sharing the hash directly:\n' +
          "  (thread-send worker (list 'put key val))",
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    },
  );
}
