import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, ERROR_MARKER, RESULT_MARKER, normalizeImport } from '../chez.js';

/**
 * Helper to extract module exports via scheme.
 */
async function getModuleExports(
  modPath: string,
  jerboaHome?: string,
): Promise<{ symbols: string[]; error?: string }> {
  const normalizedMod = normalizeImport(modPath);

  const code = `
(import (jerboa prelude))
(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (import ${normalizedMod})
  (display "${RESULT_MARKER}\\n")
  (let ((env (the-environment)))
    (environment-for-each env
      (lambda (name val)
        (display name)
        (newline)))))
`;

  const result = await runChez(code, { jerboaHome });

  if (result.timedOut) {
    return { symbols: [], error: 'Timed out' };
  }

  const stdout = result.stdout;
  const errorIdx = stdout.indexOf(ERROR_MARKER);
  if (errorIdx !== -1) {
    return { symbols: [], error: stdout.slice(errorIdx + ERROR_MARKER.length).trim() };
  }

  const resultIdx = stdout.indexOf(RESULT_MARKER);
  if (resultIdx === -1) {
    return { symbols: [], error: 'No output' };
  }

  const symbols = stdout
    .slice(resultIdx + RESULT_MARKER.length)
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  return { symbols };
}

export function registerDiffModulesTool(server: McpServer): void {
  server.registerTool(
    'jerboa_diff_modules',
    {
      title: 'Diff Module Exports',
      description:
        'Compare two Jerboa modules and show added/removed/shared exports. ' +
        'Useful for comparing module versions or understanding API differences. ' +
        'Shows a clear diff of what changed between them.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        module_a: z.string().describe('First module path (e.g. "(std text json)")'),
        module_b: z.string().describe('Second module path (e.g. "(std text json2)")'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module_a, module_b, jerboa_home }) => {
      const modA = normalizeImport(module_a);
      const modB = normalizeImport(module_b);

      // Fetch exports from both modules in parallel
      const [resultA, resultB] = await Promise.all([
        getModuleExports(modA, jerboa_home),
        getModuleExports(modB, jerboa_home),
      ]);

      if (resultA.error && resultB.error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to load both modules:\n- ${modA}: ${resultA.error}\n- ${modB}: ${resultB.error}`,
          }],
          isError: true,
        };
      }

      const setA = new Set(resultA.symbols);
      const setB = new Set(resultB.symbols);

      const onlyInA = resultA.symbols.filter((s) => !setB.has(s)).sort();
      const onlyInB = resultB.symbols.filter((s) => !setA.has(s)).sort();
      const shared = resultA.symbols.filter((s) => setB.has(s)).sort();

      const sections: string[] = [];
      sections.push(`## Module Diff: ${modA} vs ${modB}\n`);

      if (resultA.error) {
        sections.push(`**Warning**: Could not load ${modA}: ${resultA.error}\n`);
      }
      if (resultB.error) {
        sections.push(`**Warning**: Could not load ${modB}: ${resultB.error}\n`);
      }

      sections.push(`| | ${modA} | ${modB} |`);
      sections.push(`|---|---|---|`);
      sections.push(`| Total exports | ${resultA.symbols.length} | ${resultB.symbols.length} |`);
      sections.push(`| Only in this module | ${onlyInA.length} | ${onlyInB.length} |`);
      sections.push(`| Shared | ${shared.length} | ${shared.length} |`);
      sections.push('');

      if (onlyInA.length > 0) {
        sections.push(`### Only in ${modA} (${onlyInA.length}):`);
        sections.push(onlyInA.map((s) => `  - ${s}`).join('\n'));
        sections.push('');
      }

      if (onlyInB.length > 0) {
        sections.push(`### Only in ${modB} (${onlyInB.length}):`);
        sections.push(onlyInB.map((s) => `  + ${s}`).join('\n'));
        sections.push('');
      }

      if (shared.length > 0) {
        sections.push(`### Shared (${shared.length}):`);
        sections.push(shared.map((s) => `    ${s}`).join('\n'));
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
