import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, ERROR_MARKER, buildPreamble } from '../chez.js';

const RESULT_MARKER = 'JERBOA-MCP-BENCH:';

export function registerBenchmarkTool(server: McpServer): void {
  server.registerTool(
    'jerboa_benchmark',
    {
      title: 'Benchmark Expression',
      description:
        'Time a Jerboa Scheme expression\'s execution and return performance statistics. ' +
        'Reports wall-clock time, CPU time, and allocation stats. ' +
        'Uses Chez Scheme\'s (time ...) form and process-time-clock. ' +
        'Supports multiple iterations for averaging.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        expression: z
          .string()
          .describe('The Jerboa Scheme expression to benchmark'),
        imports: z
          .array(z.string())
          .optional()
          .describe(
            'Module paths to import before evaluation (e.g. ["(std text json)", "(std sort)"])',
          ),
        iterations: z
          .number()
          .optional()
          .describe(
            'Number of times to run the expression (default: 1). Results are totaled when > 1.',
          ),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, imports, iterations, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);
      const n = iterations ?? 1;

      const preamble = buildPreamble(imports);
      const benchCode = buildBenchExpr(escaped, n);

      const code = preamble + '\n' + benchCode;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Benchmark timed out after 30 seconds.',
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0 && result.stderr && !result.stdout.includes(RESULT_MARKER)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Benchmark error:\n${result.stderr.trim()}`,
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
              text: `Benchmark error:\n${errorMsg}`,
            },
          ],
          isError: true,
        };
      }

      // Parse result lines
      const lines = stdout
        .split('\n')
        .filter((l) => l.startsWith(RESULT_MARKER));

      const info: Record<string, string> = {};
      for (const line of lines) {
        const payload = line.slice(RESULT_MARKER.length);
        const tabIdx = payload.indexOf('\t');
        if (tabIdx !== -1) {
          info[payload.slice(0, tabIdx)] = payload.slice(tabIdx + 1).trim();
        }
      }

      if (Object.keys(info).length === 0) {
        // Fall back to raw output which may contain Chez's time output
        const rawOutput = stdout.trim();
        if (rawOutput) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Benchmark output:\n${rawOutput}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No benchmark results collected.',
            },
          ],
          isError: true,
        };
      }

      // Format output
      const wall = parseFloat(info['wall-time'] || '0');
      const cpu = parseFloat(info['cpu-time'] || '0');
      const gc = parseFloat(info['gc-time'] || '0');
      const iters = parseInt(info['iterations'] || '1', 10);

      const sections: string[] = [`Benchmark: ${expression}`, ''];

      if (iters > 1) {
        sections.push(`Iterations: ${iters}`);
        sections.push(`Total wall time: ${formatTime(wall)}`);
        sections.push(`Avg wall time: ${formatTime(wall / iters)}`);
      } else {
        sections.push(`Wall time: ${formatTime(wall)}`);
      }

      sections.push(`CPU time: ${formatTime(cpu)}`);
      sections.push(`GC time: ${formatTime(gc)}`);

      if (info['result']) {
        sections.push('');
        sections.push(`Result: ${info['result']}`);
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}

function formatTime(seconds: number): string {
  if (seconds < 0.001) return `${(seconds * 1_000_000).toFixed(1)}us`;
  if (seconds < 1) return `${(seconds * 1000).toFixed(2)}ms`;
  return `${seconds.toFixed(3)}s`;
}

function buildBenchExpr(escaped: string, iterations: number): string {
  return `
(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let* ((expr-thunk (lambda () ${escaped}))
         (n ${iterations})
         (t0 (real-time))
         (cpu0 (cpu-time)))
    (let loop ((i 0) (last-result (void)))
      (if (< i n)
        (loop (+ i 1) (expr-thunk))
        (let* ((t1 (real-time))
               (cpu1 (cpu-time)))
          (display "${RESULT_MARKER}wall-time\\t")
          (display (/ (- t1 t0) 1000.0))
          (newline)
          (display "${RESULT_MARKER}cpu-time\\t")
          (display (/ cpu1 1000.0))
          (newline)
          (display "${RESULT_MARKER}gc-time\\t")
          (display 0)
          (newline)
          (display "${RESULT_MARKER}iterations\\t")
          (display n)
          (newline)
          (unless (equal? last-result (void))
            (display "${RESULT_MARKER}result\\t")
            (write last-result)
            (newline)))))))
`;
}
