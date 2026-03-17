import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildSyntaxCheckScript, ERROR_MARKER, VALID_MARKER } from '../chez.js';
import { readFile } from 'node:fs/promises';

export function registerVerifyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_verify',
    {
      title: 'Verify Jerboa Code',
      description:
        'Combined syntax + expand check for Jerboa code or a file. ' +
        'Replaces sequential check_syntax → compile_check workflow.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a .ss or .sls file'),
        code: z.string().optional().describe('Code string to verify directly'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ file_path, code, jerboa_home }) => {
      let source = code;
      if (file_path && !source) {
        try {
          source = await readFile(file_path, 'utf-8');
        } catch {
          return { content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }], isError: true };
        }
      }

      if (!source) {
        return { content: [{ type: 'text' as const, text: 'Provide file_path or code.' }], isError: true };
      }

      const script = buildSyntaxCheckScript(source);

      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 60_000 });

      const stdout = result.stdout;
      const label = file_path ?? 'code';

      if (stdout.includes(VALID_MARKER)) {
        return { content: [{ type: 'text' as const, text: `✓ ${label}: No issues found.` }] };
      }

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `✗ ${label}:\n${errorMsg}` }], isError: true };
      }

      const errOut = result.stderr.trim();
      if (errOut) {
        return { content: [{ type: 'text' as const, text: `✗ ${label}:\n${errOut}` }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: `Unexpected output:\n${stdout.trim()}` }], isError: true };
    },
  );
}
