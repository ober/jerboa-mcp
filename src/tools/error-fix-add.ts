import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

export function registerErrorFixAddTool(server: McpServer): void {
  server.registerTool(
    'jerboa_error_fix_add',
    {
      title: 'Add Error Fix',
      description:
        'Add a new error→fix mapping to error-fixes.json. ' +
        'Records the error pattern, explanation, fix, and optional code examples. ' +
        'Builds the fix database over time.',
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        id: z.string().describe('Kebab-case ID for the entry (e.g. "unbound-identifier")'),
        pattern: z.string().describe('Regex string matching the error message'),
        type: z.string().optional().describe('Error type name (e.g. "Unbound Identifier")'),
        fix: z.string().describe('The fix description'),
        message: z.string().optional().describe('Short message (alternative to explanation)'),
        explanation: z.string().optional().describe('Detailed explanation'),
        code_example: z.string().optional().describe('Working code example'),
        wrong_example: z.string().optional().describe('Example of wrong code'),
        imports: z.array(z.string()).optional().describe('Required imports'),
        related_recipes: z.array(z.string()).optional().describe('Related cookbook IDs'),
      },
    },
    async ({
      id,
      pattern,
      type,
      fix,
      message,
      explanation,
      code_example,
      wrong_example,
      imports,
      related_recipes,
    }) => {
      // Read existing entries
      let entries: ErrorFixEntry[] = [];
      try {
        const raw = await readFile(ERROR_FIXES_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          entries = parsed as ErrorFixEntry[];
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error reading ${ERROR_FIXES_PATH}: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          };
        }
        // File doesn't exist yet — start with empty array
      }

      // Build the new entry
      const entry: ErrorFixEntry = { id, pattern, fix };
      if (type) entry.type = type;
      if (message) entry.message = message;
      if (explanation) entry.explanation = explanation;
      if (code_example) entry.code_example = code_example;
      if (wrong_example) entry.wrong_example = wrong_example;
      if (imports && imports.length > 0) entry.imports = imports;
      if (related_recipes && related_recipes.length > 0) entry.related_recipes = related_recipes;

      // Replace existing entry with same id, or append
      const existingIdx = entries.findIndex((e) => e.id === id);
      if (existingIdx >= 0) {
        entries[existingIdx] = entry;
      } else {
        entries.push(entry);
      }

      // Write back
      try {
        await mkdir(dirname(ERROR_FIXES_PATH), { recursive: true });
        await writeFile(ERROR_FIXES_PATH, JSON.stringify(entries, null, 2) + '\n');
      } catch (e: unknown) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error writing ${ERROR_FIXES_PATH}: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Error fix '${id}' saved (total: ${entries.length} entries).`,
          },
        ],
      };
    },
  );
}
