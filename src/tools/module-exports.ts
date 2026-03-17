import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, normalizeImport } from '../chez.js';

export function registerModuleExportsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_module_exports',
    {
      title: 'List Module Exports',
      description:
        'List all exported symbols from a Jerboa/Chez module. ' +
        'Example: module_path "(std sort)" or ":std/sort" returns sort, sort!, etc.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        module_path: z.string().describe('Module path e.g. "(std sort)", "(std text json)", or ":std/sort"'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ module_path, jerboa_home }) => {
      const normalized = normalizeImport(module_path);

      const script = buildPreamble() + `
(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let ([syms (environment-symbols (environment '${normalized}))])
    (for-each (lambda (s) (display s) (newline)) (list-sort symbol<? syms))))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Module introspection timed out.' }], isError: true };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const errorMsg = result.stdout.slice(result.stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error introspecting ${normalized}:\n${errorMsg}` }], isError: true };
      }

      if (result.exitCode !== 0) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      const symbols = result.stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
      if (symbols.length === 0) {
        return { content: [{ type: 'text' as const, text: `Module ${normalized} exports no symbols.` }] };
      }

      const text = [
        `Module ${normalized} exports ${symbols.length} symbol(s):`,
        '',
        ...symbols.map(s => `  ${s}`),
      ].join('\n');

      return { content: [{ type: 'text' as const, text: text }] };
    },
  );
}
