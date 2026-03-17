import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { runChez, ERROR_MARKER, normalizeImport } from '../chez.js';
import { findSymbolOccurrences } from './parse-utils.js';

const RESULT_MARKER = 'JERBOA-MCP-TCOV:';

export function registerTestCoverageTool(server: McpServer): void {
  server.registerTool(
    'jerboa_test_coverage',
    {
      title: 'Test Coverage Summary',
      description:
        'Compare a module\'s exports against its test file to identify exported symbols ' +
        'that have no corresponding test cases. Scans *-test.ss files for references ' +
        'to each exported symbol and reports which are covered and which are missing.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        module_path: z
          .string()
          .describe(
            'Module to check coverage for (e.g. "(std text json)", "(myproject handler)")',
          ),
        test_file: z
          .string()
          .optional()
          .describe(
            'Path to the test file. If omitted, auto-discovers by looking for *-test.ss next to the module.',
          ),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
        project_path: z
          .string()
          .optional()
          .describe(
            'Project directory for auto-discovering test files.',
          ),
      },
    },
    async ({ module_path, test_file, jerboa_home, project_path }) => {
      const normalizedMod = normalizeImport(module_path);

      // 1. Get module exports
      const code = `
(import (jerboa prelude))
(import ${normalizedMod})

(let ((env (the-environment)))
  (environment-for-each env
    (lambda (name val)
      (display "${RESULT_MARKER}")
      (display name)
      (newline))))
`;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [
            { type: 'text' as const, text: 'Module introspection timed out.' },
          ],
          isError: true,
        };
      }

      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1 || result.exitCode !== 0) {
        const errorMsg = errorIdx !== -1
          ? stdout.slice(errorIdx + ERROR_MARKER.length).trim()
          : (result.stderr || result.stdout).trim();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load module ${normalizedMod}:\n${errorMsg}`,
            },
          ],
          isError: true,
        };
      }

      const exportNames = stdout
        .split('\n')
        .filter((l) => l.startsWith(RESULT_MARKER))
        .map((l) => l.slice(RESULT_MARKER.length).trim())
        .filter((n) => n.length > 0);

      if (exportNames.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Module ${normalizedMod} has no exports to check.`,
            },
          ],
        };
      }

      // 2. Find test file
      let testContent = '';
      let testFilePath = test_file || '';

      if (!testFilePath) {
        // Auto-discover: try common patterns
        // "(std text json)" -> "json-test.ss"
        const inner = normalizedMod.replace(/^\(|\)$/g, '').trim();
        const parts = inner.split(/\s+/);
        const modName = parts[parts.length - 1] || 'module';
        const candidates: string[] = [];

        if (project_path) {
          candidates.push(join(project_path, 'lib', `${modName}-test.ss`));
          candidates.push(join(project_path, `${modName}-test.ss`));
          candidates.push(join(project_path, 'test', `${modName}-test.ss`));
        }
        // Also try relative to CWD
        candidates.push(`lib/${modName}-test.ss`);
        candidates.push(`${modName}-test.ss`);

        for (const cand of candidates) {
          try {
            await stat(cand);
            testFilePath = cand;
            break;
          } catch {
            // continue
          }
        }
      }

      if (testFilePath) {
        try {
          testContent = await readFile(testFilePath, 'utf-8');
        } catch {
          testFilePath = '';
        }
      }

      if (!testContent) {
        const sections: string[] = [
          `Module: ${normalizedMod}`,
          `Exports: ${exportNames.length}`,
          '',
          'No test file found.',
          '',
          `Untested exports (${exportNames.length}):`,
        ];
        for (const name of exportNames.sort()) {
          sections.push(`  - ${name}`);
        }
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
        };
      }

      // 3. Check which exports appear in the test file
      const covered: string[] = [];
      const uncovered: string[] = [];

      for (const name of exportNames) {
        const occurrences = findSymbolOccurrences(testContent, name);
        if (occurrences.length > 0) {
          covered.push(name);
        } else {
          uncovered.push(name);
        }
      }

      // 4. Format output
      const coveragePercent =
        exportNames.length > 0
          ? Math.round((covered.length / exportNames.length) * 100)
          : 100;

      const sections: string[] = [
        `Module: ${normalizedMod}`,
        `Test file: ${testFilePath}`,
        `Exports: ${exportNames.length}`,
        `Covered: ${covered.length} (${coveragePercent}%)`,
        `Uncovered: ${uncovered.length}`,
      ];

      if (uncovered.length > 0) {
        sections.push('');
        sections.push('Untested exports:');
        for (const name of uncovered.sort()) {
          sections.push(`  - ${name}`);
        }
      }

      if (covered.length > 0) {
        sections.push('');
        sections.push('Covered exports:');
        for (const name of covered.sort()) {
          sections.push(`  + ${name}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
