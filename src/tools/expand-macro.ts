import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, escapeSchemeString } from '../chez.js';

export function registerExpandMacroTool(server: McpServer): void {
  server.registerTool(
    'jerboa_expand_macro',
    {
      title: 'Expand Macro',
      description: 'Expand a Jerboa/Chez macro form to see its core expansion.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        expression: z.string().describe('The macro expression to expand (e.g. "(def (f x) x)")'),
        imports: z.array(z.string()).optional().describe('Modules to import for macro context'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ expression, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);
      const script = buildPreamble(imports) + `
(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (pretty-print (expand (read (open-string-input-port "${escaped}")))))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Expansion timed out.' }], isError: true };
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
