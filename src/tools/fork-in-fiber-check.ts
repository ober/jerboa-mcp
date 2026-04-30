import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Hit {
  file: string;
  line: number;
  contextLine: number;
  contextForm: string;
  forkOp: string;
  fragment: string;
}

const FILE_EXTS = new Set(['.ss', '.sls']);

/**
 * Forms whose body executes in a fiber / coroutine / event-loop context
 * where calling fork(2) or exec is dangerous. The child inherits the parent's
 * file descriptors and event-loop state, leading to deadlocks, double-close
 * bugs, and zombie reapers.
 */
const DEFAULT_FIBER_FORMS = [
  // HTTP / networking handlers
  'httpd-route',
  'httpd-handler',
  'httpd-add-route',
  'add-route',
  'add-handler',
  'define-handler',
  'define-route',
  'on-request',
  'register-handler',
  // Channels / pub-sub
  'channel-listen',
  'subscribe',
  'on-message',
  'tap',
  'consume',
  // Fibers and async
  'with-fiber',
  'start-fiber',
  'fiber',
  'go',
  'async',
  'await-all',
  // Transducers (lambdas run inside the transducer's pipeline)
  'transduce',
  'pipe-map',
  'map-async',
  'into',
];

/**
 * Operations that fork a process or otherwise spawn a child requiring full
 * inheritance of fd state.
 */
const DEFAULT_FORKING_OPS = [
  'system',
  'system*',
  'process',
  'open-process-ports',
  'fork',
  'process-fork',
  'run-safe-eval',
  'run-shell',
  'shell',
  'exec',
  'execvp',
  'execve',
  'spawn-process',
];

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

function findFiberRanges(
  source: string,
  fiberForms: string[],
): Array<{ start: number; end: number; form: string; line: number }> {
  const re = new RegExp(`\\(\\s*(${fiberForms.map(escapeRegex).join('|')})\\b`, 'g');
  const ranges: Array<{ start: number; end: number; form: string; line: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    const end = findMatchingClose(source, start);
    if (end !== -1) {
      ranges.push({ start, end, form: m[1], line: offsetToLine(source, start) });
    }
  }
  return ranges;
}

interface ScanOptions {
  fiberForms: string[];
  forkOps: string[];
}

function scanSource(file: string, source: string, opts: ScanOptions): Hit[] {
  const hits: Hit[] = [];
  const ranges = findFiberRanges(source, opts.fiberForms);
  if (ranges.length === 0) return hits;

  const forkRe = new RegExp(`\\(\\s*(${opts.forkOps.map(escapeRegex).join('|')})\\b`, 'g');

  for (const range of ranges) {
    const body = source.slice(range.start, range.end + 1);
    let m: RegExpExecArray | null;
    forkRe.lastIndex = 0;
    while ((m = forkRe.exec(body)) !== null) {
      const absoluteOffset = range.start + m.index;
      const lineNum = offsetToLine(source, absoluteOffset);
      const ls = lineStart(source, absoluteOffset);
      const le = lineEnd(source, absoluteOffset);
      const fragment = source.slice(ls, le).trim();
      hits.push({
        file,
        line: lineNum,
        contextLine: range.line,
        contextForm: range.form,
        forkOp: m[1],
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

export function registerForkInFiberCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_fork_in_fiber_check',
    {
      title: 'Fork-in-Fiber-Context Lint',
      description:
        'Scan .ss/.sls files for calls to forking operations (system, system*, open-process-ports, ' +
        'process, run-safe-eval, exec, ...) inside contexts that execute on a fiber, transducer, ' +
        'or async callback (httpd handlers, channel listeners, with-fiber, transduce, ...). ' +
        "Forking from a fiber inherits the parent's event-loop state and file descriptors, " +
        'commonly causing deadlocks (the child waits on a port the parent owns) or double-close ' +
        'bugs at exit. The fix is to do the fork on a dedicated OS thread, or queue the request to ' +
        'a process manager and reply asynchronously. Reports the fork call site and the ' +
        'enclosing fiber-context form.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single .ss/.sls file to scan'),
        project_path: z.string().optional().describe('Directory to recursively scan'),
        fiber_forms: z
          .array(z.string())
          .optional()
          .describe(`Additional forms to treat as a fiber/handler context. Defaults include httpd-route, transduce, with-fiber, etc.`),
        fork_ops: z
          .array(z.string())
          .optional()
          .describe('Additional names to treat as forking operations'),
      },
    },
    async ({ file_path, project_path, fiber_forms, fork_ops }) => {
      const root = file_path ?? project_path;
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or project_path.' }],
          isError: true,
        };
      }

      const fiberForms = Array.from(new Set([...DEFAULT_FIBER_FORMS, ...(fiber_forms ?? [])]));
      const forkOps = Array.from(new Set([...DEFAULT_FORKING_OPS, ...(fork_ops ?? [])]));

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
          allHits.push(...scanSource(f, src, { fiberForms, forkOps }));
        } catch {
          // unreadable — skip
        }
      }

      const lines: string[] = [];
      lines.push(`Fork-in-fiber check: scanned ${files.length} file(s)`);
      lines.push('');

      if (allHits.length === 0) {
        lines.push('No fork operations found inside fiber/handler bodies.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      lines.push(`Found ${allHits.length} fork-in-fiber hit(s):`);
      lines.push('');
      const baseDir = (await stat(root)).isDirectory() ? root : '';
      for (const h of allHits) {
        const rel = baseDir ? relative(baseDir, h.file) : h.file;
        lines.push(
          `  ${rel}:${h.line}  ${h.forkOp}   (inside ${h.contextForm} at line ${h.contextLine})`,
        );
        lines.push(`    ${h.fragment}`);
      }
      lines.push('');
      lines.push(
        'Fix: do the fork on a dedicated OS thread, or queue the work to a long-lived process pool.\n' +
          '  ;; before — fork from inside an HTTP handler:\n' +
          '  (httpd-route "/run" (lambda (req)\n' +
          '    (system "/usr/bin/heavy-tool")))\n' +
          '  ;; after — hand off to a worker thread that owns its own fd table:\n' +
          '  (define worker (make-process-worker))\n' +
          '  (httpd-route "/run" (lambda (req)\n' +
          '    (let ([token (worker-submit worker "/usr/bin/heavy-tool")])\n' +
          '      (response-202 token))))',
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    },
  );
}
