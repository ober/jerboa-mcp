import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Recursively find all .ss files in a directory.
 */
async function findSsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files.push(...await findSsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.ss')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return files;
}

/**
 * Extract local import module paths from file content.
 * For Jerboa projects using (std ...) style, we detect imports of project-local modules
 * by matching (import (PROJECT-NAME ...)) patterns, or relative (import ...) paths.
 * Falls back to matching all (import (...)) that are not stdlib patterns.
 */
function extractLocalImports(content: string, packagePrefix: string): string[] {
  const imports: string[] = [];
  // Match (import ...) forms
  const importPattern = /\(import\s+([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    const body = match[1];
    // Look for (PACKAGE-NAME module ...) style imports
    const modPattern = new RegExp(`\\(${packagePrefix}[^)]*\\)`, 'g');
    let modMatch: RegExpExecArray | null;
    while ((modMatch = modPattern.exec(body)) !== null) {
      imports.push(modMatch[0]);
    }
    // Also look for :package/module style (legacy compat in prelude)
    const colonPattern = new RegExp(`:${packagePrefix}/[a-zA-Z0-9_/.-]+`, 'g');
    let colonMatch: RegExpExecArray | null;
    while ((colonMatch = colonPattern.exec(body)) !== null) {
      imports.push(colonMatch[0]);
    }
  }
  return imports;
}

/**
 * Read a project config file to get the package name.
 * Tries jerboa.pkg first, then gerbil.pkg for legacy compat.
 */
async function readPackagePrefix(projectPath: string): Promise<string | null> {
  // Try jerboa.pkg
  try {
    const content = await readFile(join(projectPath, 'jerboa.pkg'), 'utf-8');
    const match = content.match(/package[:\s]+([a-zA-Z0-9_/.-]+)/);
    if (match) return match[1];
  } catch {
    // try next
  }
  // Try gerbil.pkg (legacy compat)
  try {
    const content = await readFile(join(projectPath, 'gerbil.pkg'), 'utf-8');
    const match = content.match(/package:\s*([a-zA-Z0-9_/.-]+)/);
    if (match) return match[1];
  } catch {
    // not found
  }
  return null;
}

/**
 * Convert a file path to a module identifier.
 */
function fileToModulePath(filePath: string, projectPath: string, prefix: string): string {
  let rel = relative(projectPath, filePath);
  rel = rel.replace(/\.ss$/, '');
  return `(${prefix} ${rel.replace(/\//g, ' ')})`;
}

/**
 * Find all cycles in a directed graph using DFS.
 */
function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) {
        const cycle = stack.slice(cycleStart);
        cycle.push(node);
        cycles.push(cycle);
      }
      return;
    }

    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (graph.has(neighbor)) {
        dfs(neighbor);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node);
  }

  return cycles;
}

export function registerDependencyCyclesTool(server: McpServer): void {
  server.registerTool(
    'jerboa_dependency_cycles',
    {
      title: 'Detect Dependency Cycles',
      description:
        'Detect circular module dependencies in a Jerboa project. ' +
        'Circular imports cause cryptic compilation errors. This tool builds ' +
        'a dependency graph from import statements and reports any cycles found. ' +
        'Reads jerboa.pkg (or legacy gerbil.pkg) for the package prefix.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        project_path: z.string().describe('Path to the Jerboa project directory'),
        package_prefix: z.string().optional().describe(
          'Package name prefix to use for identifying local imports. ' +
          'If omitted, reads from jerboa.pkg (or legacy gerbil.pkg).',
        ),
      },
    },
    async ({ project_path, package_prefix }) => {
      // Read package prefix
      let prefix = package_prefix ?? await readPackagePrefix(project_path);
      if (!prefix) {
        // Fall back to directory name
        const parts = project_path.split('/').filter(Boolean);
        prefix = parts[parts.length - 1] || 'project';
      }

      // Check directory exists
      try {
        const s = await stat(project_path);
        if (!s.isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Not a directory: ${project_path}` }],
            isError: true,
          };
        }
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Directory not found: ${project_path}` }],
          isError: true,
        };
      }

      const ssFiles = await findSsFiles(project_path);
      if (ssFiles.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No .ss files found in ${project_path}` }],
        };
      }

      // Build dependency graph
      const graph = new Map<string, string[]>();
      const moduleToFile = new Map<string, string>();

      for (const file of ssFiles) {
        const modPath = fileToModulePath(file, project_path, prefix);
        let content: string;
        try {
          content = await readFile(file, 'utf-8');
        } catch {
          continue;
        }
        const imports = extractLocalImports(content, prefix);
        graph.set(modPath, imports);
        moduleToFile.set(modPath, relative(project_path, file));
      }

      // Find cycles
      const cycles = findCycles(graph);

      if (cycles.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No circular dependencies detected in ${ssFiles.length} module(s) in ${project_path}.`,
          }],
        };
      }

      // Deduplicate cycles (same cycle can be found from different starting points)
      const uniqueCycles: string[][] = [];
      const seen = new Set<string>();
      for (const cycle of cycles) {
        const minIdx = cycle.indexOf(
          cycle.slice(0, -1).reduce((a, b) => (a < b ? a : b)),
        );
        const normalized = [
          ...cycle.slice(minIdx, -1),
          ...cycle.slice(0, minIdx),
          cycle[minIdx],
        ];
        const key = normalized.join(' -> ');
        if (!seen.has(key)) {
          seen.add(key);
          uniqueCycles.push(normalized);
        }
      }

      const sections: string[] = [];
      sections.push(`## Circular Dependencies: ${project_path}\n`);
      sections.push(`Found ${uniqueCycles.length} cycle(s) in ${ssFiles.length} module(s):\n`);

      for (let i = 0; i < uniqueCycles.length; i++) {
        const cycle = uniqueCycles[i];
        sections.push(`### Cycle ${i + 1}`);
        sections.push('```');
        sections.push(cycle.join(' -> '));
        sections.push('```');
        sections.push('');
      }

      sections.push(
        '\n## How to Fix\n' +
        '- Extract shared types/interfaces into a separate module that both can import\n' +
        '- Use late binding or dynamic dispatch to break the cycle\n' +
        '- Consider merging tightly coupled modules\n',
      );

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
