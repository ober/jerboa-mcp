import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';

export function registerVerifyStaticBinaryTool(server: McpServer): void {
  server.registerTool(
    'jerboa_verify_static_binary',
    {
      title: 'Verify Static Binary Launch',
      description:
        'Post-build smoke test: runs a static Chez/Jerboa binary and verifies it exits cleanly ' +
        'without Chez exceptions, segfaults, or unbound-identifier errors. ' +
        'Use after make static-qt or any static build to catch missing libraries, unresolved symbols, ' +
        'or stale WPO artifacts before the user tries the binary. ' +
        'Defaults to --version but accepts any args that should cause a clean exit.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        binary_path: z.string().describe('Path to the compiled static binary to test'),
        args: z
          .array(z.string())
          .optional()
          .describe('Arguments to pass to the binary (default: ["--version"])'),
        timeout: z
          .number()
          .optional()
          .describe('Timeout in milliseconds (default: 10000)'),
      },
    },
    async ({ binary_path, args, timeout }) => {
      const launchArgs = args && args.length > 0 ? args : ['--version'];
      const timeoutMs = timeout ?? 10_000;

      const result = await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>((resolve) => {
        execFile(
          binary_path,
          launchArgs,
          { timeout: timeoutMs, maxBuffer: 512 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              const timedOut = error.killed === true;
              const exitCode =
                typeof error.code === 'number' ? error.code : 1;
              resolve({ exitCode, stdout: stdout ?? '', stderr: stderr ?? '', timedOut });
            } else {
              resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: false });
            }
          },
        );
      });

      // Detect Chez exception patterns in output
      const combined = result.stdout + '\n' + result.stderr;
      const exceptionLines = combined
        .split('\n')
        .filter(
          (l) =>
            /^Exception/i.test(l.trim()) ||
            /Segmentation fault/i.test(l) ||
            /Abort trap/i.test(l) ||
            /unbound identifier/i.test(l) ||
            /attempt to reference unbound/i.test(l) ||
            /library not found/i.test(l) ||
            /cannot open shared object/i.test(l),
        )
        .map((l) => l.trim())
        .filter(Boolean);

      const passed = result.exitCode === 0 && exceptionLines.length === 0;

      const lines: string[] = [];
      lines.push(passed ? '✓ PASS' : '✗ FAIL');
      lines.push(`Binary: ${binary_path}`);
      lines.push(`Args:   ${launchArgs.join(' ')}`);
      lines.push(`Exit:   ${result.timedOut ? 'TIMEOUT' : result.exitCode}`);

      if (result.stdout.trim()) {
        lines.push('');
        lines.push('stdout:');
        lines.push(result.stdout.trim().slice(0, 500));
      }

      if (result.stderr.trim()) {
        lines.push('');
        lines.push('stderr:');
        lines.push(result.stderr.trim().slice(0, 500));
      }

      if (exceptionLines.length > 0) {
        lines.push('');
        lines.push('Detected exceptions:');
        for (const l of exceptionLines) {
          lines.push('  ' + l);
        }
      }

      if (!passed && result.exitCode !== 0 && exceptionLines.length === 0) {
        lines.push('');
        lines.push('Non-zero exit with no exception pattern detected — check full stderr above.');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: !passed,
      };
    },
  );
}
