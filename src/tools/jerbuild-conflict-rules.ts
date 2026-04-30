import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, normalizeImport } from '../chez.js';

interface ModuleExports {
  module: string;       // user-facing label, e.g. "(jerboa core)"
  normalized: string;   // canonical (a b c) form
  exports: string[];
  error?: string;
}

const EXPORT_MARKER = 'JBM-EXPORT';
const ERROR_MARKER = 'JBM-ERR';

/**
 * Run a Chez subprocess that imports `lib` and dumps its exports. We import
 * one module per subprocess so a conflict between user-supplied modules
 * does not cause the whole batch to fail.
 */
async function getExports(
  rawModule: string,
  jerboaHome?: string,
): Promise<ModuleExports> {
  const normalized = normalizeImport(rawModule);
  const script = `
(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))
           (newline)])
  (import ${normalized})
  (for-each (lambda (s)
              (display "${EXPORT_MARKER}\\t")
              (display s)
              (newline))
            (library-exports '${normalized})))
`;

  const result = await runChez(script, { jerboaHome, timeout: 30_000 });

  if (result.timedOut) {
    return { module: rawModule, normalized, exports: [], error: 'timed out resolving module' };
  }

  const lines = result.stdout.split('\n');
  if (lines.some((l) => l.startsWith(ERROR_MARKER))) {
    const errIdx = lines.findIndex((l) => l.startsWith(ERROR_MARKER));
    const err = lines.slice(errIdx + 1).join(' ').trim();
    return { module: rawModule, normalized, exports: [], error: err || 'unknown error' };
  }

  if (result.exitCode !== 0) {
    return {
      module: rawModule,
      normalized,
      exports: [],
      error: result.stderr.trim() || 'subprocess failed',
    };
  }

  const exports: string[] = [];
  for (const line of lines) {
    if (line.startsWith(EXPORT_MARKER + '\t')) {
      exports.push(line.slice(EXPORT_MARKER.length + 1).trim());
    }
  }
  return { module: rawModule, normalized, exports };
}

/**
 * Find pairwise overlaps between modules. Order in `modules` is significant:
 * the first occurrence "owns" the symbol, later modules listing the same
 * symbol are reported as conflicting.
 */
function findConflicts(modules: ModuleExports[]): Map<string, Set<string>> {
  // module-spec → set of symbols that must be excluded from this module
  // because a LATER module also exports them.
  const exclusions = new Map<string, Set<string>>();
  for (const m of modules) exclusions.set(m.normalized, new Set());

  for (let i = 0; i < modules.length; i++) {
    const a = modules[i];
    if (a.error) continue;
    const aSet = new Set(a.exports);
    for (let j = i + 1; j < modules.length; j++) {
      const b = modules[j];
      if (b.error) continue;
      for (const sym of b.exports) {
        if (aSet.has(sym)) {
          // sym is exported by both. Earlier module (a) gets except-clause.
          exclusions.get(a.normalized)!.add(sym);
        }
      }
    }
  }

  return exclusions;
}

function renderImportBlock(
  modules: ModuleExports[],
  exclusions: Map<string, Set<string>>,
): string {
  const parts: string[] = [];
  for (const m of modules) {
    if (m.error) {
      parts.push(`  ;; ${m.normalized}  — could not resolve: ${m.error}`);
      continue;
    }
    const excl = exclusions.get(m.normalized);
    if (excl && excl.size > 0) {
      const names = Array.from(excl).sort().join(' ');
      parts.push(`  (except ${m.normalized} ${names})`);
    } else {
      parts.push(`  ${m.normalized}`);
    }
  }
  return `(import\n${parts.join('\n')})`;
}

export function registerJerbuildConflictRulesTool(server: McpServer): void {
  server.registerTool(
    'jerboa_jerbuild_conflict_rules',
    {
      title: 'Generate Import Conflict Resolution',
      description:
        'Given a list of module imports (in priority order, lowest first), resolve their export ' +
        'conflicts by computing pairwise overlaps via library-exports and emit a ready-to-paste ' +
        '(import (except A x y) B C) block. The convention is: later imports override earlier ' +
        "ones, so each earlier module's overlap with a later module appears as an (except ...) " +
        'clause. Each module is resolved in its own subprocess so a conflict in the user list ' +
        'does not abort the whole query. Use this when adding a new dependency that overlaps with ' +
        '(jerboa core) or another widely-imported module.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        imports: z
          .array(z.string())
          .min(2)
          .describe('Imports in priority order, lowest first (e.g. ["(jerboa core)", "(std sort)"])'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ imports, jerboa_home }) => {
      const resolved = await Promise.all(imports.map((m) => getExports(m, jerboa_home)));
      const exclusions = findConflicts(resolved);

      const lines: string[] = [];
      lines.push(`Resolved ${resolved.length} module(s):`);
      for (const m of resolved) {
        if (m.error) {
          lines.push(`  ✗ ${m.normalized}  — ${m.error}`);
        } else {
          lines.push(`  ✓ ${m.normalized}  (${m.exports.length} exports)`);
        }
      }
      lines.push('');

      const totalConflicts = Array.from(exclusions.values()).reduce(
        (sum, s) => sum + s.size,
        0,
      );

      if (totalConflicts === 0) {
        lines.push('No name conflicts between these modules.');
        lines.push('');
        lines.push(renderImportBlock(resolved, exclusions));
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      lines.push(`Found ${totalConflicts} conflicting name(s):`);
      for (const m of resolved) {
        const excl = exclusions.get(m.normalized);
        if (excl && excl.size > 0) {
          const sorted = Array.from(excl).sort();
          lines.push(`  ${m.normalized}  →  except ${sorted.join(', ')}`);
        }
      }
      lines.push('');
      lines.push('Recommended import block (later imports take precedence):');
      lines.push('');
      lines.push(renderImportBlock(resolved, exclusions));

      const anyError = resolved.some((m) => m.error);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: anyError,
      };
    },
  );
}
