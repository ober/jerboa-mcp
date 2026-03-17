import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString } from '../chez.js';

const ERROR_MARKER = 'JERBOA-MCP-ERROR:';

export function registerFormatTool(server: McpServer): void {
  server.registerTool(
    'jerboa_format',
    {
      title: 'Format Jerboa Code',
      description:
        "Pretty-print/format Jerboa Scheme expressions using Chez's built-in pretty-print. " +
        'Reads all expressions from the input and returns them properly indented.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        code: z
          .string()
          .describe('Jerboa Scheme code to format/pretty-print'),
      },
    },
    async ({ code }) => {
      const escaped = escapeSchemeString(code);

      // Use Chez's built-in pretty-print via a script
      const script = [
        '(import (jerboa prelude))',
        `(define in (open-string-input-port "${escaped}"))`,
        '(define out (open-output-string))',
        '(define (fmt-all first)',
        '  (let ((form (read in)))',
        '    (unless (eof-object? form)',
        '      (unless first (newline out))',
        '      (pretty-print form out)',
        '      (fmt-all #f))))',
        '(guard (e [else',
        `         (display "${ERROR_MARKER}\\n")`,
        '         (display-condition e (current-output-port))',
        '         (newline)])',
        '  (fmt-all #t)',
        '  (display (get-output-string out)))',
      ].join('\n');

      const result = await runChez(script);

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Format operation timed out.',
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0 && result.stderr && !result.stdout.includes(ERROR_MARKER)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Format error:\n${result.stderr.trim()}`,
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
              text: `Format error:\n${errorMsg}`,
            },
          ],
          isError: true,
        };
      }

      const formatted = stdout.trimEnd();
      if (!formatted) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No expressions found in input.',
            },
          ],
        };
      }

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    },
  );
}
