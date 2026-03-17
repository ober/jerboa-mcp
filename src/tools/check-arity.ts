import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { runChez, normalizeImport } from '../chez.js';
import {
  parseDefinitions,
  scanSchemeFiles,
  extractCallSites,
  extractLocalArities,
  extractModulePaths,
  type ArityInfo,
  type CallSite,
} from './parse-utils.js';

const ARITY_MARKER = 'JERBOA-MCP-ARITY:';

interface ArityIssue {
  file: string;
  line: number;
  column: number;
  symbol: string;
  argCount: number;
  expected: string;
}

export function registerCheckArityTool(server: McpServer): void {
  server.registerTool(
    'jerboa_check_arity',
    {
      title: 'Check Arity',
      description:
        'Project-wide call-site arity checker. Statically extracts function call sites ' +
        'from Jerboa source files, resolves arities from local definitions and imported ' +
        'modules, and reports mismatches where a function is called with the wrong ' +
        'number of arguments.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        project_path: z
          .string()
          .describe('Project directory to check'),
        file_path: z
          .string()
          .optional()
          .describe('Single file to check instead of the entire project'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory for module resolution'),
      },
    },
    async ({ project_path, file_path, jerboa_home }) => {
      // Determine files to check
      let files: string[];
      if (file_path) {
        files = [file_path];
      } else {
        files = await scanSchemeFiles(project_path);
        if (files.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No .ss files found in ${project_path}.`,
              },
            ],
          };
        }
      }

      // Phase 1: Static extraction
      const allCallSites: Array<CallSite & { file: string }> = [];
      const localArities = new Map<string, ArityInfo>();
      const importedModules = new Set<string>();

      for (const f of files) {
        let content: string;
        try {
          content = await readFile(f, 'utf-8');
        } catch {
          continue;
        }

        // Extract call sites
        const sites = extractCallSites(content);
        for (const site of sites) {
          allCallSites.push({ ...site, file: f });
        }

        // Extract local definitions and their arities
        const analysis = parseDefinitions(content);
        const arities = extractLocalArities(content, analysis.definitions);
        for (const a of arities) {
          localArities.set(a.name, a);
        }

        // Collect imported module paths
        for (const imp of analysis.imports) {
          const paths = extractModulePaths(imp.raw);
          for (const p of paths) {
            importedModules.add(p);
          }
        }
      }

      if (allCallSites.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No function call sites found in ${file_path || project_path}.`,
            },
          ],
        };
      }

      // Phase 2: Runtime arity lookup for imported modules
      const importedArities = new Map<string, ArityInfo>();
      // Filter to modules that look like Jerboa (std ...) modules or local modules
      const modulesToCheck = [...importedModules].filter(
        (m) => m.startsWith('(') || m.startsWith(':'),
      );

      if (modulesToCheck.length > 0) {
        const runtimeArities = await fetchImportedArities(modulesToCheck, jerboa_home);
        for (const [name, info] of runtimeArities) {
          // Don't override local definitions
          if (!localArities.has(name)) {
            importedArities.set(name, info);
          }
        }
      }

      // Phase 3: Compare call sites against known arities
      const issues: ArityIssue[] = [];

      for (const site of allCallSites) {
        const arity =
          localArities.get(site.symbol) || importedArities.get(site.symbol);
        if (!arity) continue; // Unknown function — skip
        if (arity.isMacro) continue; // Skip macros
        if (arity.isCaseLambda && arity.caseArities) {
          // Check against known case arities
          if (!arity.caseArities.includes(site.argCount)) {
            issues.push({
              file: site.file,
              line: site.line,
              column: site.column,
              symbol: site.symbol,
              argCount: site.argCount,
              expected: `one of (${arity.caseArities.join(', ')})`,
            });
          }
          continue;
        }

        if (site.argCount < arity.minArity) {
          issues.push({
            file: site.file,
            line: site.line,
            column: site.column,
            symbol: site.symbol,
            argCount: site.argCount,
            expected: formatExpected(arity),
          });
        } else if (
          arity.maxArity !== null &&
          site.argCount > arity.maxArity
        ) {
          issues.push({
            file: site.file,
            line: site.line,
            column: site.column,
            symbol: site.symbol,
            argCount: site.argCount,
            expected: formatExpected(arity),
          });
        }
      }

      // Format output
      const target = file_path || project_path;
      if (issues.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Arity check: ${target} \u2014 no issues found (${allCallSites.length} call site(s) checked)`,
            },
          ],
        };
      }

      const sections: string[] = [
        `Arity check: ${target} \u2014 ${issues.length} issue(s) found`,
        '',
      ];

      for (const issue of issues) {
        const relFile = file_path
          ? issue.file
          : relative(project_path, issue.file);
        const args = issue.argCount === 1 ? 'arg' : 'args';
        sections.push(
          `  [WARNING] ${relFile}:${issue.line} \u2014 ${issue.symbol} called with ${issue.argCount} ${args}, expects ${issue.expected}`,
        );
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
        isError: true,
      };
    },
  );
}

function formatExpected(arity: ArityInfo): string {
  if (arity.maxArity === null) {
    return `at least ${arity.minArity}`;
  }
  if (arity.minArity === arity.maxArity) {
    return `exactly ${arity.minArity}`;
  }
  return `${arity.minArity}..${arity.maxArity}`;
}

/**
 * Fetch arity information for symbols exported by the given modules.
 * Uses a single scheme call to introspect all modules.
 */
async function fetchImportedArities(
  modules: string[],
  jerboaHome?: string,
): Promise<Map<string, ArityInfo>> {
  // Build import statements for all modules
  const importStmts = modules.map((m) => {
    const normalized = normalizeImport(m);
    return `(guard (e [else (void)]) (import ${normalized}))`;
  }).join('\n');

  const code = `
(import (jerboa prelude))
${importStmts}

(let ((env (the-environment)))
  (environment-for-each env
    (lambda (name val)
      (when (procedure? val)
        (display "${ARITY_MARKER}")
        (display name)
        (display "\\t")
        (display (procedure-arity-mask val))
        (newline)))))
`;

  const result = await runChez(code, { timeout: 60_000, jerboaHome });

  const arities = new Map<string, ArityInfo>();

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith(ARITY_MARKER)) {
      const rest = line.slice(ARITY_MARKER.length);
      const tabIdx = rest.indexOf('\t');
      if (tabIdx !== -1) {
        const name = rest.slice(0, tabIdx);
        const arityMask = parseInt(rest.slice(tabIdx + 1), 10);
        if (!isNaN(arityMask) && name) {
          // From arity mask, derive min/max conservatively
          // Use 0 as minArity (conservative — avoids false positives for optional args)
          const guessedArity = arityMask > 0
            ? Math.floor(Math.log2(arityMask & -arityMask))
            : 0;
          arities.set(name, {
            name,
            minArity: 0,
            maxArity: guessedArity,
            isMacro: false,
            isCaseLambda: false,
          });
        }
      }
    }
  }

  return arities;
}
