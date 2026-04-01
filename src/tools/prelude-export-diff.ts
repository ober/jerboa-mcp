import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, getJerboaHome } from '../chez.js';
import { join } from 'node:path';

/**
 * Build a Chez script that computes the set difference:
 * symbols exported by a stdlib module but NOT re-exported from (jerboa prelude).
 */
function buildExportDiffScript(moduleSpec: string): string {
  return `(import (chezscheme))

(define (module-exports mod-spec)
  (guard (e [else '()])
    (let* ([env (environment mod-spec)]
           [names (environment-symbols env)])
      (list->vector (map symbol->string (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) names))))))

; Get prelude exports
(define prelude-exports
  (guard (e [else '#()])
    (let* ([env (environment '(jerboa prelude))]
           [names (environment-symbols env)])
      (list->vector (map symbol->string (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) names))))))

; Get target module exports
(define module-exports-vec
  (guard (e [else '#()])
    (let* ([env (environment '${moduleSpec})]
           [names (environment-symbols env)])
      (list->vector (map symbol->string (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) names))))))

(define prelude-set
  (let ([ht (make-equal-hashtable)])
    (vector-for-each (lambda (s) (hashtable-set! ht s #t)) prelude-exports)
    ht))

; Find symbols in module but not in prelude
(define missing
  (let ([result '()])
    (vector-for-each
      (lambda (s)
        (unless (hashtable-ref prelude-set s #f)
          (set! result (cons s result))))
      module-exports-vec)
    (sort string<? result)))

(display (length missing))
(display " symbols in ")
(display '${moduleSpec})
(display " not re-exported from (jerboa prelude):")
(newline)
(for-each (lambda (s) (display "  ") (display s) (newline)) missing)
`;
}

export function registerPreludeExportDiffTool(server: McpServer): void {
  server.registerTool(
    'jerboa_prelude_export_diff',
    {
      title: 'Diff Prelude Exports vs Stdlib Module',
      description:
        'Compare what (jerboa prelude) re-exports against what a stdlib module exports. ' +
        'Shows symbols present in the module but missing from the prelude — helps ensure ' +
        'new stdlib features are surfaced to users who only (import (jerboa prelude)). ' +
        'Provide a single module like (std misc list) or check all common modules at once.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        module: z
          .string()
          .optional()
          .describe(
            'Module spec to compare, e.g. "(std misc list)" or "(std result)". ' +
            'Omit to check all common stdlib modules.',
          ),
        jerboa_home: z.string().optional().describe('Override JERBOA_HOME'),
      },
    },
    async ({ module: mod, jerboa_home }) => {
      const commonModules = [
        '(std misc list)',
        '(std misc string)',
        '(std misc func)',
        '(std result)',
        '(std datetime)',
        '(std iter)',
        '(std sort)',
        '(std sugar)',
      ];

      const modulesToCheck = mod ? [mod] : commonModules;
      const outputs: string[] = [];

      for (const m of modulesToCheck) {
        // Normalize: "(std misc list)" → (std misc list) without outer quotes
        const normalized = m.trim();
        const script = buildExportDiffScript(normalized);
        const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 30_000 });

        if (result.timedOut) {
          outputs.push(`${normalized}: timed out`);
          continue;
        }

        const out = (result.stdout + result.stderr).trim();
        if (!out) {
          outputs.push(`${normalized}: (no output — module may not exist)`);
        } else {
          outputs.push(out);
        }
      }

      return {
        content: [{ type: 'text' as const, text: outputs.join('\n\n') }],
      };
    },
  );
}
