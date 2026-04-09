/**
 * jerboa_paren_depth — Report paren nesting depth at each line.
 *
 * Uses the same reader-aware scanner as check-balance (respects strings,
 * comments, character literals, block comments, pipe symbols, heredocs).
 *
 * Pure TypeScript, no subprocess, runs in milliseconds.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

const OPENERS: Record<string, boolean> = { '(': true, '[': true, '{': true };
const CLOSERS: Record<string, boolean> = { ')': true, ']': true, '}': true };

interface LineDepth {
  line: number;
  depthStart: number;
  depthEnd: number;
  opens: number;
  closes: number;
  text: string;
}

/**
 * Scan source and compute depth at start/end of each line.
 * Reader-aware: skips strings, comments, char literals, block comments, pipes.
 */
function computeLineDepths(source: string): LineDepth[] {
  const lines = source.split('\n');
  const result: LineDepth[] = [];

  let depth = 0;
  let i = 0;
  const len = source.length;
  let currentLine = 1;
  let lineStart = 0;
  let lineDepthStart = 0;
  let lineOpens = 0;
  let lineCloses = 0;

  function flushLine(): void {
    const lineEnd = source.indexOf('\n', lineStart);
    const text = lineEnd === -1
      ? source.slice(lineStart)
      : source.slice(lineStart, lineEnd);
    result.push({
      line: currentLine,
      depthStart: lineDepthStart,
      depthEnd: depth,
      opens: lineOpens,
      closes: lineCloses,
      text,
    });
  }

  while (i < len) {
    const ch = source[i];

    // --- Newline: flush current line, start next ---
    if (ch === '\n') {
      flushLine();
      currentLine++;
      i++;
      lineStart = i;
      lineDepthStart = depth;
      lineOpens = 0;
      lineCloses = 0;
      continue;
    }

    // --- String literal ---
    if (ch === '"') {
      i++;
      while (i < len && source[i] !== '"') {
        if (source[i] === '\\') i++;
        if (i < len && source[i] === '\n') {
          flushLine();
          currentLine++;
          i++;
          lineStart = i;
          lineDepthStart = depth;
          lineOpens = 0;
          lineCloses = 0;
          continue;
        }
        i++;
      }
      if (i < len) i++; // closing quote
      continue;
    }

    // --- Line comment ---
    if (ch === ';') {
      while (i < len && source[i] !== '\n') i++;
      continue;
    }

    // --- Block comment #| ... |# (nestable) ---
    if (ch === '#' && i + 1 < len && source[i + 1] === '|') {
      let bDepth = 1;
      i += 2;
      while (i < len && bDepth > 0) {
        if (source[i] === '#' && i + 1 < len && source[i + 1] === '|') {
          bDepth++; i += 2;
        } else if (source[i] === '|' && i + 1 < len && source[i + 1] === '#') {
          bDepth--; i += 2;
        } else {
          if (source[i] === '\n') {
            flushLine();
            currentLine++;
            i++;
            lineStart = i;
            lineDepthStart = depth;
            lineOpens = 0;
            lineCloses = 0;
          } else {
            i++;
          }
        }
      }
      continue;
    }

    // --- Datum comment #; ---
    if (ch === '#' && i + 1 < len && source[i + 1] === ';') {
      i += 2;
      continue;
    }

    // --- #! reader directives ---
    if (ch === '#' && i + 1 < len && source[i + 1] === '!') {
      i += 2;
      while (i < len && /[a-zA-Z0-9_-]/.test(source[i])) i++;
      continue;
    }

    // --- Character literal #\x ---
    if (ch === '#' && i + 1 < len && source[i + 1] === '\\') {
      i += 2;
      if (i < len && /[a-zA-Z]/.test(source[i])) {
        while (i < len && /[a-zA-Z0-9]/.test(source[i])) i++;
      } else if (i < len) {
        i++;
      }
      continue;
    }

    // --- Pipe symbol |...| ---
    if (ch === '|') {
      i++;
      while (i < len && source[i] !== '|') {
        if (source[i] === '\\') i++;
        if (i < len && source[i] === '\n') {
          flushLine();
          currentLine++;
          i++;
          lineStart = i;
          lineDepthStart = depth;
          lineOpens = 0;
          lineCloses = 0;
          continue;
        }
        i++;
      }
      if (i < len) i++; // closing pipe
      continue;
    }

    // --- Openers ---
    if (OPENERS[ch]) {
      depth++;
      lineOpens++;
      i++;
      continue;
    }

    // --- Closers ---
    if (CLOSERS[ch]) {
      depth--;
      lineCloses++;
      i++;
      continue;
    }

    i++;
  }

  // Flush final line if it didn't end with \n
  if (lineStart <= len && currentLine > result.length) {
    flushLine();
  }

  return result;
}

function formatDepthReport(
  depths: LineDepth[],
  startLine: number,
  endLine: number,
  showContent: boolean,
): string {
  const filtered = depths.filter(d => d.line >= startLine && d.line <= endLine);

  if (filtered.length === 0) {
    return `No lines in range ${startLine}–${endLine}.`;
  }

  const lines: string[] = [];
  const maxLineNum = String(filtered[filtered.length - 1].line).length;

  for (const d of filtered) {
    const ln = String(d.line).padStart(maxLineNum);
    const ds = String(d.depthStart).padStart(3);
    const de = String(d.depthEnd).padStart(3);
    const delta = d.opens - d.closes;
    const deltaStr = delta === 0 ? '  0' : delta > 0 ? ` +${delta}` : ` ${delta}`;

    if (showContent) {
      const truncated = d.text.length > 80
        ? d.text.slice(0, 77) + '...'
        : d.text;
      lines.push(`${ln} │ ${ds}→${de} (${deltaStr}) │ ${truncated}`);
    } else {
      lines.push(`${ln} │ depth ${ds}→${de} │ opens ${d.opens} closes ${d.closes}`);
    }
  }

  // Header
  const header = showContent
    ? `${'L'.padStart(maxLineNum)} │  start→end  (net) │ source`
    : `${'L'.padStart(maxLineNum)} │ depth             │ counts`;

  return [header, '─'.repeat(header.length + 20), ...lines].join('\n');
}

export function registerParenDepthTool(server: McpServer): void {
  server.registerTool(
    'jerboa_paren_depth',
    {
      title: 'Paren Depth at Lines',
      description:
        'Report parenthesis/bracket/brace nesting depth at each line in a range. ' +
        'Shows depth at line start, depth at line end, opens/closes per line, and source text. ' +
        'Reader-aware: respects strings, comments, char/block comments, pipes. ' +
        'Pure TypeScript — no subprocess, runs in milliseconds.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z.string().optional()
          .describe('Path to a Jerboa source file'),
        code: z.string().optional()
          .describe('Inline code to analyze (alternative to file_path)'),
        start_line: z.number().int().min(1).optional()
          .describe('First line to report (1-based, default: 1)'),
        end_line: z.number().int().min(1).optional()
          .describe('Last line to report (default: last line of file)'),
        context: z.number().int().min(0).optional()
          .describe('Extra lines of context before start_line and after end_line (default: 0)'),
        show_content: z.boolean().optional()
          .describe('Show source text alongside depth (default: true)'),
      },
    },
    async ({ file_path, code, start_line, end_line, context: ctx, show_content }) => {
      let source: string;

      if (file_path) {
        try {
          source = await readFile(file_path, 'utf-8');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return {
            content: [{ type: 'text' as const, text: `Failed to read file: ${msg}` }],
            isError: true,
          };
        }
      } else if (code) {
        source = code;
      } else {
        return {
          content: [{ type: 'text' as const, text: 'Either file_path or code must be provided.' }],
          isError: true,
        };
      }

      const depths = computeLineDepths(source);
      const totalLines = depths.length;

      const ctxLines = ctx ?? 0;
      const rawStart = start_line ?? 1;
      const rawEnd = end_line ?? totalLines;
      const effectiveStart = Math.max(1, rawStart - ctxLines);
      const effectiveEnd = Math.min(totalLines, rawEnd + ctxLines);
      const showSrc = show_content !== false;

      const report = formatDepthReport(depths, effectiveStart, effectiveEnd, showSrc);

      return {
        content: [{ type: 'text' as const, text: report }],
      };
    },
  );
}
