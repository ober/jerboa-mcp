import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, escapeSchemeString } from '../chez.js';

export function registerHeapProfileTool(server: McpServer): void {
  server.registerTool(
    'jerboa_heap_profile',
    {
      title: 'Heap Profile Expression',
      description:
        'Capture Chez Scheme GC heap metrics before and after evaluating an expression. ' +
        'Reports bytes-allocated delta, GC collection count delta, and CPU time. ' +
        'Useful for memory profiling and detecting allocation hot-spots.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        expression: z.string().describe('The expression to profile for memory usage'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Module paths to import (e.g. ["(std text json)", "(std sort)"])'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);
      const preamble = buildPreamble(imports);

      const script = `${preamble}

; Force a GC to get a clean baseline
(collect)
(define __before-alloc (bytes-allocated))
(define __before-cpu (cpu-time))
(define __before-gc (collections))

(define __heap-result
  (guard (e [else
             (display "${ERROR_MARKER}\\n")
             (display-condition e (current-output-port))
             (quote __heap-error)])
    ${escaped}))

; Force another GC so we can see what was retained
(collect)
(define __after-alloc (bytes-allocated))
(define __after-cpu (cpu-time))
(define __after-gc (collections))

(unless (eq? __heap-result (quote __heap-error))
  (display "Heap Profile Results:\\n")
  (display "  bytes-allocated (delta): ")
  (display (- __after-alloc __before-alloc))
  (newline)
  (display "  bytes-allocated (before): ")
  (display __before-alloc)
  (newline)
  (display "  bytes-allocated (after):  ")
  (display __after-alloc)
  (newline)
  (display "  gc-collections (delta): ")
  (display (- __after-gc __before-gc))
  (newline)
  (display "  gc-collections (before): ")
  (display __before-gc)
  (newline)
  (display "  gc-collections (after):  ")
  (display __after-gc)
  (newline)
  (display "  cpu-time-ms (elapsed): ")
  (display (inexact (/ (- __after-cpu __before-cpu) 1000)))
  (newline)
  (display "Result: ")
  (write __heap-result)
  (newline))
`;

      const result = await runChez(script, { timeout: 60_000, jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Heap profile timed out after 60 seconds.' }], isError: true };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const msg = result.stdout.slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${msg}` }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      const output = result.stdout.trim();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Heap Profile for: ${expression}\n\n${output || '(no output)'}`,
          },
        ],
      };
    },
  );
}
