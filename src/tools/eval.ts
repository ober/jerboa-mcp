import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  runChez,
  buildEvalScript,
  RESULT_MARKER,
  ERROR_MARKER,
  STDOUT_MARKER,
} from '../chez.js';

export function registerEvalTool(server: McpServer): void {
  server.registerTool(
    'jerboa_eval',
    {
      title: 'Evaluate Jerboa Expression',
      description:
        'Evaluate a Jerboa Scheme expression and return the result. ' +
        'Captures stdout output (display, etc.) separately from the return value. ' +
        'Use the imports parameter to make module bindings available. ' +
        'Example: expression "(sort \'(3 1 2) <)" with imports ["(std sort)"].',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        expression: z.string().describe('The Jerboa Scheme expression to evaluate'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Module paths to import (e.g. ["(std text json)", "(std sort)"] or [":std/text/json"])'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
        env: z.record(z.string()).optional().describe('Extra environment variables for the subprocess'),
      },
    },
    async ({ expression, imports, jerboa_home, env: extraEnv }) => {
      const code = buildEvalScript(expression, imports);

      const result = await runChez(code, {
        jerboaHome: jerboa_home,
        env: extraEnv,
      });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Evaluation timed out after 30 seconds.' }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.includes(ERROR_MARKER)) {
        const errText = result.stderr.trim() || `Exit code ${result.exitCode}`;
        return { content: [{ type: 'text' as const, text: `Error:\n${errText}` }], isError: true };
      }

      if (result.exitCode === 127) {
        return { content: [{ type: 'text' as const, text: 'scheme not found. Ensure Chez Scheme is installed and in PATH.' }], isError: true };
      }

      const stdout = result.stdout;

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const sideOutput = stdout.slice(0, errorIdx).trim();
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        const parts: string[] = [];
        if (sideOutput) parts.push(`Output:\n${sideOutput}`);
        parts.push(`Error:\n${errorMsg}`);
        return { content: [{ type: 'text' as const, text: parts.join('\n\n') }], isError: true };
      }

      const stdoutIdx = stdout.indexOf(STDOUT_MARKER);
      const resultIdx = stdout.indexOf(RESULT_MARKER);

      let capturedOutput = '';
      if (stdoutIdx !== -1) {
        const afterMarker = stdout.slice(stdoutIdx + STDOUT_MARKER.length);
        const endIdx = afterMarker.indexOf(RESULT_MARKER);
        capturedOutput = (endIdx !== -1 ? afterMarker.slice(0, endIdx) : afterMarker).trim();
      }

      if (resultIdx !== -1) {
        const value = stdout.slice(resultIdx + RESULT_MARKER.length).trim();
        const parts: string[] = [];
        if (capturedOutput) parts.push(`Output:\n${capturedOutput}`);
        if (value) parts.push(`Result: ${value}`);
        return { content: [{ type: 'text' as const, text: parts.join('\n\n') || '(void)' }] };
      }

      if (capturedOutput) {
        return { content: [{ type: 'text' as const, text: `Output:\n${capturedOutput}` }] };
      }

      const output = stdout.trim();
      return { content: [{ type: 'text' as const, text: output || '(void)' }] };
    },
  );
}
