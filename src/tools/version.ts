import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, getJerboaHome } from '../chez.js';

const VER_MARKER = 'JERBOA-MCP-VER:';

export function registerVersionTool(server: McpServer): void {
  server.registerTool(
    'jerboa_version',
    {
      title: 'Jerboa/Chez Environment Info',
      description:
        'Report Chez Scheme version, Jerboa installation path, and system type. ' +
        'Useful for diagnostics.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ jerboa_home }) => {
      const script = buildPreamble() + `\n(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])\n  (display "${VER_MARKER}chez-version\\t")\n  (display (scheme-version))\n  (newline)\n  (display "${VER_MARKER}machine-type\\t")\n  (display (machine-type))\n  (newline))\n`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Version check timed out.' }], isError: true };
      }

      if (result.exitCode === 127) {
        return { content: [{ type: 'text' as const, text: 'scheme not found. Ensure Chez Scheme is installed and in PATH.' }], isError: true };
      }

      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${errorMsg}` }], isError: true };
      }

      const lines = stdout.split('\n').filter((l) => l.startsWith(VER_MARKER));
      const info: Record<string, string> = {};
      for (const line of lines) {
        const payload = line.slice(VER_MARKER.length);
        const tabIdx = payload.indexOf('\t');
        if (tabIdx !== -1) {
          info[payload.slice(0, tabIdx)] = payload.slice(tabIdx + 1).trim();
        }
      }

      const sections: string[] = ['Jerboa/Chez Environment', ''];
      if (info['chez-version']) sections.push(`Chez Scheme version: ${info['chez-version']}`);
      if (info['machine-type']) sections.push(`Machine type: ${info['machine-type']}`);
      sections.push(`Jerboa home: ${getJerboaHome(jerboa_home)}`);

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
