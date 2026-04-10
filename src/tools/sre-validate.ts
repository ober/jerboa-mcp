import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, escapeSchemeString } from '../chez.js';

export function registerSreValidateTool(server: McpServer): void {
  server.registerTool(
    'jerboa_sre_validate',
    {
      title: 'SRE Form Validator',
      description:
        'Validate an SRE (s-expression regular expression) form by compiling it via the Jerboa regex module. ' +
        'Reports whether the form compiles successfully, lists named captures (=> name ...) found in the form, ' +
        'and optionally tests the compiled pattern against a sample string. ' +
        'Use this to catch unsupported SRE forms before runtime — e.g. (~ ...) complement with unsupported char classes, ' +
        '(embed ...) composition issues, or malformed capture groups.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        sre_form: z
          .string()
          .describe(
            'The SRE form as a string (e.g. "(+ digit)", "(: (=> year (= 4 digit)) \\"-\\" (=> month (= 2 digit)))")',
          ),
        test_string: z
          .string()
          .optional()
          .describe('Optional sample string to test the compiled pattern against'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (overrides JERBOA_HOME env var)'),
      },
    },
    async ({ sre_form, test_string, jerboa_home }) => {
      const escapedSre = escapeSchemeString(sre_form);

      const testBlock = test_string
        ? `
    (let* ([test-str "${escapeSchemeString(test_string)}"]
           [m (re-search compiled test-str)])
      (if m
          (begin
            (display (format "Test '~a': MATCH\\n" test-str))
            (let ([all (re-find-all compiled test-str)])
              (when (and all (not (null? all)))
                (display (format "  All matches: ~a\\n" all)))))
          (display (format "Test '~a': NO MATCH\\n" test-str))))`
        : '';

      const script = `${buildPreamble()}

;; Walk an SRE form to extract named captures: (=> name ...) patterns
(define (sre-named-captures sre)
  (cond
    [(not (pair? sre)) '()]
    [(and (eq? (car sre) '=>) (>= (length sre) 3))
     (let ([name (cadr sre)])
       (cons (format "~a" name)
             (apply append (map sre-named-captures (cddr sre)))))]
    [else (apply append (map sre-named-captures sre))]))

(let* ([sre-str "${escapedSre}"]
       [sre-form (with-input-from-string sre-str read)]
       [captures (sre-named-captures sre-form)])
  (let ([compiled
         (guard (e [#t (begin
                         (display (format "Error: ~a\\n"
                                          (with-output-to-string (lambda () (display-condition e)))))
                         #f)])
           (re sre-form))])
    (if (not compiled)
        (display "Status: INVALID\\n")
        (begin
          (display "Status: OK\\n")
          (display (format "Named captures: ~a\\n"
                           (if (null? captures)
                               "(none)"
                               (string-join captures ", "))))
          ;; Try to show the internal compiled representation for debugging
          (let ([repr (guard (e [#t #f])
                        (with-output-to-string (lambda () (write compiled))))])
            (when repr
              (display (format "Compiled: ~a\\n" repr))))${testBlock}))))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Timed out after 30 seconds.' }],
          isError: true,
        };
      }

      const output = result.stdout.trim() || result.stderr.trim();
      return {
        content: [{ type: 'text' as const, text: output || '(no output)' }],
        isError: result.exitCode !== 0 && !result.stdout.includes('Status:'),
      };
    },
  );
}
