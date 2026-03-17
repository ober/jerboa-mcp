import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER } from '../chez.js';

const DESC_MARKER = 'JERBOA-MCP-DESC:';

export function registerDescribeTool(server: McpServer): void {
  server.registerTool(
    'jerboa_describe',
    {
      title: 'Describe Value',
      description: 'Evaluate an expression and describe the resulting value type, structure, and contents.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        expression: z.string().describe('Expression to evaluate and describe'),
        imports: z.array(z.string()).optional(),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ expression, imports, jerboa_home }) => {
      const script = buildPreamble(imports) + `
(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let ([val ${expression}])
    (display "${DESC_MARKER}type: ")
    (display (cond
      [(pair? val) (string-append "pair, length " (number->string (length val)))]
      [(vector? val) (string-append "vector, length " (number->string (vector-length val)))]
      [(string? val) (string-append "string, length " (number->string (string-length val)))]
      [(hashtable? val) (string-append "hashtable, size " (number->string (hashtable-size val)))]
      [(procedure? val) "procedure"]
      [(boolean? val) "boolean"]
      [(number? val) (if (exact? val) "exact number" "inexact number")]
      [(symbol? val) "symbol"]
      [(null? val) "null"]
      [(char? val) "char"]
      [else (with-output-to-string (lambda () (write val)))]))
    (newline)
    (display "${DESC_MARKER}value: ")
    (write val)
    (newline)))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Timed out.' }], isError: true };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const msg = result.stdout.slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      const output = result.stdout.trim();
      return { content: [{ type: 'text' as const, text: output }] };
    },
  );
}
