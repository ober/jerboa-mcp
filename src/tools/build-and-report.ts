import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runMake } from '../chez.js';

interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
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

    // /path/to/file.ss:42: <message>
    const fileLineColon = line.match(/^(\/[^:]+\.[a-z]+):(\d+):\s*(.+)$/);
    if (fileLineColon) {
      const msg = fileLineColon[3].trim();
      const severity: Diagnostic['severity'] = /warning/i.test(msg) ? 'warning' : 'error';
      diagnostics.push({
        file: fileLineColon[1],
        line: parseInt(fileLineColon[2], 10),
        severity,
        message: msg,
      });
      continue;
    }

    // compile: <message>
    const compileLine = line.match(/^compile:\s*(.+)$/i);
    if (compileLine) {
      diagnostics.push({
        severity: 'error',
        message: compileLine[1].trim(),
      });
      continue;
    }

    // make: *** [<target>] Error <N>
    const makeError = line.match(/^make:\s*\*+\s*\[([^\]]+)\]\s*Error\s*(\d+)/);
    if (makeError) {
      diagnostics.push({
        severity: 'error',
        message: `make target [${makeError[1]}] failed with exit code ${makeError[2]}`,
      });
      continue;
    }

    // Generic "Error: ..." lines
    const genericError = line.match(/^Error:\s*(.+)$/i);
    if (genericError) {
      diagnostics.push({
        severity: 'error',
        message: genericError[1].trim(),
      });
      continue;
    }

    // Generic "Warning: ..." lines
    const genericWarning = line.match(/^Warning:\s*(.+)$/i);
    if (genericWarning) {
      diagnostics.push({
        severity: 'warning',
        message: genericWarning[1].trim(),
      });
      continue;
    }
  }

  return diagnostics;
}

function formatDiagnostic(d: Diagnostic): string {
  const severity = d.severity.toUpperCase();
  const location = d.file
    ? `${d.file}:${d.line ?? '?'}${d.column != null ? `:${d.column}` : ''}`
    : null;
  return location ? `${severity} ${location} - ${d.message}` : `${severity} ${d.message}`;
}

export function registerBuildAndReportTool(server: McpServer): void {
  server.registerTool(
    'jerboa_build_and_report',
    {
      title: 'Build and Report',
      description:
        'Run `make build` in a project directory and parse output for structured error diagnostics. ' +
        'Returns file, line, column, severity, and message for each error found. ' +
        'Handles Chez Scheme compilation errors.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        project_path: z.string().describe('Path to project directory'),
        target: z.string().optional().describe('Make target (default: "build")'),
        timeout: z.number().optional().describe('Timeout in ms (default: 120000)'),
      },
    },
    async ({ project_path, target, timeout }) => {
      const result = await runMake(target || 'build', project_path, {
        timeout: timeout ?? 120_000,
      });

      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const failed = result.exitCode !== 0 || result.timedOut;

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Build timed out after ${(timeout ?? 120_000) / 1000}s.\n\nOutput:\n${combined.trim()}`,
            },
          ],
          isError: true,
        };
      }

      if (!failed) {
        const text = ['Build succeeded.', '', 'Output:', result.stdout.trim()]
          .filter((s, i) => i < 3 || s !== '')
          .join('\n');
        return { content: [{ type: 'text' as const, text: text.trim() }] };
      }

      const diagnostics = parseDiagnostics(combined);
      const errors = diagnostics.filter((d) => d.severity === 'error');

      const parts: string[] = [];
      parts.push(`Build FAILED: ${errors.length} error(s) found`);

      if (diagnostics.length > 0) {
        parts.push('');
        for (const d of diagnostics) {
          parts.push(formatDiagnostic(d));
        }
      }

      parts.push('');
      parts.push('Raw output:');
      parts.push(combined.trim());

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
        isError: true,
      };
    },
  );
}
