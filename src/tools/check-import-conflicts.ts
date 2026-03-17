import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join, relative, dirname, resolve as resolvePath } from 'node:path';
import { runChez, normalizeImport, ERROR_MARKER } from '../chez.js';
import {
  parseDefinitions,
  scanSchemeFiles,
  extractModulePaths,
  type FileAnalysis,
} from './parse-utils.js';

interface ConflictDiagnostic {
  file: string;
  line: number | null;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  suggestion?: string;
}

const EXPORT_MARKER = 'JERBOA-MCP-CKIMP:';

/**
 * Batch-resolve module exports via a single Chez subprocess.
 * Returns a map from module path to list of exported symbol names.
 */
async function batchResolveExports(
  modPaths: string[],
  jerboaHome?: string,
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  if (modPaths.length === 0) return results;

  // Build code that imports each module and enumerates its bindings
  const parts: string[] = [];
  parts.push('(import (jerboa prelude))');

  for (const modPath of modPaths) {
    const normalized = normalizeImport(modPath);
    const escapedPath = JSON.stringify(modPath);
    parts.push(`(guard (e [else (void)])`);
    parts.push(`  (let ((env (the-environment)))`);
    parts.push(`    (eval '(import ${normalized}) env)`);
    parts.push(`    (display "${EXPORT_MARKER}MODULE\\t") (display ${escapedPath}) (newline)`);
    parts.push(`    (environment-for-each env`);
    parts.push(`      (lambda (name val)`);
    parts.push(`        (display "${EXPORT_MARKER}SYM\\t") (display name) (newline)))))`);
  }

  const code = parts.join('\n');
  const result = await runChez(code, { timeout: 30_000, jerboaHome });
  if (result.timedOut) return results;

  const errorIdx = result.stdout.indexOf(ERROR_MARKER);
  if (errorIdx !== -1 && !result.stdout.includes(`${EXPORT_MARKER}MODULE`)) {
    return results;
  }

  let currentModule: string | null = null;
  let currentExports: string[] = [];

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(EXPORT_MARKER)) continue;

    const payload = trimmed.slice(EXPORT_MARKER.length);
    const tabIdx = payload.indexOf('\t');
    if (tabIdx === -1) continue;
    const key = payload.slice(0, tabIdx).trim();
    const val = payload.slice(tabIdx + 1).trim();

    if (key === 'MODULE') {
      if (currentModule !== null) {
        results.set(currentModule, currentExports);
      }
      currentModule = val;
      currentExports = [];
    } else if (key === 'SYM' && currentModule !== null) {
      if (val) currentExports.push(val);
    }
  }

  if (currentModule !== null) {
    results.set(currentModule, currentExports);
  }

  return results;
}

/**
 * Parse only-in filters from an import form (Jerboa syntax).
 * Returns a map from module path to the set of symbols allowed.
 */
function parseOnlyInFilters(
  importText: string,
): Map<string, Set<string>> {
  const filters = new Map<string, Set<string>>();
  // Match (only-in (mod path) sym1 sym2 ...)
  const pattern =
    /\(\s*only-in\s+(\([^)]+\))((?:\s+[a-zA-Z_!?<>=+\-*/][a-zA-Z0-9_!?<>=+\-*/.:#~]*)*)\s*\)/g;
  let match;
  while ((match = pattern.exec(importText)) !== null) {
    const modPath = match[1];
    const symsText = match[2]?.trim() || '';
    const syms = symsText ? symsText.split(/\s+/).filter(Boolean) : [];
    filters.set(modPath, new Set(syms));
  }
  return filters;
}

/**
 * Check if a module path appears inside a filter form other than only-in.
 * We can't reliably determine which symbols are imported for these, so skip.
 */
function isInOtherFilter(importText: string, modPath: string): boolean {
  const escaped = modPath.replace(/[([)]/g, '\\$&');
  const filterKeywords = [
    'except-in',
    'except-out',
    'rename-in',
    'prefix-in',
    'prefix-out',
    'rename-out',
  ];
  for (const kw of filterKeywords) {
    const re = new RegExp(`\\(\\s*${kw}\\s+${escaped}\\b`);
    if (re.test(importText)) return true;
  }
  return false;
}

/**
 * Extract exported symbol names from export forms (static analysis).
 * Returns null if (export #t) is found (means "export everything").
 */
function extractStaticExports(
  exportForms: Array<{ raw: string; line: number }>,
): string[] | null {
  const symbols: string[] = [];
  let exportAll = false;

  for (const exp of exportForms) {
    if (exp.raw.includes('#t')) {
      exportAll = true;
      continue;
    }

    const inner = exp.raw
      .replace(/^\s*\(export\s+/, '')
      .replace(/\)\s*$/, '')
      .trim();

    if (!inner) continue;

    let pos = 0;
    while (pos < inner.length) {
      while (pos < inner.length && /\s/.test(inner[pos])) pos++;
      if (pos >= inner.length) break;

      if (inner[pos] === '(') {
        let depth = 1;
        pos++;
        while (pos < inner.length && depth > 0) {
          if (inner[pos] === '(') depth++;
          else if (inner[pos] === ')') depth--;
          pos++;
        }
      } else {
        const start = pos;
        while (pos < inner.length && !/[\s()[\]{}]/.test(inner[pos])) pos++;
        const sym = inner.slice(start, pos);
        if (sym && sym !== '#t' && sym !== '#f' && !sym.startsWith(';')) {
          symbols.push(sym);
        }
      }
    }
  }

  return exportAll ? null : symbols;
}

export function registerCheckImportConflictsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_check_import_conflicts',
    {
      title: 'Import Conflict Detector',
      description:
        'Detect import conflicts before build and suggest fixes. Checks if locally defined symbols ' +
        'conflict with imported module exports (causing cryptic binding conflict errors), ' +
        'and if multiple imports export the same symbol. ' +
        'Resolves standard library exports at runtime and project-local exports statically. ' +
        'Handles only-in filtered imports. For each conflict, suggests fixes using (only-in) or (except-in). ' +
        'Provide either file_path or project_path for batch checking.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z
          .string()
          .optional()
          .describe('Single file to check for import conflicts'),
        project_path: z
          .string()
          .optional()
          .describe('Project directory to check all .ss files'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ file_path, project_path, jerboa_home }) => {
      if (!file_path && !project_path) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Either file_path or project_path is required.',
            },
          ],
          isError: true,
        };
      }

      // Determine files to check
      const filesToCheck: Array<{
        path: string;
        content: string;
        analysis: FileAnalysis;
      }> = [];

      if (file_path) {
        try {
          const content = await readFile(file_path, 'utf-8');
          filesToCheck.push({
            path: file_path,
            content,
            analysis: parseDefinitions(content),
          });
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Unknown error';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to read file: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      } else if (project_path) {
        const files = await scanSchemeFiles(project_path);
        for (const f of files) {
          try {
            const content = await readFile(f, 'utf-8');
            filesToCheck.push({
              path: relative(project_path, f),
              content,
              analysis: parseDefinitions(content),
            });
          } catch {
            // Skip unreadable
          }
        }
      }

      if (filesToCheck.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No .ss files found to check.' },
          ],
        };
      }

      // Build project-local static export map
      const projectExports = new Map<string, string[]>();
      let packagePrefix = '';
      if (project_path) {
        try {
          const pkgContent = await readFile(
            join(project_path, 'package.scm'),
            'utf-8',
          );
          const match = pkgContent.match(/\(package\s+([^\s)]+)/);
          if (match) packagePrefix = match[1];
        } catch {
          // Fall back to directory name
          packagePrefix =
            project_path.split('/').filter(Boolean).pop() || 'project';
        }

        const allFiles = await scanSchemeFiles(project_path);
        for (const f of allFiles) {
          try {
            const content = await readFile(f, 'utf-8');
            const analysis = parseDefinitions(content);
            const rel = relative(project_path, f)
              .replace(/\.ss$/, '')
              .replace(/^lib\//, '')
              .replace(/\//g, ' ');
            const modPath = `(${packagePrefix} ${rel})`;
            const exports = extractStaticExports(analysis.exports);
            const symbols =
              exports ?? analysis.definitions.map((d) => d.name);
            projectExports.set(modPath, symbols);
          } catch {
            // skip
          }
        }
      }

      // Collect all unique non-relative module paths needing runtime resolution
      const needRuntime = new Set<string>();
      for (const f of filesToCheck) {
        for (const imp of f.analysis.imports) {
          const paths = extractModulePaths(imp.raw);
          for (const p of paths) {
            if (!p.startsWith('./') && !projectExports.has(p)) {
              needRuntime.add(p);
            }
          }
        }
      }

      // Batch resolve standard library / external modules via Chez
      const runtimeExports = await batchResolveExports(
        [...needRuntime],
        jerboa_home,
      );

      // Merge runtime + project exports into a single lookup
      const allExports = new Map<string, string[]>();
      for (const [k, v] of projectExports) allExports.set(k, v);
      for (const [k, v] of runtimeExports) allExports.set(k, v);

      // Check each file for conflicts
      const diagnostics: ConflictDiagnostic[] = [];

      for (const f of filesToCheck) {
        const localDefs = new Set(
          f.analysis.definitions.map((d) => d.name),
        );
        const defLineMap = new Map(
          f.analysis.definitions.map((d) => [d.name, d.line]),
        );

        // Track all imported symbols for cross-import conflict detection
        const importedSymbols = new Map<string, string[]>();

        for (const imp of f.analysis.imports) {
          const modPaths = extractModulePaths(imp.raw);
          const onlyInFilters = parseOnlyInFilters(imp.raw);

          for (const modPath of modPaths) {
            let exports = allExports.get(modPath);
            if (!exports) {
              // Try resolving relative import for project mode
              if (modPath.startsWith('./') && project_path && packagePrefix) {
                const importingFileAbs =
                  f.path.startsWith('/')
                    ? f.path
                    : join(project_path, f.path);
                const importingDir = dirname(importingFileAbs);
                const targetAbs = resolvePath(
                  importingDir,
                  modPath.replace(/^\.\//, ''),
                );
                const targetRel = relative(project_path, targetAbs)
                  .replace(/\.ss$/, '')
                  .replace(/^lib\//, '')
                  .replace(/\//g, ' ');
                const targetMod = `(${packagePrefix} ${targetRel})`;
                exports = allExports.get(targetMod);
              }
              if (!exports) continue;
            }

            // Apply only-in filter if present
            const onlyIn = onlyInFilters.get(modPath);
            let effectiveExports: string[];
            if (onlyIn) {
              effectiveExports = exports.filter((s) => onlyIn.has(s));
            } else if (isInOtherFilter(imp.raw, modPath)) {
              // Can't determine which symbols — skip (conservative)
              continue;
            } else {
              effectiveExports = exports;
            }

            for (const sym of effectiveExports) {
              // Track for cross-import detection
              if (!importedSymbols.has(sym)) {
                importedSymbols.set(sym, []);
              }
              importedSymbols.get(sym)!.push(modPath);

              // Check local definition conflict
              if (localDefs.has(sym)) {
                diagnostics.push({
                  file: f.path,
                  line: defLineMap.get(sym) ?? null,
                  severity: 'error',
                  code: 'import-conflict',
                  message: `Local definition "${sym}" conflicts with import from ${modPath}`,
                  suggestion: `Use (except-in ${modPath} ${sym}) to exclude the conflicting symbol from the import`,
                });
              }
            }
          }
        }

        // Cross-import conflicts (multiple imports provide the same symbol)
        for (const [sym, modules] of importedSymbols) {
          const unique = [...new Set(modules)];
          if (unique.length > 1) {
            const suggestedExcepts = unique
              .map((m) => `(except-in ${m} ${sym})`)
              .slice(1);
            diagnostics.push({
              file: f.path,
              line: f.analysis.imports[0]?.line ?? null,
              severity: 'warning',
              code: 'cross-import-conflict',
              message: `Symbol "${sym}" is exported by multiple imports: ${unique.join(', ')}`,
              suggestion: `Use (except-in ...) to exclude "${sym}" from all but one module, e.g., ${suggestedExcepts.join(' or ')}`,
            });
          }
        }
      }

      // Project-wide cross-module export collision detection
      if (project_path && packagePrefix) {
        const symbolToModules = new Map<string, string[]>();
        for (const [modPath, symbols] of projectExports) {
          for (const sym of symbols) {
            if (!symbolToModules.has(sym)) {
              symbolToModules.set(sym, []);
            }
            symbolToModules.get(sym)!.push(modPath);
          }
        }

        const collisions = new Map<string, string[]>();
        for (const [sym, modules] of symbolToModules) {
          if (modules.length > 1) {
            collisions.set(sym, modules);
          }
        }

        if (collisions.size > 0) {
          for (const f of filesToCheck) {
            const importedModules = new Set<string>();
            for (const imp of f.analysis.imports) {
              const modPaths = extractModulePaths(imp.raw);
              for (const mp of modPaths) {
                importedModules.add(mp);
                if (mp.startsWith('./') && packagePrefix) {
                  const importingFileAbs = f.path.startsWith('/')
                    ? f.path
                    : join(project_path, f.path);
                  const importingDir = dirname(importingFileAbs);
                  const targetAbs = resolvePath(
                    importingDir,
                    mp.replace(/^\.\//, ''),
                  );
                  const targetRel = relative(project_path, targetAbs)
                    .replace(/\.ss$/, '')
                    .replace(/^lib\//, '')
                    .replace(/\//g, ' ');
                  importedModules.add(`(${packagePrefix} ${targetRel})`);
                }
              }
            }

            for (const [sym, modules] of collisions) {
              const importedColliders = modules.filter((m) =>
                importedModules.has(m),
              );
              if (importedColliders.length > 1) {
                const suggestedExcepts = importedColliders
                  .map((m) => `(except-in ${m} ${sym})`)
                  .slice(1);
                diagnostics.push({
                  file: f.path,
                  line: f.analysis.imports[0]?.line ?? null,
                  severity: 'error',
                  code: 'cross-module-export-collision',
                  message: `Symbol "${sym}" exported by ${importedColliders.join(' and ')} — will conflict when both are imported`,
                  suggestion: `Use (except-in ...) to exclude "${sym}" from all but one module, e.g., ${suggestedExcepts.join(' or ')}`,
                });
              }
            }
          }
        }
      }

      if (diagnostics.length === 0) {
        const target = file_path || project_path;
        return {
          content: [
            {
              type: 'text' as const,
              text: `No import conflicts found in ${target}.`,
            },
          ],
        };
      }

      // Sort: errors first, then by file, then by line
      diagnostics.sort((a, b) => {
        const sa = a.severity === 'error' ? 0 : 1;
        const sb = b.severity === 'error' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return (a.line ?? 0) - (b.line ?? 0);
      });

      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');

      const sections: string[] = [
        `Import conflict check: ${file_path || project_path}`,
        `  ${errors.length} conflict(s), ${warnings.length} warning(s)`,
        '',
      ];

      for (const d of diagnostics) {
        const loc = d.line ? `${d.file}:${d.line}` : d.file;
        sections.push(
          `  [${d.severity.toUpperCase()}] ${loc} (${d.code}): ${d.message}`,
        );
        if (d.suggestion) {
          sections.push(`    Fix: ${d.suggestion}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
        isError: errors.length > 0,
      };
    },
  );
}
