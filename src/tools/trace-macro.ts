import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, escapeSchemeString } from '../chez.js';

export function registerTraceMacroTool(server: McpServer): void {
  server.registerTool(
    'jerboa_trace_macro',
    {
      title: 'Trace Macro Expansion Steps',
      description:
        'Step-by-step macro expansion showing each transformation level. ' +
        'Repeatedly expands the outermost macro form until no more expansion is possible, ' +
        'showing each intermediate state. Falls back to full expansion if step-by-step is not available.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        expression: z.string().describe('The macro expression to trace (e.g. "(when #t (display \\"hi\\"))")'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Modules to import for macro context'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);
      const preamble = buildPreamble(imports);

      // Try step-by-step expansion using expand-once (if available), falling back to full expand
      const script = `${preamble}

(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let* ([src-expr (read (open-string-input-port "${escaped}"))]
         [step-count 0]
         [max-steps 20])

    ; Try step-by-step expansion with expand-once
    ; expand-once is a Chez extension — guard in case it is not available
    (guard (step-err [else
                      ; expand-once not available: just show the full expansion
                      (display "Full expansion (step-by-step not available):\\n\\n")
                      (pretty-print (expand src-expr))])
      (let loop ([curr src-expr])
        (let ([next (guard (expand-err [else curr]) (expand-once curr))])
          (display (string-append "Step " (number->string step-count) ":\\n"))
          (pretty-print curr)
          (newline)
          (cond
            ; Reached fixed point — curr == next means no more expansion
            [(equal? curr next)
             (display "--- fully expanded ---\\n")]
            [(>= step-count max-steps)
             (display (string-append "--- stopped after " (number->string max-steps) " steps ---\\n"))]
            [else
             (set! step-count (+ step-count 1))
             (loop next)]))))))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Macro trace timed out.' }], isError: true };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const msg = result.stdout.slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${msg}` }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      const output = result.stdout.trim();
      return { content: [{ type: 'text' as const, text: output || '(no expansion)' }] };
    },
  );
}
