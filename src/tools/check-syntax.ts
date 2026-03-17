import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildSyntaxCheckScript, ERROR_MARKER, VALID_MARKER } from '../chez.js';

export function registerCheckSyntaxTool(server: McpServer): void {
  server.registerTool(
    'jerboa_check_syntax',
    {
      title: 'Check Jerboa Syntax',
      description:
        'Check if Jerboa Scheme code is syntactically valid without evaluating it. ' +
        'Uses the Jerboa reader (handles [...], {...}, keyword: syntax) plus Chez expand. ' +
        'Reports errors for reader/parser issues.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        code: z.string().describe('The Jerboa Scheme code to check'),
        imports: z.array(z.string()).optional().describe('Modules to import for macro context'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ code, imports, jerboa_home }) => {
      const script = buildSyntaxCheckScript(code, imports);

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Syntax check timed out.' }], isError: true };
      }

      if (result.exitCode === 127) {
        return { content: [{ type: 'text' as const, text: 'scheme not found.' }], isError: true };
      }

      const stdout = result.stdout;

      if (stdout.includes(VALID_MARKER)) {
        return { content: [{ type: 'text' as const, text: 'Syntax is valid.' }] };
      }

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Syntax error:\n${errorMsg}` }], isError: true };
      }

      const errOut = result.stderr.trim();
      if (errOut) {
        return { content: [{ type: 'text' as const, text: `Syntax error:\n${errOut}` }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: `Unexpected output:\n${stdout.trim()}` }], isError: true };
    },
  );
}
