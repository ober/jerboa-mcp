import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

interface ConflictingProcess {
  pid: string;
  command: string;
}

export function registerBuildConflictCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_build_conflict_check',
    {
      title: 'Build Conflict Check',
      description:
        'Detect running Chez/Jerboa build processes on the same project directory. ' +
        'Checks for running scheme/make processes with matching working directories. ' +
        'Warns about potential conflicts.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        project_path: z.string().describe('Path to project directory'),
      },
    },
    async ({ project_path }) => {
      const conflicts: ConflictingProcess[] = [];
      const lockFiles: string[] = [];

      // Check for running scheme/make processes referencing project_path
      const psResult = spawnSync('ps', ['aux'], { encoding: 'utf-8', timeout: 5000 });
      if (psResult.stdout) {
        for (const line of psResult.stdout.split('\n')) {
          if (!line.includes(project_path)) continue;
          const lower = line.toLowerCase();
          if (!lower.includes('scheme') && !lower.includes('make')) continue;

          const parts = line.trim().split(/\s+/);
          const pid = parts[1];
          // Skip the ps process itself and the current process
          if (!pid || pid === String(process.pid)) continue;

          // Extract a readable command summary (columns 10 onward in ps aux)
          const command = parts.slice(10).join(' ');
          conflicts.push({ pid, command });
        }
      }

      // Check for lock files
      const lockPaths = [
        join(project_path, 'build.lock'),
        join(project_path, '.locks'),
        join(project_path, '.build.lock'),
      ];

      for (const lockPath of lockPaths) {
        try {
          await access(lockPath);
          lockFiles.push(lockPath);
        } catch {
          // not present
        }
      }

      if (conflicts.length === 0 && lockFiles.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No conflicting build processes detected.' }],
        };
      }

      const lines: string[] = [];

      if (conflicts.length > 0) {
        lines.push(`Found ${conflicts.length} potential build conflict(s):`);
        lines.push('');
        for (const { pid, command } of conflicts) {
          lines.push(`  PID ${pid}: ${command}`);
        }
        lines.push('');
        lines.push('Suggestion: kill the conflicting process(es) before building:');
        for (const { pid } of conflicts) {
          lines.push(`  kill ${pid}`);
        }
      }

      if (lockFiles.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`Found ${lockFiles.length} lock file(s):`);
        for (const lf of lockFiles) {
          lines.push(`  ${lf}`);
        }
        lines.push('');
        lines.push('If no build is running, remove the lock file(s) before retrying:');
        for (const lf of lockFiles) {
          lines.push(`  rm -f ${lf}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: conflicts.length > 0,
      };
    },
  );
}
