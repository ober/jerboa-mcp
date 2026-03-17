import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { checkBalance } from './check-balance.js';

interface HealthIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  file?: string;
  message: string;
}

/**
 * Recursively find all .sls and .ss source files.
 */
async function findSchemeFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist'
      ) {
        files.push(...(await findSchemeFiles(fullPath)));
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.sls') || entry.name.endsWith('.ss'))
      ) {
        files.push(fullPath);
      }
    }
  } catch {
    // skip unreadable directories
  }
  return files;
}

/**
 * Extract top-level definitions from a file.
 */
function extractDefinitions(content: string): Set<string> {
  const defs = new Set<string>();
  const defPattern =
    /^\s*\((?:def|define|defmethod|defstruct|defclass|defrule|defrules|defsyntax)\s+\(?([a-zA-Z_!?*+/<>=.-][a-zA-Z0-9_!?*+/<>=.-]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = defPattern.exec(content)) !== null) {
    defs.add(match[1]);
  }
  return defs;
}

/**
 * Extract exported symbols from a file.
 */
function extractExports(content: string): string[] {
  const exports: string[] = [];
  const exportPattern = /\(export\s+([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = exportPattern.exec(content)) !== null) {
    const body = match[1];
    const symPattern = /([a-zA-Z_!?*+/<>=.-][a-zA-Z0-9_!?*+/<>=.-]*)/g;
    let symMatch: RegExpExecArray | null;
    while ((symMatch = symPattern.exec(body)) !== null) {
      const sym = symMatch[1];
      if (sym !== '#t' && sym !== 'except' && sym !== 'only' && sym !== 'rename' && sym !== 'prefix') {
        exports.push(sym);
      }
    }
  }
  return exports;
}

/**
 * Extract import module paths from a file.
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  const importPattern = /\(import\s+([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    imports.push(match[0]);
  }
  return imports;
}

/**
 * Find duplicate top-level definitions across files in a project.
 */
async function findDuplicateDefs(
  files: string[],
  projectPath: string,
): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];
  const seenDefs = new Map<string, string>();

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const defs = extractDefinitions(content);
    const relPath = relative(projectPath, file);
    for (const def of defs) {
      if (seenDefs.has(def)) {
        issues.push({
          severity: 'warning',
          category: 'duplicates',
          file: relPath,
          message: `'${def}' also defined in ${seenDefs.get(def)}`,
        });
      } else {
        seenDefs.set(def, relPath);
      }
    }
  }
  return issues;
}

/**
 * Check balance of all files and return issues.
 */
async function checkAllBalance(
  files: string[],
  projectPath: string,
): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const result = checkBalance(content);
    if (!result.ok) {
      const relPath = relative(projectPath, file);
      issues.push({
        severity: 'error',
        category: 'syntax',
        file: relPath,
        message: `Unbalanced delimiters (${result.errors.length} error(s))`,
      });
    }
  }
  return issues;
}

/**
 * Check export consistency: exported symbols defined in same file.
 */
async function checkExportConsistency(
  files: string[],
  projectPath: string,
): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const defs = extractDefinitions(content);
    const exports = extractExports(content);
    const relPath = relative(projectPath, file);
    for (const sym of exports) {
      if (!defs.has(sym)) {
        issues.push({
          severity: 'warning',
          category: 'exports',
          file: relPath,
          message: `symbol '${sym}' exported but definition not found in file`,
        });
      }
    }
  }
  return issues;
}

/**
 * Detect simple circular imports by building a dependency graph and running DFS.
 */
async function detectCircularImports(
  files: string[],
  projectPath: string,
): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  // Build file->imports map (only local imports)
  const graph = new Map<string, string[]>();
  const fileToRel = new Map<string, string>();

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const relPath = relative(projectPath, file);
    fileToRel.set(file, relPath);

    // Extract import module paths that look like local paths
    const importedMods: string[] = [];
    const importPattern = /\(import\s+\(([^)]+)\)\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(content)) !== null) {
      const parts = match[1].trim().split(/\s+/);
      // Convert to file path guess
      const guessPath = join(projectPath, ...parts) + '.sls';
      if (existsSync(guessPath)) {
        importedMods.push(guessPath);
      }
    }
    graph.set(file, importedMods);
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (dfs(dep)) {
        const relA = fileToRel.get(node) ?? node;
        const relB = fileToRel.get(dep) ?? dep;
        issues.push({
          severity: 'error',
          category: 'cycles',
          message: `Circular import: ${relA} <-> ${relB}`,
        });
        return false; // report once per cycle
      }
    }
    inStack.delete(node);
    return false;
  }

  for (const file of files) {
    dfs(file);
  }

  return issues;
}

/**
 * Try to run a Makefile target and return its output.
 */
function tryMakeTarget(directory: string, target: string): { success: boolean; output: string } {
  try {
    const result = spawnSync('make', [target, '--no-print-directory'], {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    return { success: result.status === 0, output };
  } catch {
    return { success: false, output: '' };
  }
}

/**
 * Check if a Makefile has specific targets.
 */
function getMakefileTargets(directory: string): string[] {
  const makefile = join(directory, 'Makefile');
  if (!existsSync(makefile)) return [];
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const content = readFileSync(makefile, 'utf-8');
    const targets: string[] = [];
    const targetPattern = /^([a-zA-Z_-]+)\s*:/gm;
    let match: RegExpExecArray | null;
    while ((match = targetPattern.exec(content)) !== null) {
      targets.push(match[1]);
    }
    return targets;
  } catch {
    return [];
  }
}

export function registerProjectHealthCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_project_health_check',
    {
      title: 'Project Health Check',
      description:
        'Composite project quality audit that runs multiple checks in sequence: ' +
        'syntax balance, export consistency, duplicate definitions, import cycles, ' +
        'and Makefile-based lint/check if available. Returns a unified health report ' +
        'with a health score.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        directory: z.string().describe('Project directory to audit'),
      },
    },
    async ({ directory }) => {
      // Verify directory
      try {
        const s = await stat(directory);
        if (!s.isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Not a directory: ${directory}` }],
            isError: true,
          };
        }
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Directory not found: ${directory}` }],
          isError: true,
        };
      }

      const files = await findSchemeFiles(directory);
      const lines: string[] = [];
      lines.push(`Project Health Check: ${directory}`);
      lines.push('=========================================');
      lines.push('');
      lines.push(`Files: ${files.length} Scheme source file(s)`);
      lines.push('');

      // Check for Makefile
      const makefileTargets = getMakefileTargets(directory);
      const hasMakefile = makefileTargets.length > 0;
      const hasCheckTarget = makefileTargets.includes('check');
      const hasLintTarget = makefileTargets.includes('lint');
      const hasBuildTarget = makefileTargets.includes('build');
      const hasTestTarget = makefileTargets.includes('test');

      const targetList = makefileTargets.filter((t) =>
        ['build', 'test', 'check', 'lint', 'clean'].includes(t),
      );

      if (hasMakefile) {
        lines.push(`✓ Makefile present${targetList.length > 0 ? ` with targets: ${targetList.join(', ')}` : ''}`);
      } else {
        lines.push('~ No Makefile found');
      }

      // Run make check or make lint if available
      let makeCheckResult: { success: boolean; output: string } | null = null;
      if (hasCheckTarget) {
        makeCheckResult = tryMakeTarget(directory, 'check');
      } else if (hasLintTarget) {
        makeCheckResult = tryMakeTarget(directory, 'lint');
      }

      // Collect all issues from TS-based checks
      const allIssues: HealthIssue[] = [];

      // 1. Syntax balance check
      const balanceIssues = await checkAllBalance(files, directory);
      allIssues.push(...balanceIssues);

      // 2. Export consistency
      const exportIssues = await checkExportConsistency(files, directory);
      allIssues.push(...exportIssues);

      // 3. Circular imports
      const cycleIssues = await detectCircularImports(files, directory);
      allIssues.push(...cycleIssues);

      // 4. Duplicate definitions
      const dupIssues = await findDuplicateDefs(files, directory);
      allIssues.push(...dupIssues);

      // Summary per category
      const syntaxIssues = allIssues.filter((i) => i.category === 'syntax');
      const exportConsistencyIssues = allIssues.filter((i) => i.category === 'exports');
      const cycles = allIssues.filter((i) => i.category === 'cycles');
      const duplicates = allIssues.filter((i) => i.category === 'duplicates');

      // Health score calculation: start at 100, deduct for issues
      let score = 100;
      score -= syntaxIssues.length * 15;
      score -= cycles.length * 10;
      score -= exportConsistencyIssues.length * 5;
      score -= duplicates.length * 5;
      if (makeCheckResult && !makeCheckResult.success) score -= 10;
      score = Math.max(0, score);

      // Status icons
      const icon = (issues: HealthIssue[]): string => {
        if (issues.length === 0) return '✓';
        const hasErrors = issues.some((i) => i.severity === 'error');
        return hasErrors ? '✗' : '~';
      };

      lines.push(
        `${icon(syntaxIssues)} Syntax: ${
          syntaxIssues.length === 0
            ? 'no balance errors'
            : `${syntaxIssues.length} file(s) with unbalanced delimiters`
        }`,
      );
      lines.push(
        `${icon(cycles)} Circular imports: ${
          cycles.length === 0 ? 'none detected' : `${cycles.length} cycle(s) found`
        }`,
      );
      lines.push(
        `${icon(exportConsistencyIssues)} Export consistency: ${
          exportConsistencyIssues.length === 0
            ? 'OK'
            : `${exportConsistencyIssues.length} warning(s)`
        }`,
      );
      lines.push(
        `${icon(duplicates)} Duplicate definitions: ${
          duplicates.length === 0 ? 'none found' : `${duplicates.length} warning(s)`
        }`,
      );

      if (makeCheckResult !== null) {
        lines.push(
          `${makeCheckResult.success ? '✓' : '✗'} make ${hasCheckTarget ? 'check' : 'lint'}: ${
            makeCheckResult.success ? 'passed' : 'failed'
          }`,
        );
      }

      lines.push('');
      lines.push(`Health Score: ${score}/100`);

      // Details section
      const detailLines: string[] = [];

      for (const issue of syntaxIssues) {
        detailLines.push(`- Syntax: ${issue.file} — ${issue.message}`);
      }
      for (const issue of cycles) {
        detailLines.push(`- Cycle: ${issue.message}`);
      }
      for (const issue of exportConsistencyIssues) {
        detailLines.push(`- Export warning: ${issue.file} — ${issue.message}`);
      }
      for (const issue of duplicates) {
        detailLines.push(`- Duplicate: ${issue.file} — ${issue.message}`);
      }

      if (makeCheckResult && !makeCheckResult.success && makeCheckResult.output) {
        const truncated = makeCheckResult.output.slice(0, 500);
        detailLines.push(`- make output:\n${truncated}${makeCheckResult.output.length > 500 ? '\n  (truncated)' : ''}`);
      }

      if (detailLines.length > 0) {
        lines.push('');
        lines.push('Details:');
        lines.push(...detailLines);
      }

      // Recommendations
      const recs: string[] = [];
      for (const issue of syntaxIssues) {
        recs.push(`- Fix unbalanced delimiters in ${issue.file}`);
      }
      for (const issue of cycles) {
        recs.push(`- Break circular import: ${issue.message}`);
      }
      for (const issue of exportConsistencyIssues.slice(0, 3)) {
        recs.push(`- Add missing definition or remove export in ${issue.file}: ${issue.message}`);
      }
      for (const issue of duplicates.slice(0, 3)) {
        recs.push(`- Remove duplicate definition: ${issue.file} — ${issue.message}`);
      }

      if (recs.length > 0) {
        lines.push('');
        lines.push('Recommendations:');
        lines.push(...recs);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
