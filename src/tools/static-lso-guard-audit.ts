import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Hit {
  file: string;
  line: number;
  call: string;
  fragment: string;
  topLevel: boolean;
  hasNearbyGuard: boolean;
}

const FILE_EXTS = new Set(['.ss', '.sls']);

const DEFAULT_GUARD_VARS = ['JEMACS_STATIC', 'JERBOA_STATIC'];

const GUARD_LOOKBACK_LINES = 10;

/**
 * Determine the parenthesis depth at a given offset by counting unescaped
 * delimiters. Reads the source up to but not including `offset`.
 *
 * Note: This is a heuristic — it does not handle string literals or
 * comments. For lint purposes, that is good enough — the false-positive
 * rate on real Jerboa code is low because `load-shared-object` is rarely
 * embedded inside a string.
 */
function depthAt(source: string, offset: number): number {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  for (let i = 0; i < offset; i++) {
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
    else if (ch === ')' || ch === ']') depth--;
  }
  return depth;
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
 * Look up to GUARD_LOOKBACK_LINES lines before `offset` for a call to
 * `getenv` referencing one of the recognised guard env vars, or for a
 * (when ...) / (unless ...) using such a check. Returns true if the
 * load-shared-object form is plausibly inside a guarded branch.
 */
function hasNearbyGuard(source: string, offset: number, guardVars: string[]): boolean {
  const start = Math.max(0, source.lastIndexOf('\n', offset - 1));
  const search = source.slice(Math.max(0, start - 600), offset);
  const guardRe = new RegExp(
    `getenv[^)]*"(${guardVars.join('|')})"`,
    'i',
  );
  if (guardRe.test(search)) return true;
  // Also accept references to a *static-build* parameter.
  if (/\bstatic-build\?\b|\bstatic\?\b/.test(search)) return true;
  return false;
}

interface ScanOptions {
  guardVars: string[];
}

function scanSource(file: string, source: string, opts: ScanOptions): Hit[] {
  const hits: Hit[] = [];
  // Match (load-shared-object "..."), with possible whitespace.
  const re = /\(\s*(load-shared-object|foreign-procedure)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const call = m[1];
    // Position of the leading paren of the form
    const formOffset = m.index;
    const depth = depthAt(source, formOffset);
    const topLevel = depth === 0;
    const guard = hasNearbyGuard(source, formOffset, opts.guardVars);

    // Only flag forms that are either top-level or appear at moderate
    // depth without a nearby guard. Calls deeply nested inside a known
    // guarded shape (e.g. inside (def runtime-init ...)) need a guard
    // too — we always flag missing guards regardless of depth, but mark
    // top-level for prioritisation.
    if (guard) continue;

    const lineNum = offsetToLine(source, formOffset);
    const ls = lineStart(source, formOffset);
    const le = lineEnd(source, formOffset);
    const fragment = source.slice(ls, le).trim();
    hits.push({ file, line: lineNum, call, fragment, topLevel, hasNearbyGuard: guard });
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

export function registerStaticLsoGuardAuditTool(server: McpServer): void {
  server.registerTool(
    'jerboa_static_lso_guard_audit',
    {
      title: 'Static-Build LSO Guard Audit',
      description:
        'Scan .ss/.sls files for top-level (or otherwise unguarded) load-shared-object and ' +
        'foreign-procedure calls. In a static (musl) build these crash at boot if the .so is ' +
        'absent — the conventional fix is to wrap them in `(unless (getenv "JEMACS_STATIC") ...)`. ' +
        'A call is considered guarded if a `getenv` of one of the recognised guard env vars (or a ' +
        'static-build? parameter) appears in the lines just before the form. Reports file, line, ' +
        'the form, and whether it sits at top level. ' +
        'Use before launching a Docker static build to catch unguarded FFI in seconds rather than ' +
        'after a 30-minute container build that fails at runtime.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single .ss/.sls file to scan'),
        project_path: z.string().optional().describe('Directory to recursively scan'),
        guard_vars: z
          .array(z.string())
          .optional()
          .describe(`Additional env-var names that count as a static-build guard. Default: ${DEFAULT_GUARD_VARS.join(', ')}`),
      },
    },
    async ({ file_path, project_path, guard_vars }) => {
      const root = file_path ?? project_path;
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or project_path.' }],
          isError: true,
        };
      }

      const guardVars = Array.from(new Set([...DEFAULT_GUARD_VARS, ...(guard_vars ?? [])]));

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
          allHits.push(...scanSource(f, src, { guardVars }));
        } catch {
          // skip unreadable
        }
      }

      const lines: string[] = [];
      lines.push(`Static LSO guard audit: scanned ${files.length} file(s), checked guards: ${guardVars.join(', ')}`);
      lines.push('');

      if (allHits.length === 0) {
        lines.push('No unguarded load-shared-object / foreign-procedure forms found.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      const tl = allHits.filter((h) => h.topLevel);
      const nested = allHits.filter((h) => !h.topLevel);

      lines.push(`Found ${allHits.length} unguarded form(s): ${tl.length} top-level, ${nested.length} nested`);
      lines.push('');

      const baseDir = (await stat(root)).isDirectory() ? root : '';
      const renderHit = (h: Hit, severity: 'TOP-LEVEL' | 'NESTED'): string[] => {
        const rel = baseDir ? relative(baseDir, h.file) : h.file;
        return [`  [${severity}] ${rel}:${h.line}  ${h.call}`, `    ${h.fragment}`];
      };

      if (tl.length > 0) {
        lines.push('Top-level (highest risk — fires at module load):');
        for (const h of tl) lines.push(...renderHit(h, 'TOP-LEVEL'));
        lines.push('');
      }
      if (nested.length > 0) {
        lines.push('Nested (still risky if the enclosing form runs at boot):');
        for (const h of nested) lines.push(...renderHit(h, 'NESTED'));
        lines.push('');
      }

      lines.push(
        `Fix pattern:\n` +
          `  (unless (getenv "${guardVars[0]}")\n` +
          `    (load-shared-object "libfoo.so"))`,
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    },
  );
}
