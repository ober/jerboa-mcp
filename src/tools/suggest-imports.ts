import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, ERROR_MARKER } from '../chez.js';

const RESULT_MARKER = 'JERBOA-MCP-IMPORT:';

// Curated list of commonly-used Jerboa standard library modules to scan.
export const STD_MODULES = [
  '(std iter)',
  '(std test)',
  '(std format)',
  '(std sort)',
  '(std list)',
  '(std string)',
  '(std regex)',
  '(std text json)',
  '(std text csv)',
  '(std pregexp)',
  '(std net http)',
  '(std net websocket)',
  '(std net socket)',
  '(std io)',
  '(std os)',
  '(std os signal)',
  '(std actor)',
  '(std db sqlite)',
  '(std db postgresql)',
  '(std crypto)',
  '(std srfi 1)',
  '(std srfi 13)',
  '(std srfi 19)',
  '(jerboa prelude)',
];

export function registerSuggestImportsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_suggest_imports',
    {
      title: 'Suggest Imports',
      description:
        'Find which standard library module exports a given symbol. ' +
        'Scans common (std ...) modules and reports matching import statements. ' +
        'For less common modules, use jerboa_apropos as a fallback.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        symbol: z
          .string()
          .describe(
            'Symbol to find the import for (e.g. "sort", "json->datum", "hash-ref")',
          ),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ symbol, jerboa_home }) => {
      const escapedSym = escapeSchemeString(symbol);
      const code = buildSuggestExpr(escapedSym);

      const result = await runChez(code, { timeout: 60_000, jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Import search timed out after 60 seconds.',
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode === 127) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'scheme not found. Ensure Chez Scheme is installed and in PATH.',
            },
          ],
          isError: true,
        };
      }

      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching for "${symbol}":\n${errorMsg}`,
            },
          ],
          isError: true,
        };
      }

      // Parse JERBOA-MCP-IMPORT:module-path lines
      const importLines = stdout
        .split('\n')
        .filter((l) => l.startsWith(RESULT_MARKER));

      const modules = importLines.map((l) =>
        l.slice(RESULT_MARKER.length).trim(),
      );

      if (modules.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Symbol "${symbol}" not found in common standard library modules.\n\n` +
                `Try using jerboa_apropos to search more broadly, then jerboa_module_exports to check specific modules.`,
            },
          ],
        };
      }

      const sections: string[] = [
        `Symbol "${symbol}" is exported by:`,
        '',
      ];
      for (const mod of modules) {
        sections.push(`  (import ${mod})`);
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}

function buildSuggestExpr(escapedSym: string): string {
  // Build import+scan code for each module
  const moduleScans = STD_MODULES.map((mod) => `
  (guard (e [else (void)])
    (let ((env-before (the-environment)))
      (import ${mod})
      (let ((env-after (the-environment))
            (target (string->symbol "${escapedSym}")))
        (guard (e [else (void)])
          (let ((val (eval target env-after)))
            (display "${RESULT_MARKER}")
            (display "${mod}")
            (newline))))))`).join('\n');

  return `
(import (jerboa prelude))
(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
${moduleScans})
`;
}
