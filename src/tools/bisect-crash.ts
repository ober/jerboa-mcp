import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChez } from '../chez.js';

/**
 * Split a source file into preamble lines and body forms.
 *
 * Strategy: collect leading top-level forms that look like declarations
 * (import, export, library, module, define-syntax, define-record-type, meta, etc.)
 * as preamble, then treat the rest as bisectable body forms.
 *
 * A "top-level form" is detected by a line that starts with `(` at column 0.
 */
function splitPreambleAndBody(source: string): { preamble: string[]; body: string[] } {
  const lines = source.split('\n');
  const forms: string[] = [];
  let current: string[] = [];
  let depth = 0;

  for (const line of lines) {
    current.push(line);
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0 && current.join('\n').trim() !== '') {
      forms.push(current.join('\n'));
      current = [];
      depth = 0;
    }
  }
  if (current.join('\n').trim()) {
    forms.push(current.join('\n'));
  }

  // Preamble heuristic: leading forms whose first non-whitespace token after `(`
  // is one of the declaration keywords.
  const PREAMBLE_KEYWORDS = new Set([
    'import', 'export', 'library', 'module', 'define-syntax',
    'define-record-type', 'meta', 'include', 'load',
  ]);

  let splitIdx = 0;
  for (let i = 0; i < forms.length; i++) {
    const trimmed = forms[i].trimStart();
    const match = trimmed.match(/^\((\S+)/);
    if (match && PREAMBLE_KEYWORDS.has(match[1])) {
      splitIdx = i + 1;
    } else {
      break;
    }
  }

  return {
    preamble: forms.slice(0, splitIdx),
    body: forms.slice(splitIdx),
  };
}

function isCrash(exitCode: number, stderr: string, stdout: string): boolean {
  if (exitCode === 0) return false;
  const combined = stderr + stdout;
  return /Error|Exception|Abort|fatal/i.test(combined);
}

async function testForms(
  preamble: string[],
  body: string[],
  jerboaHome: string | undefined,
  timeout: number,
): Promise<boolean> {
  const code = [...preamble, ...body].join('\n\n');
  const result = await runChez(code, { jerboaHome, timeout });
  return isCrash(result.exitCode, result.stderr, result.stdout);
}

export function registerBisectCrashTool(server: McpServer): void {
  server.registerTool(
    'jerboa_bisect_crash',
    {
      title: 'Bisect Crash',
      description:
        'Binary-search a crashing Jerboa file to find the minimal set of top-level forms ' +
        'that reproduce the crash. Keeps the preamble (imports, exports) and bisects body forms.',
      annotations: { readOnlyHint: true, idempotentHint: false },
      inputSchema: {
        file_path: z.string().describe('Path to the crashing .ss/.sls file'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
        timeout: z.coerce.number().optional().describe('Timeout per run in ms (default: 15000)'),
      },
    },
    async ({ file_path, jerboa_home, timeout: timeoutMs }) => {
      const timeout = timeoutMs ?? 15_000;

      let source: string;
      try {
        source = await readFile(file_path, 'utf-8');
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }],
          isError: true,
        };
      }

      const { preamble, body } = splitPreambleAndBody(source);

      if (body.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No body forms found to bisect (file may be all preamble).',
            },
          ],
        };
      }

      // First check: does the file actually crash?
      const fullCrash = await testForms(preamble, body, jerboa_home, timeout);
      if (!fullCrash) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'File does not appear to crash (exit code 0 or no error in output). Nothing to bisect.',
            },
          ],
        };
      }

      // Check if preamble alone causes the crash
      const preambleCrash = await testForms(preamble, [], jerboa_home, timeout);
      if (preambleCrash) {
        const preambleText = preamble.join('\n\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Preamble alone causes the crash (no body forms needed):\n\n\`\`\`scheme\n${preambleText}\n\`\`\``,
            },
          ],
        };
      }

      // Binary search over body forms
      let candidates = body.slice();
      let iterations = 0;
      const MAX_ITERATIONS = 10;

      while (candidates.length > 2 && iterations < MAX_ITERATIONS) {
        iterations++;
        const mid = Math.ceil(candidates.length / 2);
        const upper = candidates.slice(0, mid);
        const lower = candidates.slice(mid);

        const upperCrash = await testForms(preamble, upper, jerboa_home, timeout);
        if (upperCrash) {
          candidates = upper;
          continue;
        }

        const lowerCrash = await testForms(preamble, lower, jerboa_home, timeout);
        if (lowerCrash) {
          candidates = lower;
          continue;
        }

        // Neither half alone crashes — need both (or more complex interaction); stop here
        break;
      }

      const preambleText = preamble.join('\n\n');
      const bodyText = candidates.join('\n\n');
      const combined = preamble.length > 0
        ? `${preambleText}\n\n${bodyText}`
        : bodyText;

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Minimal crashing set (${candidates.length} body form(s), ${iterations} bisect iteration(s)):`,
              '',
              '```scheme',
              combined,
              '```',
            ].join('\n'),
          },
        ],
      };
    },
  );
}
