import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

export function registerModuleDepsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_module_deps',
    {
      title: 'Module Dependencies',
      description: 'List imports/dependencies of a Jerboa .ss source file.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().describe('Path to a .ss source file'),
      },
    },
    async ({ file_path }) => {
      let source: string;
      try {
        source = await readFile(file_path, 'utf-8');
      } catch {
        return { content: [{ type: 'text' as const, text: `Cannot read: ${file_path}` }], isError: true };
      }

      // Extract import forms — match both single-line and multi-line imports
      const imports: string[] = [];
      const lines = source.split('\n');
      let i = 0;
      while (i < lines.length) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('(import')) {
          // Collect the full form (may span multiple lines)
          let form = '';
          let depth = 0;
          let j = i;
          while (j < lines.length) {
            const line = lines[j];
            form += (j > i ? '\n' : '') + line;
            for (const ch of line) {
              if (ch === '(' || ch === '[') depth++;
              else if (ch === ')' || ch === ']') depth--;
            }
            if (depth <= 0 && form.includes('(')) break;
            j++;
          }
          imports.push(form.trim());
          i = j + 1;
        } else {
          i++;
        }
      }

      if (imports.length === 0) {
        return { content: [{ type: 'text' as const, text: `No imports found in ${file_path}` }] };
      }

      const text = [`${file_path} imports (${imports.length}):`, '', ...imports.map(imp => `  ${imp}`)].join('\n');
      return { content: [{ type: 'text' as const, text: text }] };
    },
  );
}
