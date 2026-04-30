import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getLibdirs, normalizeImport } from '../chez.js';

interface ModuleCheck {
  module: string;
  exists: boolean;
  path?: string;
}

/**
 * Resolve a normalized module path like "(std sort)" or "(jerboa prelude)" to a
 * candidate set of .sls/.ss file paths under the lib directory.
 *
 * For "(std text json)" we try, in order:
 *   - $LIB/std/text/json.sls
 *   - $LIB/std/text/json.ss
 *   - $LIB/std/text/json/json.sls   (rare, but seen for some packages)
 */
function candidatePaths(libRoot: string, normalized: string): string[] {
  const inner = normalized.startsWith('(') && normalized.endsWith(')')
    ? normalized.slice(1, -1).trim()
    : normalized;
  const parts = inner.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];

  const dir = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  const baseDir = join(libRoot, ...dir);

  return [
    join(baseDir, last + '.sls'),
    join(baseDir, last + '.ss'),
    join(baseDir, last, last + '.sls'),
    join(baseDir, last, 'main.sls'),
  ];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function checkOne(libRoot: string, modulePath: string): Promise<ModuleCheck> {
  const normalized = normalizeImport(modulePath);
  for (const candidate of candidatePaths(libRoot, normalized)) {
    if (await fileExists(candidate)) {
      return { module: normalized, exists: true, path: candidate };
    }
  }
  return { module: normalized, exists: false };
}

export function registerModuleExistsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_module_exists',
    {
      title: 'Check Module Existence',
      description:
        'Lightweight check whether one or more stdlib module paths exist in the Jerboa lib ' +
        'directory, without importing or loading them. Accepts both (std foo) and :std/foo forms. ' +
        'Returns per-module exists boolean plus the resolved .sls path when present. ' +
        'Use before writing imports for modules you are unsure about — produces no error noise on absent modules.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        modules: z
          .array(z.string())
          .min(1)
          .describe('Module paths to check, e.g. ["(std sort)", ":std/crdt", "(jerboa prelude)"]'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Override JERBOA_HOME (defaults to env var or ~/mine/jerboa).'),
      },
    },
    async ({ modules, jerboa_home }) => {
      const libRoot = getLibdirs(jerboa_home);
      const results = await Promise.all(modules.map((m) => checkOne(libRoot, m)));

      const lines: string[] = [];
      const present = results.filter((r) => r.exists);
      const absent = results.filter((r) => !r.exists);

      lines.push(`Module existence (${present.length}/${results.length} present):`);
      lines.push('');

      for (const r of results) {
        if (r.exists) {
          const rel = r.path?.startsWith(libRoot) ? r.path.slice(libRoot.length + 1) : r.path;
          lines.push(`  ${r.module} → ${rel}`);
        } else {
          lines.push(`  ${r.module} → (not found)`);
        }
      }

      if (absent.length > 0) {
        lines.push('');
        lines.push(`Search root: ${libRoot}`);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
