import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  scanSchemeFiles,
  parseDefinitions,
  extractModulePaths,
} from './parse-utils.js';

export function registerProjectDepGraphTool(server: McpServer): void {
  server.registerTool(
    'jerboa_project_dep_graph',
    {
      title: 'Project Dependency Graph',
      description:
        'Visualize project module dependency graph as an ASCII tree. ' +
        'Shows which project modules import from which other project modules. ' +
        'External dependencies are listed separately. ' +
        'Pure static analysis — no subprocess, fast.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        project_path: z
          .string()
          .describe(
            'Directory containing the Jerboa project',
          ),
      },
    },
    async ({ project_path }) => {
      // 1. Read package name from package.scm or use directory name
      let packageName = '';
      try {
        const pkgContent = await readFile(
          join(project_path, 'package.scm'),
          'utf-8',
        );
        const pkgMatch = pkgContent.match(/\(package\s+([^\s)]+)/);
        if (pkgMatch) packageName = pkgMatch[1];
      } catch {
        // No package.scm — fall back to directory name
      }

      if (!packageName) {
        packageName =
          project_path.split('/').filter(Boolean).pop() || 'project';
      }

      // 2. Scan .ss files
      const ssFiles = await scanSchemeFiles(project_path);
      if (ssFiles.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No .ss files found in ${project_path}.`,
            },
          ],
        };
      }

      // 3. Build adjacency: module -> { internalDeps, externalDeps }
      // Module IDs use Jerboa parenthesized form: (packageName module-name)
      const moduleMap = new Map<
        string,
        { internalDeps: string[]; externalDeps: string[] }
      >();
      const allModuleIds = new Set<string>();

      // First pass: determine all module IDs
      for (const file of ssFiles) {
        const rel = relative(project_path, file)
          .replace(/\.ss$/, '')
          .replace(/^lib\//, '')
          .replace(/\//g, ' ');
        const modId = `(${packageName} ${rel})`;
        allModuleIds.add(modId);
      }

      // Second pass: parse imports
      for (const file of ssFiles) {
        const rel = relative(project_path, file)
          .replace(/\.ss$/, '')
          .replace(/^lib\//, '')
          .replace(/\//g, ' ');
        const modId = `(${packageName} ${rel})`;

        let content: string;
        try {
          content = await readFile(file, 'utf-8');
        } catch {
          continue;
        }

        const analysis = parseDefinitions(content);
        const internalDeps: string[] = [];
        const externalDeps: string[] = [];

        for (const imp of analysis.imports) {
          const mods = extractModulePaths(imp.raw);
          for (const m of mods) {
            // Check if this is a project-internal module
            // Internal modules look like (packageName ...) or (packageName submod)
            if (
              allModuleIds.has(m) ||
              (packageName && m.startsWith(`(${packageName} `) && m.endsWith(')'))
            ) {
              if (m !== modId) {
                internalDeps.push(m);
              }
            } else {
              externalDeps.push(m);
            }
          }
        }

        moduleMap.set(modId, {
          internalDeps: [...new Set(internalDeps)],
          externalDeps: [...new Set(externalDeps)],
        });
      }

      // 4. Find root modules (not depended on by others)
      const depended = new Set<string>();
      for (const [, info] of moduleMap) {
        for (const dep of info.internalDeps) {
          depended.add(dep);
        }
      }

      const roots = [...moduleMap.keys()]
        .filter((m) => !depended.has(m))
        .sort();

      // If no clear roots (circular), use all modules
      const startNodes = roots.length > 0 ? roots : [...moduleMap.keys()].sort();

      // 5. Build ASCII tree
      const sections: string[] = [];
      sections.push(`Project: ${packageName}`);
      sections.push(`Modules: ${moduleMap.size}`);
      sections.push('');
      sections.push('Dependency tree:');

      const visited = new Set<string>();

      function shortName(modId: string): string {
        // Strip outer parens and package prefix: (packageName foo) => foo
        const inner = modId.replace(/^\(|\)$/g, '');
        const prefix = `${packageName} `;
        return inner.startsWith(prefix) ? inner.slice(prefix.length) : modId;
      }

      function renderTree(
        modId: string,
        prefix: string,
        isLast: boolean,
      ): void {
        const connector = isLast ? '`-- ' : '|-- ';
        const name = shortName(modId);

        if (visited.has(modId)) {
          sections.push(`${prefix}${connector}${name} (circular)`);
          return;
        }

        sections.push(`${prefix}${connector}${name}`);
        visited.add(modId);

        const info = moduleMap.get(modId);
        if (info) {
          const childPrefix = prefix + (isLast ? '    ' : '|   ');
          const deps = info.internalDeps
            .filter((d) => moduleMap.has(d))
            .sort();

          for (let i = 0; i < deps.length; i++) {
            renderTree(deps[i], childPrefix, i === deps.length - 1);
          }
        }

        visited.delete(modId);
      }

      for (let i = 0; i < startNodes.length; i++) {
        renderTree(startNodes[i], '', i === startNodes.length - 1);
      }

      // 6. External dependencies summary
      const allExternal = new Set<string>();
      for (const [, info] of moduleMap) {
        for (const ext of info.externalDeps) {
          allExternal.add(ext);
        }
      }

      if (allExternal.size > 0) {
        sections.push('');
        sections.push('External dependencies:');
        const sorted = [...allExternal].sort();
        for (const ext of sorted) {
          sections.push(`  ${ext}`);
        }
      }

      return {
        content: [
          { type: 'text' as const, text: sections.join('\n') },
        ],
      };
    },
  );
}
