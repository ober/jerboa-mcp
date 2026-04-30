import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface TokenRule {
  pattern: RegExp;
  bad: string;
  good: string;
  reason: string;
}

interface Hit {
  file: string;
  line: number;
  bad: string;
  good: string;
  reason: string;
  fragment: string;
}

const FILE_EXTS = new Set(['.ss', '.sls']);

/**
 * Reader-level tokens that are valid in older Chez but rejected (or
 * deprecated) by csv10. The `bad` token is what to grep for; `good` is the
 * replacement.
 *
 * Patterns use \b at the end so we don't match longer identifiers. `#\` is
 * literal (regex-escaped) and the rest is alphabetic.
 */
const RULES: TokenRule[] = [
  {
    pattern: /#\\escape\b/g,
    bad: '#\\escape',
    good: '#\\esc',
    reason: 'csv10 renames #\\escape to #\\esc — older spelling rejected at read time',
  },
  {
    pattern: /#\\rubout\b/g,
    bad: '#\\rubout',
    good: '#\\delete',
    reason: 'csv10 drops the #\\rubout alias — use #\\delete',
  },
  {
    pattern: /#!void\b/g,
    bad: '#!void',
    good: '(void)',
    reason: 'csv10 removes the #!void reader literal — call the (void) procedure instead',
  },
  {
    pattern: /#!eof\b/g,
    bad: '#!eof',
    good: '(eof-object)',
    reason: 'csv10 removes the #!eof reader literal — call (eof-object) instead',
  },
  {
    pattern: /#!bwp\b/g,
    bad: '#!bwp',
    good: '(weak-pair-broken)',
    reason: 'csv10 removes #!bwp — use the procedural broken-weak-pair value',
  },
];

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
 * Replace string literals and `;` line comments with whitespace, preserving
 * newlines (so line numbers stay aligned) and total length (so offsets stay
 * aligned). This avoids false positives when a flagged token appears inside
 * a string or comment.
 */
function stripStringsAndComments(source: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        out += ' ';
        i++;
        if (i < source.length) {
          out += source[i] === '\n' ? '\n' : ' ';
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ' ';
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === ';') {
      inLineComment = true;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const stripped = stripStringsAndComments(source);
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(stripped)) !== null) {
      const offset = m.index;
      const lineNum = offsetToLine(source, offset);
      const ls = lineStart(source, offset);
      const le = lineEnd(source, offset);
      const fragment = source.slice(ls, le).trim();
      hits.push({
        file,
        line: lineNum,
        bad: rule.bad,
        good: rule.good,
        reason: rule.reason,
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

export function registerJerbuildTokenCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_jerbuild_token_check',
    {
      title: 'csv10 Reader Token Compatibility Lint',
      description:
        'Scan .ss/.sls files for legacy Chez Scheme reader tokens that csv10 rejects or deprecates ' +
        '(#\\escape → #\\esc, #!void → (void), #!eof → (eof-object), #\\rubout → #\\delete, ' +
        '#!bwp → procedural). String literals and comments are skipped. Reports file:line, the ' +
        'bad token, the recommended replacement, and the reason — designed to surface the ' +
        '"works on csv9, fails on csv10" class of build error in seconds rather than mid-rebuild.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single .ss/.sls file to scan'),
        project_path: z.string().optional().describe('Directory to recursively scan'),
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
          // unreadable — skip
        }
      }

      const lines: string[] = [];
      lines.push(`csv10 reader token check: scanned ${files.length} file(s)`);
      lines.push('');

      if (allHits.length === 0) {
        lines.push('No legacy reader tokens found.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      lines.push(`Found ${allHits.length} legacy token(s):`);
      lines.push('');
      const baseDir = (await stat(root)).isDirectory() ? root : '';
      for (const h of allHits) {
        const rel = baseDir ? relative(baseDir, h.file) : h.file;
        lines.push(`  ${rel}:${h.line}  ${h.bad}  →  ${h.good}`);
        lines.push(`    ${h.reason}`);
        lines.push(`    ${h.fragment}`);
      }
      lines.push('');
      lines.push(
        'These tokens are accepted by older Chez Scheme but rejected (or deprecated) by csv10. ' +
          'Replace them at the source — there is no flag that re-enables the old reader.',
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    },
  );
}
