import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, escapeSchemeString } from '../chez.js';

export function registerTraceEvalTool(server: McpServer): void {
  server.registerTool(
    'jerboa_trace_eval',
    {
      title: 'Trace Let* Bindings',
      description:
        'Step through let*/let/letrec binding sequences showing each variable name, type, and value as it is bound. ' +
        'Useful for understanding complex binding sequences and debugging unexpected values.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        expression: z.string().describe('A let*/let/letrec expression to trace'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Module paths to import (e.g. ["(std text json)", "(std sort)"])'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);

      // Detect what kind of let form we have and substitute with the traced version
      const trimmed = expression.trimStart();
      let tracedExpression: string;
      if (trimmed.startsWith('(let*')) {
        tracedExpression = escaped.replace('let*', 'trace-let*');
      } else if (trimmed.startsWith('(letrec*')) {
        tracedExpression = escaped.replace('letrec*', 'trace-letrec*');
      } else if (trimmed.startsWith('(letrec')) {
        tracedExpression = escaped.replace('letrec', 'trace-letrec');
      } else if (trimmed.startsWith('(let ') || trimmed.startsWith('(let\n') || trimmed.startsWith('(let\t')) {
        tracedExpression = escaped.replace('let ', 'trace-let ');
      } else {
        // Not a let form — just eval it and show the result
        tracedExpression = escaped;
      }

      const isLetForm =
        trimmed.startsWith('(let*') ||
        trimmed.startsWith('(letrec') ||
        trimmed.startsWith('(let ') ||
        trimmed.startsWith('(let\n') ||
        trimmed.startsWith('(let\t');

      const preamble = buildPreamble(imports);

      const macros = isLetForm
        ? `
; Tracing macros
(define-syntax trace-let*
  (syntax-rules ()
    [(_ () body ...)
     (begin body ...)]
    [(_ ((var expr) rest ...) body ...)
     (let ([var expr])
       (display "TRACE: ")
       (display 'var)
       (display " = ")
       (write var)
       (newline)
       (trace-let* (rest ...) body ...))]))

(define-syntax trace-letrec*
  (syntax-rules ()
    [(_ () body ...)
     (begin body ...)]
    [(_ ((var expr) rest ...) body ...)
     (letrec* ([var expr])
       (display "TRACE: ")
       (display 'var)
       (display " = ")
       (write var)
       (newline)
       (trace-letrec* (rest ...) body ...))]))

(define-syntax trace-letrec
  (syntax-rules ()
    [(_ ((var expr) ...) body ...)
     (letrec ([var expr] ...)
       (begin
         (display "TRACE: ") (display 'var) (display " = ") (write var) (newline)) ...
       body ...)]))

(define-syntax trace-let
  (syntax-rules ()
    [(_ ((var expr) ...) body ...)
     (let ([var expr] ...)
       (begin
         (display "TRACE: ") (display 'var) (display " = ") (write var) (newline)) ...
       body ...)]))
`
        : '';

      const script = `${preamble}
${macros}
(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let ([__trace-result ${tracedExpression}])
    (display "RESULT: ")
    (write __trace-result)
    (newline)))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Trace timed out after 30 seconds.' }], isError: true };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const msg = result.stdout.slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${msg}` }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      const output = result.stdout.trim();
      return { content: [{ type: 'text' as const, text: output || '(no output)' }] };
    },
  );
}
