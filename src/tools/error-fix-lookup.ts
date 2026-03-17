import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ERROR_FIXES_PATH = join(__dirname, '..', '..', 'error-fixes.json');

interface ErrorFixEntry {
  id: string;
  pattern: string;
  type?: string;
  fix: string;
  code_example?: string;
  wrong_example?: string;
  imports?: string[];
  related_recipes?: string[];
  message?: string;
  explanation?: string;
}

function loadErrorFixes(): ErrorFixEntry[] {
  try {
    const raw = readFileSync(ERROR_FIXES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ErrorFixEntry[]) : [];
  } catch {
    return [];
  }
}

function formatEntry(entry: ErrorFixEntry): string {
  const lines: string[] = [];
  lines.push(`## Fix: ${entry.id}`);
  if (entry.type) {
    lines.push(`**Error type:** ${entry.type}`);
  }
  const desc = entry.explanation ?? entry.message;
  if (desc) {
    lines.push(`**Explanation:** ${desc}`);
  }
  lines.push(`**Fix:** ${entry.fix}`);
  if (entry.wrong_example) {
    lines.push(`**Wrong:** \`${entry.wrong_example}\``);
  }
  if (entry.code_example) {
    lines.push('**Correct:**');
    lines.push('```scheme');
    lines.push(entry.code_example);
    lines.push('```');
  }
  if (entry.imports && entry.imports.length > 0) {
    lines.push(`**Imports:** ${entry.imports.join(', ')}`);
  }
  if (entry.related_recipes && entry.related_recipes.length > 0) {
    lines.push(`**Related recipes:** ${entry.related_recipes.join(', ')}`);
  }
  return lines.join('\n');
}

export function registerErrorFixLookupTool(server: McpServer): void {
  server.registerTool(
    'jerboa_error_fix_lookup',
    {
      title: 'Error Fix Lookup',
      description:
        'Instant fix lookup from error-fixes.json for known Jerboa/Chez error patterns. ' +
        'Returns explanation, fix, code example, and related recipes. ' +
        'Much faster than explain-error for known errors.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        error_message: z.string().describe('The error message to look up'),
        search_all: z
          .boolean()
          .optional()
          .describe('If true, return all matches; default is best match only'),
      },
    },
    async ({ error_message, search_all }) => {
      const entries = loadErrorFixes();

      const matches = entries.filter((entry) => {
        try {
          return new RegExp(entry.pattern, 'i').test(error_message);
        } catch {
          return false;
        }
      });

      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No known fix for this error. Try jerboa_explain_error for detailed analysis.',
            },
          ],
        };
      }

      const selected = search_all ? matches : [matches[0]];
      const sections = selected.map(formatEntry);
      const header =
        selected.length === 1
          ? `Found 1 matching fix:\n\n`
          : `Found ${selected.length} matching fixes:\n\n`;

      return {
        content: [
          {
            type: 'text' as const,
            text: header + sections.join('\n\n---\n\n'),
          },
        ],
      };
    },
  );
}
