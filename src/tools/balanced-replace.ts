/**
 * jerboa_balanced_replace — Like Edit but with balance validation.
 * Rejects edits that break delimiter balance.
 *
 * Supports two modes:
 *   1. Single edit: old_string + new_string (original mode)
 *   2. Multi-edit:  edits array — all applied atomically, balance checked once at the end.
 *      This enables "move a paren from line A to line B" as one balanced operation.
 *
 * Pure TypeScript, no subprocess.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { checkBalance } from './check-balance.js';

/**
 * Count delimiters in a text fragment, respecting strings and comments.
 * Returns a map of delimiter -> count.
 */
function countDelimiters(text: string): Record<string, number> {
  const counts: Record<string, number> = {
    '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0,
  };
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // String literal — skip contents
    if (ch === '"') {
      i++;
      while (i < len && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i < len) i++; // skip closing quote
      continue;
    }

    // Line comment — skip to end of line
    if (ch === ';') {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // Block comment #| ... |#
    if (ch === '#' && i + 1 < len && text[i + 1] === '|') {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (text[i] === '#' && i + 1 < len && text[i + 1] === '|') { depth++; i += 2; }
        else if (text[i] === '|' && i + 1 < len && text[i + 1] === '#') { depth--; i += 2; }
        else i++;
      }
      continue;
    }

    // Character literal #\x — skip to avoid counting #\( etc.
    if (ch === '#' && i + 1 < len && text[i + 1] === '\\') {
      i += 2;
      if (i < len && /[a-zA-Z]/.test(text[i])) {
        while (i < len && /[a-zA-Z0-9]/.test(text[i])) i++;
      } else if (i < len) {
        i++;
      }
      continue;
    }

    // Count delimiter
    if (ch in counts) {
      counts[ch]++;
    }

    i++;
  }

  return counts;
}

interface EditPair {
  old_string: string;
  new_string: string;
}

/**
 * Apply multiple edits to source text.
 * Edits are applied in order. Each edit searches in the result of the previous edit.
 * Returns { result, error } — error is set if any old_string is not found or is ambiguous.
 */
function applyEdits(
  source: string,
  edits: EditPair[],
  filePath: string,
): { result?: string; error?: string } {
  let current = source;
  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string } = edits[i];
    const idx = current.indexOf(old_string);
    if (idx === -1) {
      return {
        error:
          `Edit ${i + 1}/${edits.length}: old_string not found in ${filePath}.\n` +
          `Make sure the text matches exactly (including whitespace and indentation).\n` +
          `Searched for: ${old_string.length > 100 ? old_string.slice(0, 100) + '...' : old_string}`,
      };
    }
    const secondIdx = current.indexOf(old_string, idx + 1);
    if (secondIdx !== -1) {
      return {
        error:
          `Edit ${i + 1}/${edits.length}: old_string appears multiple times in ${filePath}.\n` +
          `Provide a larger string with more surrounding context to make it unique.`,
      };
    }
    current = current.slice(0, idx) + new_string + current.slice(idx + old_string.length);
  }
  return { result: current };
}

export function registerBalancedReplaceTool(server: McpServer): void {
  server.registerTool(
    'jerboa_balanced_replace',
    {
      title: 'Balanced String Replace',
      description:
        'Like Edit/string-replace but validates parenthesis/bracket/brace balance before and after. ' +
        'Rejects edits that break balance. Dry-run by default. ' +
        'Pure TypeScript — no subprocess, runs in milliseconds.\n\n' +
        'Two modes:\n' +
        '  1. Single edit: provide old_string + new_string\n' +
        '  2. Multi-edit: provide edits array — all applied atomically, balance checked once.\n' +
        '     Use this to move delimiters between locations (e.g., move ) from line 540 to line 522).',
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z.string().describe('Absolute path to the Jerboa source file'),
        old_string: z.string().optional()
          .describe('The exact text to find and replace (single-edit mode)'),
        new_string: z.string().optional()
          .describe('The replacement text (single-edit mode)'),
        edits: z.array(z.object({
          old_string: z.string().describe('Exact text to find'),
          new_string: z.string().describe('Replacement text'),
        })).optional()
          .describe(
            'Array of {old_string, new_string} pairs applied atomically in order. ' +
            'Balance is checked once on the final result. ' +
            'Use this for multi-site edits like moving a paren from one line to another.',
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'If true (default), only preview the change without writing. Set to false to apply.',
          ),
      },
    },
    async ({ file_path, old_string, new_string, edits, dry_run }) => {
      const isDryRun = dry_run !== false;

      // Validate: either single-edit or multi-edit, not both
      const hasSingle = old_string !== undefined && new_string !== undefined;
      const hasMulti = edits !== undefined && edits.length > 0;

      if (!hasSingle && !hasMulti) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Provide either (old_string + new_string) or edits array.',
          }],
          isError: true,
        };
      }

      // Normalize to edits array
      const editList: EditPair[] = hasMulti
        ? edits!
        : [{ old_string: old_string!, new_string: new_string! }];

      // Read file
      let source: string;
      try {
        source = await readFile(file_path, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: `Failed to read file: ${msg}` }],
          isError: true,
        };
      }

      // Check original balance
      const originalBalance = checkBalance(source);

      // Apply all edits
      const { result: replaced, error: editError } = applyEdits(source, editList, file_path);
      if (editError) {
        return {
          content: [{ type: 'text' as const, text: editError }],
          isError: true,
        };
      }

      // Check new balance
      const newBalance = checkBalance(replaced!);

      // Decision logic
      if (originalBalance.ok && !newBalance.ok) {
        // Check net delimiter change across ALL edits
        let totalOldCounts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
        let totalNewCounts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
        for (const edit of editList) {
          const oc = countDelimiters(edit.old_string);
          const nc = countDelimiters(edit.new_string);
          for (const d of ['(', ')', '[', ']', '{', '}']) {
            totalOldCounts[d] += oc[d];
            totalNewCounts[d] += nc[d];
          }
        }
        const delims = ['(', ')', '[', ']', '{', '}'] as const;
        const netZero = delims.every((d) => totalNewCounts[d] - totalOldCounts[d] === 0);

        if (!netZero) {
          // Edit broke balance — reject
          const errorDetails = newBalance.errors
            .map((err) => {
              switch (err.kind) {
                case 'unclosed':
                  return `  Unclosed '${err.char}' at line ${err.line}, col ${err.col}${err.context ? ` (near '${err.context}')` : ''}`;
                case 'unexpected':
                  return `  Unexpected closer '${err.char}' at line ${err.line}, col ${err.col}`;
                case 'mismatch':
                  return `  Mismatched '${err.char}' at line ${err.line}, col ${err.col} — expected '${err.expected}'`;
              }
            })
            .join('\n');

          return {
            content: [{
              type: 'text' as const,
              text:
                `REJECTED: This edit would break delimiter balance.\n\n` +
                `Balance errors in result:\n${errorDetails}\n\n` +
                `The file was NOT modified. Fix the new_string to maintain balanced delimiters.`,
            }],
            isError: true,
          };
        }
        // Net change is zero — allow the edit with a note
      }

      // Compute summary
      const lines: string[] = [];

      if (!originalBalance.ok && newBalance.ok) {
        lines.push('Note: This edit FIXES a pre-existing balance issue.');
      } else if (!originalBalance.ok && !newBalance.ok) {
        lines.push(
          'Warning: The file has pre-existing balance issues. ' +
          'The edit does not make them worse, but the file is still unbalanced.',
        );
      }

      // Compute line numbers for context (use first edit for reporting)
      const firstIdx = source.indexOf(editList[0].old_string);
      const beforeReplace = source.slice(0, firstIdx);
      const startLine = beforeReplace.split('\n').length;

      const editSummary = editList.length === 1
        ? `1 edit at line ${startLine}`
        : `${editList.length} edits (first at line ${startLine})`;

      if (isDryRun) {
        lines.push(`Dry run — ${editSummary}:`);
        lines.push('');
        for (let i = 0; i < editList.length; i++) {
          const edit = editList[i];
          if (editList.length > 1) {
            lines.push(`--- edit ${i + 1}/${editList.length} ---`);
          }
          lines.push('--- old ---');
          lines.push(edit.old_string);
          lines.push('--- new ---');
          lines.push(edit.new_string);
          lines.push('---');
          lines.push('');
        }
        lines.push(`Balance: OK (${newBalance.topLevelForms} top-level forms)`);
        lines.push('');
        lines.push('Set dry_run to false to apply this change.');

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }

      // Apply the change
      await writeFile(file_path, replaced!, 'utf-8');

      lines.push(`Applied ${editSummary} in ${file_path}`);
      lines.push(`Balance: OK (${newBalance.topLevelForms} top-level forms)`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
