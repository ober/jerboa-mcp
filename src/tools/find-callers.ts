import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { scanSchemeFiles, findSymbolOccurrences } from './parse-utils.js';

export function registerFindCallersTool(server: McpServer): void {
  server.registerTool(
    'jerboa_find_callers',
    {
      title: 'Find Symbol Callers',
      description:
        'Find all files that reference a given symbol. Recursively scans .ss files ' +
        'in a directory for occurrences and reports file paths with line numbers. ' +
        'Optionally verifies that the file imports the expected module. ' +
        'Pure TypeScript — no subprocess.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        symbol: z.string().describe('Symbol name to find usages of'),
        directory: z
          .string()
          .describe('Directory to search in (absolute path)'),
        module_path: z
          .string()
          .optional()
          .describe(
            'Module the symbol comes from, for import verification (e.g. "(std text json)")',
          ),
      },
    },
    async ({ symbol, directory, module_path }) => {
      const files = await scanSchemeFiles(directory);

      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No .ss files found in ${directory}.`,
            },
          ],
        };
      }

      const callers: Array<{ path: string; lines: number[] }> = [];

      for (const file of files) {
        try {
          const content = await readFile(file, 'utf-8');

          // Optional module import check
          if (module_path) {
            // Accept both :std/text/json and (std text json) style paths
            const modNormalized = module_path.startsWith(':')
              ? module_path.slice(1)
              : module_path;
            if (!content.includes(module_path) && !content.includes(modNormalized)) {
              continue;
            }
          }

          const occurrences = findSymbolOccurrences(content, symbol);
          if (occurrences.length > 0) {
            callers.push({
              path: file,
              lines: occurrences.map((o) => o.line),
            });
          }
        } catch {
          /* skip unreadable files */
        }
      }

      if (callers.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No references to "${symbol}" found in ${directory}.`,
            },
          ],
        };
      }

      const sections: string[] = [
        `References to "${symbol}" (${callers.length} file${callers.length === 1 ? '' : 's'}):`,
        '',
      ];

      for (const caller of callers) {
        sections.push(`  ${caller.path}`);
        if (caller.lines.length > 0) {
          sections.push(`    lines: ${caller.lines.join(', ')}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
