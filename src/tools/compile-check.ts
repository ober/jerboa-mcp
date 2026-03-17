import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildSyntaxCheckScript, ERROR_MARKER, VALID_MARKER } from '../chez.js';
import { readFile } from 'node:fs/promises';

export function registerCompileCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_compile_check',
    {
      title: 'Compile-Check Jerboa File',
      description:
        'Check a Jerboa .ss/.sls file for compile errors by expanding all top-level forms. ' +
        'Catches unbound identifiers and macro errors beyond syntax checking.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a .ss or .sls file to check'),
        code: z.string().optional().describe('Code string to check directly'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ file_path, code, jerboa_home }) => {
      let source = code;
      if (file_path && !source) {
        try {
          source = await readFile(file_path, 'utf-8');
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }], isError: true };
        }
      }

      if (!source) {
        return { content: [{ type: 'text' as const, text: 'Provide file_path or code.' }], isError: true };
      }

      const script = buildSyntaxCheckScript(source);

      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 60_000 });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Compile check timed out.' }], isError: true };
      }

      const stdout = result.stdout;

      if (stdout.includes(VALID_MARKER)) {
        const label = file_path ? file_path : 'code';
        return { content: [{ type: 'text' as const, text: `No errors found in ${label}.` }] };
      }

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${errorMsg}` }], isError: true };
      }

      const errOut = result.stderr.trim();
      if (errOut) {
        return { content: [{ type: 'text' as const, text: `Error:\n${errOut}` }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: `Unexpected output:\n${stdout.trim()}` }], isError: true };
    },
  );
}
