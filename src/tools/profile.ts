import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, ERROR_MARKER, buildPreamble } from '../chez.js';

const RESULT_MARKER = 'JERBOA-MCP-PROF:';

export function registerProfileTool(server: McpServer): void {
  server.registerTool(
    'jerboa_profile',
    {
      title: 'Profile Function Performance',
      description:
        'Instrument specific functions with call counting and timing while running an expression. ' +
        'Reports per-function call count, cumulative time, average time, and percentage of wall time. ' +
        'Also reports overall wall time, CPU time. ' +
        'Instruments top-level bindings via set!; does not work on lexical bindings.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        expression: z
          .string()
          .describe('The Jerboa Scheme expression to profile'),
        functions: z
          .array(z.string())
          .describe(
            'Function names to instrument with call counting and timing (e.g. ["sort", "json->datum"])',
          ),
        imports: z
          .array(z.string())
          .optional()
          .describe(
            'Module paths to import before evaluation (e.g. ["(std text json)"])',
          ),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, functions, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);

      const preamble = buildPreamble(imports);
      const profileCode = buildProfileExpr(escaped, functions);

      const code = preamble + '\n' + profileCode;

      const result = await runChez(code, { timeout: 120_000, jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Profile timed out after 120 seconds.',
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
              text: `Profile error:\n${result.stderr.trim()}`,
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
              text: `Profile error:\n${errorMsg}`,
            },
          ],
          isError: true,
        };
      }

      // Parse result lines
      const lines = stdout
        .split('\n')
        .filter((l) => l.startsWith(RESULT_MARKER));

      const warnings: string[] = [];
      const fnStats: Array<{
        name: string;
        calls: number;
        time: number;
      }> = [];
      const overall: Record<string, string> = {};
      let resultValue: string | undefined;

      for (const line of lines) {
        const payload = line.slice(RESULT_MARKER.length);
        const tabIdx = payload.indexOf('\t');
        if (tabIdx === -1) continue;
        const key = payload.slice(0, tabIdx);
        const val = payload.slice(tabIdx + 1).trim();

        if (key === '__warn') {
          warnings.push(val);
        } else if (key === '__result') {
          resultValue = val;
        } else if (key.startsWith('__')) {
          overall[key] = val;
        } else {
          // Function stat: "name\tcalls\ttime"
          const parts = val.split('\t');
          if (parts.length >= 2) {
            fnStats.push({
              name: key,
              calls: parseInt(parts[0], 10),
              time: parseFloat(parts[1]),
            });
          }
        }
      }

      // Sort by time descending
      fnStats.sort((a, b) => b.time - a.time);

      const wallTime = parseFloat(overall['__wall'] || '0');
      const cpuTime = parseFloat(overall['__cpu'] || '0');

      // Format output
      const sections: string[] = [`Profile: ${expression}`, ''];

      sections.push(
        `Wall time: ${formatTime(wallTime)} | CPU: ${formatTime(cpuTime)}`,
      );
      sections.push('');

      if (warnings.length > 0) {
        for (const w of warnings) {
          sections.push(`Warning: ${w}`);
        }
        sections.push('');
      }

      if (fnStats.length > 0) {
        const maxNameLen = Math.max(
          8,
          ...fnStats.map((f) => f.name.length),
        );
        sections.push(
          `${'Function'.padEnd(maxNameLen)}  ${'Calls'.padStart(12)}  ${'Time'.padStart(10)}  ${'Avg'.padStart(10)}  ${'%'.padStart(6)}`,
        );
        for (const f of fnStats) {
          const pct =
            wallTime > 0 ? ((f.time / wallTime) * 100).toFixed(1) : '0.0';
          const avg = f.calls > 0 ? f.time / f.calls : 0;
          sections.push(
            `${f.name.padEnd(maxNameLen)}  ${f.calls.toString().padStart(12)}  ${formatTime(f.time).padStart(10)}  ${formatTime(avg).padStart(10)}  ${(pct + '%').padStart(6)}`,
          );
        }
      } else if (functions.length === 0) {
        sections.push('No functions specified for profiling.');
      } else {
        sections.push('No instrumented functions were called.');
      }

      if (resultValue !== undefined) {
        sections.push('');
        sections.push(`Result: ${resultValue}`);
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

function safeName(fn: string): string {
  return fn.replace(/[^a-zA-Z0-9]/g, '_');
}

function buildProfileExpr(
  escapedExpr: string,
  functions: string[],
): string {
  const parts: string[] = [];

  parts.push(`(guard (e [else`);
  parts.push(`  (display "${ERROR_MARKER}\\n")`);
  parts.push(`  (display-condition e (current-output-port))])`);
  parts.push('  (begin');

  // Instrument each function with counting + timing
  for (const fn of functions) {
    const safeFn = escapeSchemeString(fn);
    const safe = safeName(fn);
    parts.push(`    (guard (e [else (display "${RESULT_MARKER}__warn\\t${safeFn} not bound or not a procedure\\n")])`);
    parts.push(`      (let ((v ${fn}))`);
    parts.push(`        (when (procedure? v)`);
    parts.push(`          (define __pf_${safe}_count 0)`);
    parts.push(`          (define __pf_${safe}_time 0.0)`);
    parts.push(`          (define __pf_${safe}_orig v)`);
    parts.push(`          (set! ${fn} (lambda args`);
    parts.push(`            (set! __pf_${safe}_count (+ __pf_${safe}_count 1))`);
    parts.push(`            (let* ((t0 (real-time))`);
    parts.push(`                   (r (apply __pf_${safe}_orig args))`);
    parts.push(`                   (t1 (real-time)))`);
    parts.push(`              (set! __pf_${safe}_time (+ __pf_${safe}_time (/ (- t1 t0) 1000.0)))`);
    parts.push(`              r))))))`);
  }

  // Capture overall stats and run expression
  parts.push(`    (let* ((t0 (real-time))`);
  parts.push(`           (cpu0 (cpu-time))`);
  parts.push(`           (result ${escapedExpr})`);
  parts.push(`           (t1 (real-time))`);
  parts.push(`           (cpu1 (cpu-time)))`);

  // Output overall stats
  parts.push(`      (display "${RESULT_MARKER}__wall\\t")`);
  parts.push(`      (display (/ (- t1 t0) 1000.0)) (newline)`);
  parts.push(`      (display "${RESULT_MARKER}__cpu\\t")`);
  parts.push(`      (display (/ cpu1 1000.0)) (newline)`);

  // Output per-function stats
  for (const fn of functions) {
    const safeFn = escapeSchemeString(fn);
    const safe = safeName(fn);
    parts.push(`      (guard (e [else (void)])`);
    parts.push(`        (display "${RESULT_MARKER}${safeFn}\\t")`);
    parts.push(`        (display __pf_${safe}_count) (display "\\t")`);
    parts.push(`        (display __pf_${safe}_time)`);
    parts.push(`        (newline))`);
  }

  // Output result
  parts.push(`      (unless (equal? result (void))`);
  parts.push(`        (display "${RESULT_MARKER}__result\\t")`);
  parts.push(`        (write result)`);
  parts.push(`        (newline))`);
  parts.push('    )))');

  return parts.join('\n');
}
