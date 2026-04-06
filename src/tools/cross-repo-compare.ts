/**
 * jerboa_cross_repo_compare — Compare two module/file implementations.
 *
 * Takes two file paths (or Jerboa module paths like "(std text json)"),
 * introspects each, and produces a structured comparison table showing:
 * - Exports present in one but not the other
 * - Shared exports
 * - Definition counts by kind
 * - Import dependencies
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { runChez, normalizeImport, ERROR_MARKER } from '../chez.js';
import { parseDefinitions, extractModulePaths } from './parse-utils.js';

const EXPORTS_MARKER = 'CROSS-REPO-EXPORTS:';

interface ModuleInfo {
  label: string;
  kind: 'file' | 'module';
  exports: string[];
  definitions: Array<{ name: string; kind: string; line: number }>;
  imports: string[];
  lineCount: number;
}

/** Resolve exports of a Jerboa module path via Chez subprocess. */
async function resolveModuleExports(
  modulePath: string,
  jerboaHome?: string,
): Promise<string[]> {
  const normalized = normalizeImport(modulePath);
  const code = `
(import (jerboa prelude))
(guard (e [else (display "${ERROR_MARKER}") (display (condition/message e)) (newline)])
  (let ((env (the-environment)))
    (eval '(import ${normalized}) env)
    (environment-for-each env
      (lambda (name val)
        (display "${EXPORTS_MARKER}") (display name) (newline)))))
`;
  const result = await runChez(code, { timeout: 20_000, jerboaHome });
  if (result.timedOut || result.stdout.includes(ERROR_MARKER)) return [];
  return result.stdout
    .split('\n')
    .filter((l) => l.startsWith(EXPORTS_MARKER))
    .map((l) => l.slice(EXPORTS_MARKER.length).trim())
    .filter(Boolean);
}

/** Parse a file and return structured info. */
async function analyzeFile(filePath: string): Promise<ModuleInfo | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  const analysis = parseDefinitions(content);
  const lines = content.split('\n');

  // Determine exports: static export declarations or all top-level defs
  let exports: string[];
  if (analysis.exports.length > 0) {
    exports = analysis.exports
      .flatMap((e) => {
        const inner = e.raw.replace(/^\s*\(export\s+/, '').replace(/\)\s*$/, '').trim();
        return inner.split(/\s+/).filter((s) => s && !s.startsWith(';'));
      });
  } else {
    // .ss script: all top-level definitions are the "API"
    exports = analysis.definitions.map((d) => d.name);
  }

  const imports = analysis.imports.flatMap((i) => extractModulePaths(i.raw));

  return {
    label: filePath,
    kind: 'file',
    exports,
    definitions: analysis.definitions,
    imports,
    lineCount: lines.length,
  };
}

/** Check if a string looks like a Chez/Jerboa module path. */
function isModulePath(s: string): boolean {
  return s.startsWith('(') || s.startsWith(':');
}

function setDiff<T>(a: T[], b: T[]): T[] {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

function setIntersect<T>(a: T[], b: T[]): T[] {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function registerCrossRepoCompareTool(server: McpServer): void {
  server.registerTool(
    'jerboa_cross_repo_compare',
    {
      title: 'Compare Two Module/File Implementations',
      description:
        'Compare two Jerboa file paths or module paths side-by-side. ' +
        'Shows exports unique to each, shared exports, import dependencies, ' +
        'definition counts by kind, and line count. ' +
        'Useful for evaluating two implementations of the same feature, ' +
        'checking what a new library offers over an existing one, ' +
        'or auditing API parity between modules. ' +
        'path_a and path_b can be absolute file paths or Jerboa module paths like "(std text json)".',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        path_a: z.string().describe('First file path or module path (e.g. "/path/to/foo.ss" or "(std text json)")'),
        path_b: z.string().describe('Second file path or module path'),
        label_a: z.string().optional().describe('Display label for path_a (default: basename)'),
        label_b: z.string().optional().describe('Display label for path_b (default: basename)'),
        topic: z.string().optional().describe('Optional keyword filter — only show symbols containing this string'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ path_a, path_b, label_a, label_b, topic, jerboa_home }) => {
      // Resolve both sides in parallel
      let infoA: ModuleInfo | null;
      let infoB: ModuleInfo | null;

      const resolveOne = async (path: string): Promise<ModuleInfo | null> => {
        if (isModulePath(path)) {
          const exports = await resolveModuleExports(path, jerboa_home);
          return {
            label: path,
            kind: 'module',
            exports,
            definitions: [],
            imports: [],
            lineCount: 0,
          };
        }
        return analyzeFile(path);
      };

      [infoA, infoB] = await Promise.all([
        resolveOne(path_a),
        resolveOne(path_b),
      ]);

      if (!infoA) {
        return {
          content: [{ type: 'text' as const, text: `Cannot read/resolve: ${path_a}` }],
          isError: true,
        };
      }
      if (!infoB) {
        return {
          content: [{ type: 'text' as const, text: `Cannot read/resolve: ${path_b}` }],
          isError: true,
        };
      }

      const nameA = label_a ?? path_a.split('/').pop() ?? path_a;
      const nameB = label_b ?? path_b.split('/').pop() ?? path_b;

      // Apply topic filter if requested
      const filterByTopic = (syms: string[]) =>
        topic ? syms.filter((s) => s.toLowerCase().includes(topic.toLowerCase())) : syms;

      const exportsA = filterByTopic(infoA.exports);
      const exportsB = filterByTopic(infoB.exports);

      const onlyA = setDiff(exportsA, exportsB).sort();
      const onlyB = setDiff(exportsB, exportsA).sort();
      const shared = setIntersect(exportsA, exportsB).sort();

      const lines: string[] = [];

      // Header
      lines.push(`# Cross-Implementation Comparison`);
      lines.push('');
      lines.push(`| Property | ${nameA} | ${nameB} |`);
      lines.push(`|---|---|---|`);
      lines.push(`| Type | ${infoA.kind} | ${infoB.kind} |`);
      if (infoA.lineCount > 0 || infoB.lineCount > 0) {
        lines.push(`| Lines | ${infoA.lineCount || '—'} | ${infoB.lineCount || '—'} |`);
      }
      lines.push(`| Total exports | ${infoA.exports.length} | ${infoB.exports.length} |`);
      lines.push(`| Unique exports | ${onlyA.length} | ${onlyB.length} |`);
      lines.push(`| Shared exports | ${shared.length} | ${shared.length} |`);

      // Definition breakdown (file mode only)
      if (infoA.definitions.length > 0 || infoB.definitions.length > 0) {
        const kindsA = infoA.definitions.reduce((acc, d) => {
          acc[d.kind] = (acc[d.kind] ?? 0) + 1; return acc;
        }, {} as Record<string, number>);
        const kindsB = infoB.definitions.reduce((acc, d) => {
          acc[d.kind] = (acc[d.kind] ?? 0) + 1; return acc;
        }, {} as Record<string, number>);
        const allKinds = [...new Set([...Object.keys(kindsA), ...Object.keys(kindsB)])].sort();
        for (const k of allKinds) {
          lines.push(`| ${k}s | ${kindsA[k] ?? 0} | ${kindsB[k] ?? 0} |`);
        }
      }

      // Imports
      if (infoA.imports.length > 0 || infoB.imports.length > 0) {
        lines.push(`| Imports | ${infoA.imports.length} | ${infoB.imports.length} |`);
      }

      lines.push('');

      // Unique to A
      if (onlyA.length > 0) {
        lines.push(`## Only in ${nameA} (${onlyA.length})`);
        lines.push('');
        const cols = 3;
        for (let i = 0; i < onlyA.length; i += cols) {
          lines.push('  ' + onlyA.slice(i, i + cols).map((s) => pad(s, 28)).join('  ').trimEnd());
        }
        lines.push('');
      }

      // Unique to B
      if (onlyB.length > 0) {
        lines.push(`## Only in ${nameB} (${onlyB.length})`);
        lines.push('');
        const cols = 3;
        for (let i = 0; i < onlyB.length; i += cols) {
          lines.push('  ' + onlyB.slice(i, i + cols).map((s) => pad(s, 28)).join('  ').trimEnd());
        }
        lines.push('');
      }

      // Shared
      if (shared.length > 0) {
        lines.push(`## Shared exports (${shared.length})`);
        lines.push('');
        const cols = 4;
        for (let i = 0; i < shared.length; i += cols) {
          lines.push('  ' + shared.slice(i, i + cols).map((s) => pad(s, 24)).join('  ').trimEnd());
        }
        lines.push('');
      }

      // Import lists (file mode)
      if (infoA.imports.length > 0) {
        lines.push(`## ${nameA} imports`);
        lines.push(infoA.imports.map((i) => `  ${i}`).join('\n'));
        lines.push('');
      }
      if (infoB.imports.length > 0) {
        lines.push(`## ${nameB} imports`);
        lines.push(infoB.imports.map((i) => `  ${i}`).join('\n'));
        lines.push('');
      }

      // Summary verdict
      lines.push('## Summary');
      if (onlyA.length === 0 && onlyB.length === 0) {
        lines.push(`Both implementations export the same ${shared.length} symbol(s).`);
      } else if (onlyA.length > 0 && onlyB.length === 0) {
        lines.push(`${nameA} is a superset of ${nameB} — has ${onlyA.length} additional export(s).`);
      } else if (onlyB.length > 0 && onlyA.length === 0) {
        lines.push(`${nameB} is a superset of ${nameA} — has ${onlyB.length} additional export(s).`);
      } else {
        lines.push(
          `Both implementations have unique exports: ` +
          `${nameA} has ${onlyA.length} unique, ${nameB} has ${onlyB.length} unique, ` +
          `${shared.length} shared.`,
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
