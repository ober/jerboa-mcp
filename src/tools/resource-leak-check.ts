import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface LeakWarning {
  file: string;
  line: number;
  resource: string;
  type: 'no-cleanup' | 'no-guardian' | 'bare-let';
  message: string;
  remediation: string;
}

const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '.jerboa', '__pycache__', 'dist']);

async function scanDirRecursive(dir: string, results: string[]): Promise<void> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    try {
      const info = await stat(fullPath);
      if (info.isDirectory()) await scanDirRecursive(fullPath, results);
      else if (entry.endsWith('.ss') || entry.endsWith('.scm')) results.push(fullPath);
    } catch { /* skip */ }
  }
}

// Resource-acquiring functions and their cleanup expectations
const RESOURCE_FUNCTIONS: Array<{
  name: string;
  cleanup: string;
  safeWrappers: string[];
}> = [
  { name: 'sqlite-open', cleanup: 'sqlite-close', safeWrappers: ['with-resource', 'with-database', 'unwind-protect', 'dynamic-wind'] },
  { name: 'safe-sqlite-open', cleanup: 'sqlite-close', safeWrappers: ['with-resource', 'with-database', 'unwind-protect', 'dynamic-wind'] },
  { name: 'tcp-connect', cleanup: 'tcp-close', safeWrappers: ['with-resource', 'unwind-protect', 'dynamic-wind'] },
  { name: 'safe-tcp-connect', cleanup: 'tcp-close', safeWrappers: ['with-resource', 'unwind-protect', 'dynamic-wind'] },
  { name: 'tcp-listen', cleanup: 'tcp-close', safeWrappers: ['with-resource', 'unwind-protect', 'dynamic-wind'] },
  { name: 'tcp-accept', cleanup: 'tcp-close', safeWrappers: ['with-resource', 'unwind-protect', 'dynamic-wind'] },
  { name: 'open-input-file', cleanup: 'close-port', safeWrappers: ['call-with-input-file', 'call-with-port', 'with-input-from-file', 'unwind-protect', 'dynamic-wind', 'with-resource'] },
  { name: 'open-output-file', cleanup: 'close-port', safeWrappers: ['call-with-output-file', 'call-with-port', 'with-output-to-file', 'unwind-protect', 'dynamic-wind', 'with-resource'] },
  { name: 'open-file-input-port', cleanup: 'close-port', safeWrappers: ['call-with-port', 'unwind-protect', 'dynamic-wind', 'with-resource'] },
  { name: 'open-file-output-port', cleanup: 'close-port', safeWrappers: ['call-with-port', 'unwind-protect', 'dynamic-wind', 'with-resource'] },
  { name: 'open-file-input/output-port', cleanup: 'close-port', safeWrappers: ['call-with-port', 'unwind-protect', 'dynamic-wind', 'with-resource'] },
  { name: 'duckdb-open', cleanup: 'duckdb-close', safeWrappers: ['with-resource', 'unwind-protect', 'dynamic-wind'] },
  { name: 'mutex-acquire', cleanup: 'mutex-release', safeWrappers: ['with-mutex', 'unwind-protect', 'dynamic-wind'] },
];

function isInCommentOrString(line: string, matchIndex: number): boolean {
  const semicolon = line.indexOf(';');
  if (semicolon >= 0 && semicolon < matchIndex) return true;
  const before = line.substring(0, matchIndex);
  const quoteCount = (before.match(/"/g) || []).length;
  return quoteCount % 2 !== 0;
}

function checkProtection(lines: string[], lineIdx: number, wrappers: string[]): boolean {
  // Look backward for protection wrappers
  const start = Math.max(0, lineIdx - 15);
  const end = Math.min(lines.length, lineIdx + 15);
  const context = lines.slice(start, end).join(' ');

  for (const wrapper of wrappers) {
    if (context.includes(wrapper)) return true;
  }

  return false;
}

export function registerResourceLeakCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_resource_leak_check',
    {
      title: 'Resource Leak Check',
      description:
        'Static analysis for resource leaks in Jerboa code. Detects resource-acquiring calls ' +
        '(sqlite-open, tcp-connect, open-input-file, duckdb-open, mutex-acquire, etc.) that are ' +
        'not protected by with-resource, unwind-protect, dynamic-wind, or appropriate call-with-* ' +
        'patterns. These unprotected resources will leak if an exception occurs. ' +
        'Reports each leak site with the specific cleanup pattern to use.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single file to check'),
        project_path: z.string().optional().describe('Project directory to check recursively'),
      },
    },
    async ({ file_path, project_path }) => {
      if (!file_path && !project_path) {
        return { content: [{ type: 'text' as const, text: 'Error: provide file_path or project_path.' }], isError: true };
      }

      let files: string[] = [];
      if (file_path) {
        files = [file_path];
      } else if (project_path) {
        await scanDirRecursive(project_path, files);
        files.sort();
      }

      const warnings: LeakWarning[] = [];

      for (const fp of files) {
        let content: string;
        try { content = await readFile(fp, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith(';')) continue;

          for (const res of RESOURCE_FUNCTIONS) {
            const idx = line.indexOf(res.name);
            if (idx === -1) continue;
            if (isInCommentOrString(line, idx)) continue;

            // Check word boundaries
            const leftOk = idx === 0 || /[\s([\]{}'`,;#]/.test(line[idx - 1]);
            const rightIdx = idx + res.name.length;
            const rightOk = rightIdx >= line.length || /[\s)[\]{}'`,;#]/.test(line[rightIdx]);
            if (!leftOk || !rightOk) continue;

            // Check if it's the head of a call
            const beforeTrimmed = line.substring(0, idx).trimEnd();
            if (!beforeTrimmed.endsWith('(') && !beforeTrimmed.endsWith('[')) continue;

            // Check protection
            if (checkProtection(lines, i, res.safeWrappers)) continue;

            // Determine if this is in a bare let binding
            const isBareLet = lines.slice(Math.max(0, i - 3), i + 1).some(l =>
              /\(\s*(let|let\*|letrec)\s/.test(l)
            );

            warnings.push({
              file: fp,
              line: i + 1,
              resource: res.name,
              type: isBareLet ? 'bare-let' : 'no-cleanup',
              message: isBareLet
                ? `${res.name} in bare let binding without cleanup. If body throws, resource leaks.`
                : `${res.name} called without exception-safe cleanup pattern.`,
              remediation: `Use (with-resource [r (${res.name} ...)] body ...) or wrap with (unwind-protect body (${res.cleanup} r))`,
            });
          }
        }
      }

      warnings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

      const sections: string[] = [];
      const label = project_path || file_path;
      sections.push(`Resource Leak Check: ${label}`);
      sections.push(`Files scanned: ${files.length}`);
      sections.push(`Resource patterns checked: ${RESOURCE_FUNCTIONS.length}`);
      sections.push('');

      if (warnings.length === 0) {
        sections.push('No resource leak risks detected.');
      } else {
        // Group by resource type
        const byResource = new Map<string, number>();
        for (const w of warnings) {
          byResource.set(w.resource, (byResource.get(w.resource) || 0) + 1);
        }

        sections.push(`Potential leaks: ${warnings.length}`);
        sections.push('');
        sections.push('Summary:');
        for (const [res, count] of [...byResource.entries()].sort((a, b) => b[1] - a[1])) {
          sections.push(`  ${res}: ${count} unprotected call(s)`);
        }
        sections.push('');

        for (const w of warnings) {
          const shortFile = project_path ? w.file.replace(project_path + '/', '') : w.file;
          sections.push(`[LEAK] ${shortFile}:${w.line} (${w.resource})`);
          sections.push(`  ${w.message}`);
          sections.push(`  Fix: ${w.remediation}`);
          sections.push('');
        }

        sections.push('Note: GC finalizers can catch some leaks at runtime, but relying on GC');
        sections.push('for cleanup is unreliable. Always use explicit cleanup patterns.');
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
      };
    },
  );
}
