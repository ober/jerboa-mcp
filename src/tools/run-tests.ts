import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findScheme, getLibdirs } from '../chez.js';
import { injectHallucinationHints } from './shared-hallucinations.js';

interface TestDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  test?: string;
  message: string;
}

function parseTestDiagnostics(output: string, filePath: string): TestDiagnostic[] {
  const diagnostics: TestDiagnostic[] = [];
  const lines = output.split('\n');

  let currentSuite: string | null = null;
  let currentTest: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    // Chez: Exception in <filename>:<line>: <message>
    const exceptionIn = line.match(/^Exception in ([^:]+):(\d+):\s*(.+)$/);
    if (exceptionIn) {
      diagnostics.push({
        file: exceptionIn[1].trim(),
        line: parseInt(exceptionIn[2], 10),
        severity: 'error',
        message: exceptionIn[3].trim(),
      });
      continue;
    }

    // Chez: Exception: <message>
    const exceptionSimple = line.match(/^Exception:\s*(.+)$/);
    if (exceptionSimple) {
      diagnostics.push({
        file: filePath,
        severity: 'error',
        message: exceptionSimple[1].trim(),
      });
      continue;
    }

    // Syntax error at <filename>:<line>:<col>: <message>
    const syntaxError = line.match(/^Syntax error at ([^:]+):(\d+):(\d+):\s*(.+)$/i);
    if (syntaxError) {
      diagnostics.push({
        file: syntaxError[1].trim(),
        line: parseInt(syntaxError[2], 10),
        column: parseInt(syntaxError[3], 10),
        severity: 'error',
        message: syntaxError[4].trim(),
      });
      continue;
    }

    // compile: <message>
    const compileLine = line.match(/^compile:\s*(.+)$/i);
    if (compileLine) {
      diagnostics.push({
        file: filePath,
        severity: 'error',
        message: compileLine[1].trim(),
      });
      continue;
    }

    // Top-level suite (no leading spaces)
    if (!line.startsWith(' ')) {
      currentSuite = line.trim();
      currentTest = null;
      continue;
    }

    // Nested test (one space)
    if (line.startsWith(' ') && !line.startsWith('  ')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('...')) {
        // End of test marker
      } else {
        currentTest = trimmed;
      }
      continue;
    }

    // Failure detail (two+ spaces)
    if (line.startsWith('  ')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('FAIL') || trimmed.startsWith('ERROR')) {
        let msg = trimmed;
        // collect any indented lines that follow
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('    ')) {
          msg += '\n' + lines[j].trim();
          j++;
        }

        let testName = currentTest || 'unknown test';
        if (currentSuite && currentSuite !== testName) {
          testName = `${currentSuite} > ${testName}`;
        }

        diagnostics.push({
          file: filePath,
          severity: 'error',
          test: testName,
          message: msg,
        });
      }
    }
  }

  return diagnostics;
}

function formatTestDiagnostic(d: TestDiagnostic): string {
  const severity = d.severity.toUpperCase();
  const location = d.file
    ? `${d.file}${d.line ? `:${d.line}` : ''}${d.column != null ? `:${d.column}` : ''}`
    : 'unknown';
  const testCtx = d.test ? ` [${d.test}]` : '';
  return `${severity} ${location}${testCtx} - ${d.message}`;
}

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
        timeout: z.coerce.number().optional().describe('Timeout per test file in ms (default: 120000)'),
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
      const isError = passed < results.length;

      if (!isError) {
        const text = [`Test run: ${passed}/${results.length} passed`, ''];
        for (const r of results) {
          text.push(`PASS ${r.file}`);
        }
        return { content: [{ type: 'text' as const, text: text.join('\n') }] };
      }

      const allDiagnostics: TestDiagnostic[] = [];
      for (const r of results) {
        if (!r.ok) {
           const diags = parseTestDiagnostics(r.output, r.file);
           allDiagnostics.push(...diags);
        }
      }

      const parts: string[] = [];
      parts.push(`Test FAILED: ${passed}/${results.length} passed`);
      
      const errors = allDiagnostics.filter(d => d.severity === 'error');
      parts.push(`Found ${errors.length} error(s)`);

      if (allDiagnostics.length > 0) {
        parts.push('');
        for (const d of allDiagnostics) {
          parts.push(injectHallucinationHints(formatTestDiagnostic(d)));
        }
      }

      parts.push('');
      parts.push('Raw setup/output from failing tests:');
      for (const r of results.filter(r => !r.ok)) {
        parts.push(`--- ${r.file} ---`);
        parts.push(r.output);
        parts.push('');
      }

      return { content: [{ type: 'text' as const, text: parts.join('\n') }], isError: true };
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
