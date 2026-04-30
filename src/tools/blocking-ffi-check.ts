import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Hit {
  file: string;
  line: number;
  symbol: string;
  fragment: string;
  reason: string;
}

/**
 * Patterns that indicate a C symbol likely performs a blocking syscall and
 * therefore needs to be declared `__collect_safe` so it does not pin the
 * Chez TC mutex while waiting on I/O.
 *
 * The exact pattern list is conservative — these are functions whose
 * `name` (or its tail) directly maps to a kernel call known to block.
 */
const BLOCKING_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|_)(read|recv|recvfrom|recvmsg)$/, reason: 'reads from a fd / socket — blocks until data' },
  { re: /(^|_)(write|send|sendto|sendmsg)$/, reason: 'writes to a fd / socket — blocks under backpressure' },
  { re: /(^|_)(accept|accept4)$/, reason: 'blocks until a connection arrives' },
  { re: /(^|_)(connect)$/, reason: 'blocks during TCP handshake' },
  { re: /(^|_)(poll|ppoll|epoll_wait|epoll_pwait|kevent|select|pselect)$/, reason: 'event-loop wait syscall' },
  { re: /(^|_)(wait|waitpid|wait4|waitid)$/, reason: 'waits for a child process' },
  { re: /(^|_)(sleep|usleep|nanosleep|clock_nanosleep)$/, reason: 'sleeps the calling thread' },
  { re: /(^|_)(lock|sem_wait|pthread_mutex_lock|pthread_cond_wait)$/, reason: 'blocks on a kernel lock' },
  { re: /(^|_)(flock|fcntl_lock|lockf)$/, reason: 'file-lock operation — may block' },
  { re: /tls_(read|recv|handshake|connect|accept)$/, reason: 'TLS layer read/handshake — calls underlying recv' },
  { re: /^getsockname$|^getpeername$/, reason: 'socket query — generally non-blocking but may pin TC if kernel is slow' },
];

const FILE_EXTS = new Set(['.ss', '.sls']);

/**
 * Locate the line number for a given character offset in a source string.
 * Lines are 1-based.
 */
function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Scan a single source string for unsafe declarations.
 * A declaration is flagged when:
 *   - it is a (foreign-procedure ...) form, AND
 *   - it does NOT contain the keyword __collect_safe before the C name string,
 *   - AND the C name matches one of the blocking patterns.
 */
function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  // Match (foreign-procedure [conv ...] "name" ... ) — capture conv and name.
  // The form is multi-line in practice, so we use [^"]*? lazy match before "name".
  const re = /\(\s*foreign-procedure\b([^"]*?)"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const conv = m[1];
    const name = m[2];
    const offsetOfName = m.index + m[0].lastIndexOf('"' + name + '"');
    const line = offsetToLine(source, offsetOfName);

    // Has __collect_safe in the head? Check the conv portion.
    const collectSafe = /__collect_safe\b/.test(conv);
    if (collectSafe) continue;

    for (const { re: rePat, reason } of BLOCKING_PATTERNS) {
      if (rePat.test(name)) {
        // Build a one-line-ish fragment for context
        const lineStart = source.lastIndexOf('\n', m.index) + 1;
        const lineEnd = source.indexOf('\n', m.index);
        const fragment = source
          .slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
          .trim();
        hits.push({ file, line, symbol: name, fragment, reason });
        break;
      }
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

export function registerBlockingFfiCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_blocking_ffi_check',
    {
      title: 'Blocking FFI Declaration Lint',
      description:
        'Scan .ss/.sls source for foreign-procedure declarations whose C symbol name matches a ' +
        'known-blocking syscall pattern (read, recv, accept, poll, sleep, lock, tls_*, etc.) but ' +
        'is missing the __collect_safe convention keyword. Such declarations pin the Chez TC ' +
        'mutex during the syscall, freezing every other Scheme thread (GCs, watchdogs, fibers) ' +
        'until the call returns. Reports file, line, symbol, and a remediation hint. ' +
        'Use after writing FFI bindings, before integrating with concurrent code.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single .ss/.sls file to scan'),
        project_path: z.string().optional().describe('Directory to recursively scan for .ss/.sls files'),
      },
    },
    async ({ file_path, project_path }) => {
      const root = file_path ?? project_path;
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or project_path.' }],
          isError: true,
        };
      }

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
          allHits.push(...scanSource(f, src));
        } catch {
          // skip unreadable
        }
      }

      const lines: string[] = [];
      lines.push(`Blocking FFI check: scanned ${files.length} file(s)`);
      lines.push('');

      if (allHits.length === 0) {
        lines.push('No blocking foreign-procedure declarations missing __collect_safe.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      lines.push(`Found ${allHits.length} declaration(s) likely missing __collect_safe:`);
      lines.push('');
      const baseDir = (await stat(root)).isDirectory() ? root : '';
      for (const h of allHits) {
        const rel = baseDir ? relative(baseDir, h.file) : h.file;
        lines.push(`  ${rel}:${h.line}  "${h.symbol}"`);
        lines.push(`    ${h.reason}`);
        lines.push(`    ${h.fragment}`);
        lines.push('');
      }
      lines.push(
        'Fix: add the __collect_safe keyword to the foreign-procedure form, e.g.\n' +
          '  (foreign-procedure __collect_safe "name" (args ...) ret)\n' +
          'Or shadow the upstream binding locally if you cannot modify the declaring module.',
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    },
  );
}
