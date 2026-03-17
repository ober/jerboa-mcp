import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, escapeSchemeString, normalizeImport, ERROR_MARKER } from '../chez.js';

export function registerSmartCompleteTool(server: McpServer): void {
  server.registerTool(
    'jerboa_smart_complete',
    {
      title: 'Smart Symbol Completion',
      description:
        'Return valid symbol completions for a partial prefix from the Jerboa/Chez environment. ' +
        'Optionally scoped to specific modules. ' +
        'Helps discover correct function names without guessing.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        prefix: z.string().describe('Partial symbol prefix to complete'),
        modules: z
          .array(z.string())
          .optional()
          .describe(
            'Module paths to scope completions to (e.g. ["(std sort)", "(std text json)"])',
          ),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
        max_results: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default 30)'),
      },
    },
    async ({ prefix, modules, jerboa_home, max_results }) => {
      const limit = max_results ?? 30;
      const escapedPrefix = escapeSchemeString(prefix);

      // Build import lines for specified modules (or just the prelude)
      const moduleImports: string[] = [];
      if (modules && modules.length > 0) {
        for (const mod of modules) {
          moduleImports.push(normalizeImport(mod));
        }
      }

      const preamble = buildPreamble(moduleImports);

      const script = `${preamble}

(let* ([prefix "${escapedPrefix}"]
       [prefix-len (string-length prefix)]
       [env (the-environment)]
       [matches '()])
  (environment-for-each env
    (lambda (name val)
      (let ([ns (symbol->string name)])
        (when (and (>= (string-length ns) prefix-len)
                   (string=? (substring ns 0 prefix-len) prefix))
          (set! matches (cons ns matches))))))
  (let ([sorted (list-sort string<? matches)])
    (for-each
      (lambda (s) (display s) (newline))
      (if (> (length sorted) ${limit})
          (list-head sorted ${limit})
          sorted))))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Completion timed out after 30 seconds.' }],
          isError: true,
        };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const errorMsg = result.stdout
          .slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length)
          .trim();
        return {
          content: [{ type: 'text' as const, text: `Error during completion:\n${errorMsg}` }],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        const errText = result.stderr.trim() || `Exit code ${result.exitCode}`;
        return {
          content: [{ type: 'text' as const, text: `Error:\n${errText}` }],
          isError: true,
        };
      }

      const output = result.stdout.trim();
      if (!output) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No completions found for '${prefix}'.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Completions for '${prefix}':\n\n${output}`,
          },
        ],
      };
    },
  );
}
