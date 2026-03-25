import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import {
  scanSchemeFiles,
  parseDefinitions,
  parseBuildTargets,
  extractModulePaths,
} from './parse-utils.js';

export function registerProjectInfoTool(server: McpServer): void {
  server.registerTool(
    'jerboa_project_info',
    {
      title: 'Project Context Overview',
      description:
        'Single-call summary of a Jerboa project: package name, build targets, ' +
        'source files, and external dependencies. Reads jerboa.pkg or legacy gerbil.pkg (if present), ' +
        'Makefile (if present), build.ss (if present), and scans source files.',
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
      const sections: string[] = [];

      // 1. Parse gerbil.pkg (legacy compat)
      let packageName = '';
      let hasPkg = false;
      try {
        const pkgContent = await readFile(
          join(project_path, 'gerbil.pkg'),
          'utf-8',
        );
        hasPkg = true;
        const pkgMatch = pkgContent.match(/\(package:\s+([^\s)]+)\)/);
        if (pkgMatch) packageName = pkgMatch[1];
        sections.push(`Package: ${packageName || '<unnamed>'}`);
        sections.push(`Location: ${project_path}`);
        sections.push('');
      } catch {
        // pkg file not present — try Makefile
      }

      // 2. Parse Makefile for project info (if no pkg file, or in addition)
      if (!hasPkg) {
        let makefileInfo = '';
        try {
          const makeContent = await readFile(
            join(project_path, 'Makefile'),
            'utf-8',
          );
          // Look for common Makefile variables like PROJECT, NAME, VERSION
          const projectMatch = makeContent.match(/^(?:PROJECT|NAME)\s*[?:]?=\s*(.+)$/m);
          if (projectMatch) {
            makefileInfo = projectMatch[1].trim();
          }
          sections.push(`Project: ${makefileInfo || '<unnamed>'} (from Makefile)`);
          sections.push(`Location: ${project_path}`);
          sections.push('');

          // Extract build targets from Makefile
          const targets: string[] = [];
          const targetPattern = /^([a-zA-Z][a-zA-Z0-9_-]*):/gm;
          let m;
          const skipTargets = new Set(['all', 'clean', 'install', 'test', 'help', 'phony', 'PHONY']);
          while ((m = targetPattern.exec(makeContent)) !== null) {
            if (!skipTargets.has(m[1]) && !m[1].startsWith('.')) {
              targets.push(m[1]);
            }
          }
          if (targets.length > 0) {
            sections.push('Makefile Targets:');
            for (const t of targets.slice(0, 20)) {
              sections.push(`  ${t}`);
            }
            if (targets.length > 20) {
              sections.push(`  ... (${targets.length - 20} more)`);
            }
            sections.push('');
          }
        } catch {
          sections.push(`Location: ${project_path}`);
          sections.push('');
        }
      }

      // 3. Parse build.ss (if present)
      try {
        const buildContent = await readFile(
          join(project_path, 'build.ss'),
          'utf-8',
        );
        const targets = parseBuildTargets(buildContent);
        if (targets.libraries.length > 0 || targets.executables.length > 0) {
          sections.push('Build Targets (build.ss):');
          for (const lib of targets.libraries) {
            sections.push(`  [lib] ${lib}`);
          }
          for (const exe of targets.executables) {
            sections.push(`  [exe] ${exe.module} -> ${exe.binary}`);
          }
          sections.push('');
        }
      } catch {
        // build.ss not present — skip silently
      }

      // 4. Scan source files
      const ssFiles = await scanSchemeFiles(project_path);
      if (ssFiles.length > 0) {
        sections.push(`Source Files (${ssFiles.length}):`);
        const byDir = new Map<string, string[]>();
        for (const f of ssFiles) {
          const rel = relative(project_path, f);
          const lastSlash = rel.lastIndexOf('/');
          const dir = lastSlash !== -1 ? rel.slice(0, lastSlash) : '.';
          if (!byDir.has(dir)) byDir.set(dir, []);
          byDir.get(dir)!.push(basename(f));
        }
        for (const [dir, files] of Array.from(byDir.entries()).sort()) {
          sections.push(`  ${dir}/`);
          for (const f of files.sort()) {
            sections.push(`    ${f}`);
          }
        }
        sections.push('');
      }

      // 5. External dependencies
      const allImports = new Set<string>();
      for (const f of ssFiles) {
        try {
          const content = await readFile(f, 'utf-8');
          const analysis = parseDefinitions(content);
          for (const imp of analysis.imports) {
            const mods = extractModulePaths(imp.raw);
            for (const m of mods) {
              if (
                m.startsWith(':') &&
                (!packageName || !m.startsWith(`:${packageName}`))
              ) {
                allImports.add(m);
              }
            }
          }
        } catch {
          /* skip unreadable files */
        }
      }

      if (allImports.size > 0) {
        const sorted = Array.from(allImports).sort();
        sections.push(`External Dependencies (${sorted.length}):`);
        for (const dep of sorted) {
          sections.push(`  ${dep}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
