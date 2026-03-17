import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getJerboaHome } from '../chez.js';

/**
 * Parse a module path like "(std text json)" or "(jerboa prelude)" into a
 * relative file path under lib/: "lib/std/text/json.sls"
 */
function moduleToFilePath(modulePath: string): string {
  // Strip surrounding whitespace and optional outer parens
  let inner = modulePath.trim();
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1).trim();
  }
  // Split on whitespace to get the module name parts
  const parts = inner.split(/\s+/).filter(Boolean);
  // Join as directory path and append .sls
  return join('lib', ...parts) + '.sls';
}

async function globSlsFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    entries = raw;
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = join(base, entry.name);
    if (entry.isDirectory()) {
      const sub = await globSlsFiles(fullPath, relPath);
      results.push(...sub);
    } else if (entry.name.endsWith('.sls')) {
      results.push(relPath);
    }
  }
  return results;
}

export function registerStdlibSourceTool(server: McpServer): void {
  server.registerTool(
    'jerboa_stdlib_source',
    {
      title: 'Standard Library Source',
      description:
        'Read the source code of any Jerboa standard library module. ' +
        'Resolves module paths (e.g. "(std sort)", "(std text json)", "(jerboa prelude)") ' +
        'to .sls files in $JERBOA_HOME/lib/ and returns the source.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        module: z
          .string()
          .describe(
            'Module path e.g. "(std sort)", "(std text json)", "(jerboa prelude)", "(jerboa reader)"',
          ),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module: modulePath, jerboa_home }) => {
      const jerboaHome = getJerboaHome(jerboa_home);
      const relPath = moduleToFilePath(modulePath);
      const absPath = join(jerboaHome, relPath);

      let source: string;
      try {
        source = await readFile(absPath, 'utf-8');
      } catch {
        // File not found — list available modules as a hint
        const libDir = join(jerboaHome, 'lib');
        const available = await globSlsFiles(libDir, 'lib');
        available.sort();

        const hint = available.length > 0
          ? `Available modules in ${libDir}:\n${available.map((p) => `  ${p}`).join('\n')}`
          : `No .sls files found under ${libDir}`;

        return {
          content: [
            {
              type: 'text' as const,
              text: `Module not found: ${modulePath}\nResolved path: ${absPath}\n\n${hint}`,
            },
          ],
          isError: true,
        };
      }

      const text = `## Source: ${modulePath}\n\`\`\`scheme\n${source}\n\`\`\``;
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
