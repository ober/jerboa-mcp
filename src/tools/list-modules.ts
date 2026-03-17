import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getJerboaHome } from '../chez.js';

export function registerListModulesTool(server: McpServer): void {
  server.registerTool(
    'jerboa_list_std_modules',
    {
      title: 'List Standard Library Modules',
      description: 'List available Jerboa standard library modules from JERBOA_HOME/lib/std/.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        prefix: z.string().optional().describe('Filter modules by prefix (e.g. "net", "text", "db")'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ prefix, jerboa_home }) => {
      const home = getJerboaHome(jerboa_home);
      const stdDir = join(home, 'lib', 'std');

      let files: string[];
      try {
        files = await readdir(stdDir);
      } catch {
        return { content: [{ type: 'text' as const, text: `Cannot read ${stdDir}` }], isError: true };
      }

      const modules: string[] = [];

      // Top-level .sls files
      for (const f of files) {
        if (f.endsWith('.sls')) {
          const modName = `(std ${basename(f, '.sls')})`;
          if (!prefix || modName.includes(prefix)) {
            modules.push(modName);
          }
        }
      }

      // Subdirectories
      for (const f of files) {
        if (!f.includes('.')) {
          try {
            const subFiles = await readdir(join(stdDir, f));
            for (const sf of subFiles) {
              if (sf.endsWith('.sls')) {
                const modName = `(std ${f} ${basename(sf, '.sls')})`;
                if (!prefix || modName.includes(prefix)) {
                  modules.push(modName);
                }
              }
            }
          } catch { /* skip unreadable dirs */ }
        }
      }

      modules.sort();

      const text = [
        `${modules.length} Jerboa standard library module(s)${prefix ? ` matching "${prefix}"` : ''}:`,
        '',
        ...modules.map((m) => `  ${m}`),
      ].join('\n');

      return { content: [{ type: 'text' as const, text: text }] };
    },
  );
}
