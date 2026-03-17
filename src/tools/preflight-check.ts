import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, findScheme, getJerboaHome } from '../chez.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export function registerPreflightCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_preflight_check',
    {
      title: 'Jerboa Preflight Check',
      description:
        'Verify that Chez Scheme and Jerboa are properly installed and configured. ' +
        'Checks: scheme binary availability, JERBOA_HOME, lib/ directory, basic eval.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
      },
    },
    async ({ jerboa_home }) => {
      const checks: Array<{ name: string; ok: boolean; message: string }> = [];

      // Check scheme binary
      try {
        const schemePath = await findScheme();
        checks.push({ name: 'scheme binary', ok: true, message: `Found: ${schemePath}` });
      } catch (e) {
        checks.push({ name: 'scheme binary', ok: false, message: 'Not found. Install Chez Scheme.' });
      }

      // Check JERBOA_HOME
      const home = getJerboaHome(jerboa_home);
      checks.push({ name: 'JERBOA_HOME', ok: true, message: home });

      // Check lib/ directory
      const libDir = join(home, 'lib');
      try {
        await access(libDir, constants.R_OK);
        checks.push({ name: 'lib/ directory', ok: true, message: libDir });
      } catch {
        checks.push({ name: 'lib/ directory', ok: false, message: `Not found: ${libDir}` });
      }

      // Check (jerboa prelude) loads
      const script = buildPreamble() + '\n(display "JERBOA-PRELUDE-OK\\n")\n';
      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 15_000 });
      const preludeOk = result.stdout.includes('JERBOA-PRELUDE-OK');
      checks.push({
        name: '(jerboa prelude)',
        ok: preludeOk,
        message: preludeOk ? 'Loads successfully' : (result.stderr.trim() || 'Failed to load'),
      });

      // Check basic eval
      if (preludeOk) {
        const evalScript = buildPreamble() + '\n(display (+ 1 2))\n';
        const evalResult = await runChez(evalScript, { jerboaHome: jerboa_home, timeout: 10_000 });
        const evalOk = evalResult.stdout.trim() === '3';
        checks.push({
          name: 'basic eval',
          ok: evalOk,
          message: evalOk ? '(+ 1 2) = 3' : `Unexpected output: ${evalResult.stdout.trim()}`,
        });
      }

      const allOk = checks.every((c) => c.ok);
      const lines = [
        allOk ? 'Preflight check PASSED' : 'Preflight check FAILED',
        '',
        ...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.message}`),
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: !allOk,
      };
    },
  );
}
