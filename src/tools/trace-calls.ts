import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, escapeSchemeString } from '../chez.js';

export function registerTraceCallsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_trace_calls',
    {
      title: 'Trace Call Counts',
      description:
        'Lightweight call counting — wrap specified functions to count how many times they are called ' +
        'when an expression is evaluated. Reports per-function call counts without timing overhead.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        expression: z.string().describe('The expression to evaluate while counting calls'),
        functions: z
          .array(z.string())
          .describe('Function names to count calls for (e.g. ["sort", "filter", "map"])'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Module paths to import (e.g. ["(std text json)", "(std sort)"])'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, functions, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);
      const preamble = buildPreamble(imports);

      // Build per-function counter definitions and wrappers
      const counterDefs: string[] = [];
      const wrappers: string[] = [];
      const reportLines: string[] = [];

      const CALL_MARKER = 'JERBOA-TRACE-COUNT:';

      for (const fn of functions) {
        const safeFn = escapeSchemeString(fn);
        const safe = fn.replace(/[^a-zA-Z0-9]/g, '_');
        const counterVar = `__tc_${safe}_count`;
        const origVar = `__tc_${safe}_orig`;

        counterDefs.push(`(define ${counterVar} 0)`);

        wrappers.push(
          `    (guard (e [else (display "${CALL_MARKER}${safeFn}\\tERROR: not bound or not a procedure\\n")])\n` +
          `      (when (procedure? ${fn})\n` +
          `        (set! ${origVar} ${fn})\n` +
          `        (set! ${fn} (lambda args\n` +
          `                      (set! ${counterVar} (+ ${counterVar} 1))\n` +
          `                      (apply ${origVar} args)))))`,
        );

        reportLines.push(
          `    (guard (e [else (void)])\n` +
          `      (display "${CALL_MARKER}${safeFn}\\t")\n` +
          `      (display ${counterVar})\n` +
          `      (newline))`,
        );
      }

      // We need origVar declarations at top level, before the guard block
      const origDefs: string[] = [];
      for (const fn of functions) {
        const safe = fn.replace(/[^a-zA-Z0-9]/g, '_');
        origDefs.push(`(define __tc_${safe}_orig #f)`);
      }

      const script = `${preamble}

${counterDefs.join('\n')}
${origDefs.join('\n')}

(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (begin
${wrappers.join('\n')}

    (define __tc-result ${escaped})

${reportLines.join('\n')}

    (display "RESULT:\\n  ")
    (write __tc-result)
    (newline)))
`;

      const result = await runChez(script, { timeout: 60_000, jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Trace timed out after 60 seconds.' }], isError: true };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const msg = result.stdout.slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${msg}` }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      const stdout = result.stdout;
      const lines = stdout.split('\n');

      const counts: Array<{ name: string; value: string }> = [];
      const resultLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith(CALL_MARKER)) {
          const payload = line.slice(CALL_MARKER.length);
          const tabIdx = payload.indexOf('\t');
          if (tabIdx !== -1) {
            counts.push({ name: payload.slice(0, tabIdx), value: payload.slice(tabIdx + 1).trim() });
          }
        } else if (line.startsWith('RESULT:') || resultLines.length > 0) {
          resultLines.push(line);
        }
      }

      const sections: string[] = [`Call Counts for: ${expression}`, ''];

      if (counts.length > 0) {
        sections.push('Call Counts:');
        const maxNameLen = Math.max(8, ...counts.map((c) => c.name.length));
        for (const c of counts) {
          sections.push(`  ${c.name.padEnd(maxNameLen)}  ${c.value}`);
        }
      } else if (functions.length > 0) {
        sections.push('No instrumented functions reported counts.');
      }

      if (resultLines.length > 0) {
        sections.push('');
        sections.push(resultLines.join('\n').trim());
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
