import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString } from '../chez.js';

export function registerAproposTool(server: McpServer): void {
  server.registerTool(
    'jerboa_apropos',
    {
      title: 'Search Jerboa Symbols',
      description:
        'Search for Jerboa/Chez Scheme symbols matching a pattern string. ' +
        'Scans the environment for symbols whose names contain the pattern substring. ' +
        'Example: pattern "hash" returns hash-set!, hash-ref, and related symbols.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        pattern: z.string().describe('Search pattern (substring match against symbol names)'),
        module_path: z
          .string()
          .optional()
          .describe('Restrict search to a specific module (e.g. "(std text json)")'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ pattern, module_path, jerboa_home }) => {
      const escaped = escapeSchemeString(pattern);

      let code: string;
      if (module_path) {
        const { normalizeImport } = await import('../chez.js');
        const normalizedMod = normalizeImport(module_path);
        code = `
(import (jerboa prelude))
(import ${normalizedMod})

(let ((pattern "${escaped}")
      (matches '()))
  (let ((env (the-environment)))
    (environment-for-each env
      (lambda (name val)
        (let ((name-str (symbol->string name)))
          (when (string-search-forward pattern name-str 0)
            (set! matches (cons name matches)))))))
  (for-each (lambda (name) (display name) (newline))
    (sort matches (lambda (a b) (string<? (symbol->string a) (symbol->string b))))))
`;
      } else {
        code = `
(import (jerboa prelude))

(let ((pattern "${escaped}")
      (matches '()))
  (let ((env (the-environment)))
    (environment-for-each env
      (lambda (name val)
        (let ((name-str (symbol->string name)))
          (when (string-search-forward pattern name-str 0)
            (set! matches (cons name matches)))))))
  (for-each (lambda (name) (display name) (newline))
    (sort matches (lambda (a b) (string<? (symbol->string a) (symbol->string b))))))
`;
      }

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Symbol search timed out.' }],
          isError: true,
        };
      }

      if (result.exitCode !== 0 && !result.stdout.trim()) {
        const errMsg = result.stderr.trim() || result.stdout.trim();
        return {
          content: [{ type: 'text' as const, text: `Error:\n${errMsg}` }],
          isError: true,
        };
      }

      const output = result.stdout.trim();
      if (!output) {
        return {
          content: [{ type: 'text' as const, text: `No symbols found matching "${pattern}".` }],
        };
      }

      const scopeMsg = module_path ? ` in ${module_path}` : '';
      return {
        content: [{ type: 'text' as const, text: `Symbols matching "${pattern}"${scopeMsg}:\n\n${output}` }],
      };
    },
  );
}
