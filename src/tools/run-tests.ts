import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findScheme, getLibdirs } from '../chez.js';

export function registerRunTestsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_run_tests',
    {
      title: 'Run Jerboa Tests',
      description:
        'Run Jerboa test files. Pass file_path for a single file or directory for all *-test.ss files. ' +
        'Tests are run with scheme --libdirs <jerboa-lib> --script <file>.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a single test file'),
        directory: z.string().optional().describe('Directory to search for *-test.ss files'),
        filter: z.string().optional().describe('Filter test names containing this string'),
        jerboa_home: z.string().optional(),
        timeout: z.number().optional().describe('Timeout per test file in ms (default: 120000)'),
      },
    },
    async ({ file_path, directory, filter, jerboa_home, timeout }) => {
      const testFiles: string[] = [];

      if (file_path) {
        testFiles.push(file_path);
      } else if (directory) {
        try {
          const collected = await collectTestFiles(directory);
          testFiles.push(...collected);
        } catch {
          return { content: [{ type: 'text' as const, text: `Cannot read directory: ${directory}` }], isError: true };
        }
      } else {
        return { content: [{ type: 'text' as const, text: 'Provide file_path or directory.' }], isError: true };
      }

      const filtered = filter
        ? testFiles.filter(f => f.includes(filter))
        : testFiles;

      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No test files found.' }] };
      }

      const scheme = await findScheme();
      const libdirs = getLibdirs(jerboa_home);
      const testTimeout = timeout ?? 120_000;

      const results: Array<{ file: string; output: string; ok: boolean }> = [];

      for (const tf of filtered) {
        const runResult = await runSchemeScript(scheme, libdirs, tf, testTimeout);
        results.push({ file: tf, output: runResult.output.trim(), ok: runResult.ok });
      }

      const passed = results.filter(r => r.ok).length;
      const lines: string[] = [`Test run: ${passed}/${results.length} passed`, ''];

      for (const r of results) {
        lines.push(`${r.ok ? 'PASS' : 'FAIL'} ${r.file}`);
        if (r.output) {
          lines.push(...r.output.split('\n').map(l => `  ${l}`));
        }
      }

      const isError = passed < results.length;
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError };
    },
  );
}

async function collectTestFiles(directory: string): Promise<string[]> {
  const results: string[] = [];
  await collectRecursive(directory, results);
  return results.sort();
}

async function collectRecursive(dir: string, results: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const fullPath = join(dir, entry);
    if (entry.endsWith('-test.ss')) {
      results.push(fullPath);
    } else {
      // Try as directory
      try {
        await collectRecursive(fullPath, results);
      } catch {
        // not a directory or inaccessible
      }
    }
  }
}

function runSchemeScript(
  scheme: string,
  libdirs: string,
  scriptPath: string,
  timeout: number,
): Promise<{ output: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(
      scheme,
      ['--libdirs', libdirs, '--script', scriptPath],
      { timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = [stdout ?? '', stderr ?? ''].filter(Boolean).join('\n');
        resolve({ output, ok: !err });
      },
    );
  });
}
