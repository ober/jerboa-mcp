import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, normalizeImport, ERROR_MARKER } from '../chez.js';

export function registerModuleCatalogTool(server: McpServer): void {
  server.registerTool(
    'jerboa_module_catalog',
    {
      title: 'Module Catalog',
      description:
        'Compact reference of all exports from a Jerboa module with kind, arity, and brief descriptions. ' +
        'Replaces multiple jerboa_doc calls. Returns a table of exports.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        module: z
          .string()
          .describe('Module path (e.g. "(std sort)", "(std text json)", ":std/sort")'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ module: modulePath, jerboa_home }) => {
      const normalized = normalizeImport(modulePath);

      // We need to get the module's exports and describe each one.
      // Strategy: use environment-symbols on the module's environment, then eval each symbol
      // in a combined environment to get kind and arity.
      const script = `${buildPreamble()}
(import ${normalized})

(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let* ([mod-env (environment '${normalized})]
         [syms (list-sort symbol<? (environment-symbols mod-env))])
    (for-each
      (lambda (sym)
        (guard (e [else
                   (display sym) (display "\\t") (display "?") (display "\\t") (display "-") (newline)])
          (let* ([val (eval sym mod-env)]
                 [kind (cond
                         [(procedure? val) "proc"]
                         [(boolean? val) "bool"]
                         [(string? val) "str"]
                         [(number? val) "num"]
                         [(symbol? val) "sym"]
                         [else "val"])]
                 [arity-str
                  (if (procedure? val)
                      (let* ([mask (procedure-arity-mask val)]
                             [arities '()])
                        (do ([i 0 (+ i 1)])
                            [(> i 20)]
                          (when (bitwise-bit-set? mask i)
                            (set! arities (cons i arities))))
                        (cond
                          [(null? arities) "?"]
                          ;; Check for variadic: if bit 0 is set in the mask that means arity 0,
                          ;; check a high bit like 63 for variadic indication via negative mask
                          [(< mask 0) (string-append (number->string (- (length arities))) "+")]
                          [else (string-join (map number->string (reverse arities)) "/")]))
                      "-")])
            (display sym) (display "\\t") (display kind) (display "\\t") (display arity-str) (newline))))
      syms)))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Module catalog timed out.' }],
          isError: true,
        };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const errorMsg = result.stdout
          .slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length)
          .trim();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error introspecting ${normalized}:\n${errorMsg}`,
            },
          ],
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

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Module ${normalized} exports no symbols.`,
            },
          ],
        };
      }

      // Parse tab-separated lines: symbol\tkind\tarity
      const rows = lines.map((line) => {
        const parts = line.split('\t');
        return {
          name: parts[0]?.trim() ?? '',
          kind: parts[1]?.trim() ?? '?',
          arity: parts[2]?.trim() ?? '-',
        };
      });

      // Format as a markdown table
      const nameWidth = Math.max(6, ...rows.map((r) => r.name.length));
      const kindWidth = Math.max(4, ...rows.map((r) => r.kind.length));

      const header = [
        `| ${'Symbol'.padEnd(nameWidth)} | ${'Kind'.padEnd(kindWidth)} | Arity |`,
        `| ${'-'.repeat(nameWidth)} | ${'-'.repeat(kindWidth)} | ----- |`,
      ].join('\n');

      const tableRows = rows
        .map((r) => `| ${r.name.padEnd(nameWidth)} | ${r.kind.padEnd(kindWidth)} | ${r.arity}`)
        .join('\n');

      const text = [
        `Module ${normalized} — ${rows.length} export(s):`,
        '',
        header,
        tableRows,
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: text }],
      };
    },
  );
}
