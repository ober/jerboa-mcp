import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildSyntaxCheckScript, ERROR_MARKER, VALID_MARKER } from '../chez.js';

interface SnippetResult {
  id: string;
  ok: boolean;
  error?: string;
}

export function registerBatchSyntaxCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_batch_syntax_check',
    {
      title: 'Batch Syntax Check',
      description:
        'Check multiple Jerboa code snippets for syntax validity in a single call. ' +
        'Returns per-snippet pass/fail results. ' +
        'More efficient than calling jerboa_check_syntax multiple times.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        snippets: z
          .array(z.object({ id: z.string(), code: z.string() }))
          .describe('Array of {id, code} objects to check'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ snippets, jerboa_home }) => {
      const results: SnippetResult[] = [];

      // Run checks sequentially (each is fast)
      for (const snippet of snippets) {
        const script = buildSyntaxCheckScript(snippet.code);

        const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 15_000 });
        const stdout = result.stdout;

        if (stdout.includes(VALID_MARKER)) {
          results.push({ id: snippet.id, ok: true });
        } else {
          const errorIdx = stdout.indexOf(ERROR_MARKER);
          let errorMsg = '';
          if (errorIdx !== -1) {
            errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
          } else {
            errorMsg = result.stderr.trim() || 'Unknown error';
          }
          results.push({ id: snippet.id, ok: false, error: errorMsg });
        }
      }

      const passing = results.filter((r) => r.ok).length;
      const lines = [
        `Batch syntax check: ${passing}/${results.length} passed`,
        '',
        ...results.map((r) => {
          if (r.ok) return `  ✓ ${r.id}`;
          return `  ✗ ${r.id}: ${r.error?.split('\n')[0] ?? 'error'}`;
        }),
      ];

      const allOk = passing === results.length;
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: !allOk,
      };
    },
  );
}
