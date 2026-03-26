import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface SafetyIssue {
  file: string;
  line: number;
  type: 'unsafe-import' | 'unsafe-call' | 'missing-safe-wrapper';
  symbol: string;
  message: string;
  safeAlternative: string;
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

// Map of unsafe functions to their safe equivalents
const SAFE_ALTERNATIVES: Array<{
  unsafe: string;
  safe: string;
  module: string;
  description: string;
}> = [
  { unsafe: 'sqlite-open', safe: 'safe-sqlite-open', module: '(std safe)', description: 'Type-validated sqlite open with resource tracking' },
  { unsafe: 'sqlite-exec', safe: 'safe-sqlite-exec', module: '(std safe)', description: 'Parameterized query protection' },
  { unsafe: 'tcp-connect', safe: 'safe-tcp-connect', module: '(std safe)', description: 'Port range validation and type checking' },
  { unsafe: 'tcp-listen', safe: 'safe-tcp-listen', module: '(std safe)', description: 'Port validation and address checking' },
  { unsafe: 'open-input-file', safe: 'call-with-input-file', module: '(chezscheme)', description: 'Automatic port cleanup' },
  { unsafe: 'open-output-file', safe: 'call-with-output-file', module: '(chezscheme)', description: 'Automatic port cleanup' },
  { unsafe: 'foreign-procedure', safe: 'ffi-scaffold', module: 'jerboa_ffi_scaffold', description: 'Type-safe FFI bindings with null checks' },
  { unsafe: 'system', safe: 'run-process', module: '(std misc process)', description: 'Structured subprocess with argument list (no shell injection)' },
  { unsafe: 'fork-thread', safe: 'spawn', module: '(std misc thread)', description: 'Named threads with error propagation' },
  { unsafe: 'make-mutex', safe: 'atomically', module: '(std stm)', description: 'Lock-free transactional memory' },
];

function isInCommentOrString(line: string, matchIndex: number): boolean {
  const semicolon = line.indexOf(';');
  if (semicolon >= 0 && semicolon < matchIndex) return true;
  const before = line.substring(0, matchIndex);
  const quoteCount = (before.match(/"/g) || []).length;
  return quoteCount % 2 !== 0;
}

export function registerSafePreludeCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_safe_prelude_check',
    {
      title: 'Safe Prelude Check',
      description:
        'Checks whether a project uses safe APIs by default. Scans for uses of unsafe/raw ' +
        'functions (sqlite-open, tcp-connect, open-input-file, foreign-procedure, system, etc.) ' +
        'and reports where safe alternatives exist. Helps enforce the "safe by default" principle ' +
        'where (jerboa prelude) should provide safe wrappers under the original names.',
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

      const issues: SafetyIssue[] = [];

      for (const fp of files) {
        let content: string;
        try { content = await readFile(fp, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');

        // Check if file imports (std safe)
        const hasSafeImport = content.includes('(std safe)');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith(';')) continue;

          for (const alt of SAFE_ALTERNATIVES) {
            const idx = line.indexOf(alt.unsafe);
            if (idx === -1) continue;
            if (isInCommentOrString(line, idx)) continue;

            // Check word boundaries
            const leftOk = idx === 0 || /[\s([\]{}'`,;#]/.test(line[idx - 1]);
            const rightIdx = idx + alt.unsafe.length;
            const rightOk = rightIdx >= line.length || /[\s)[\]{}'`,;#]/.test(line[rightIdx]);
            if (!leftOk || !rightOk) continue;

            // Skip if this is inside a safe- prefixed call
            if (line.substring(Math.max(0, idx - 10), idx).includes('safe-')) continue;

            // Skip if this is a definition of the safe wrapper itself
            if (trimmed.startsWith('(def ') && trimmed.includes(`safe-${alt.unsafe}`)) continue;

            issues.push({
              file: fp,
              line: i + 1,
              type: hasSafeImport ? 'unsafe-call' : 'missing-safe-wrapper',
              symbol: alt.unsafe,
              message: hasSafeImport
                ? `Using ${alt.unsafe} directly despite (std safe) being available`
                : `Using ${alt.unsafe} without importing (std safe)`,
              safeAlternative: `${alt.safe} from ${alt.module}: ${alt.description}`,
            });
          }
        }
      }

      issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

      const sections: string[] = [];
      const label = project_path || file_path;
      sections.push(`Safe Prelude Check: ${label}`);
      sections.push(`Files scanned: ${files.length}`);
      sections.push('');

      if (issues.length === 0) {
        sections.push('No unsafe API usage detected. Project follows safe-by-default pattern.');
      } else {
        // Group by symbol
        const bySym = new Map<string, number>();
        for (const issue of issues) {
          bySym.set(issue.symbol, (bySym.get(issue.symbol) || 0) + 1);
        }

        sections.push(`Findings: ${issues.length} unsafe API calls`);
        sections.push('');
        sections.push('Summary by function:');
        for (const [sym, count] of [...bySym.entries()].sort((a, b) => b[1] - a[1])) {
          const alt = SAFE_ALTERNATIVES.find(a => a.unsafe === sym);
          sections.push(`  ${sym}: ${count} call(s) → use ${alt?.safe ?? '?'}`);
        }
        sections.push('');

        for (const issue of issues) {
          const shortFile = project_path ? issue.file.replace(project_path + '/', '') : issue.file;
          sections.push(`${shortFile}:${issue.line}: ${issue.symbol}`);
          sections.push(`  -> ${issue.safeAlternative}`);
        }

        sections.push('');
        sections.push('Recommendation: Add (import (std safe)) and use safe-* wrappers,');
        sections.push('or configure (jerboa prelude) to re-export safe versions as defaults.');
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
      };
    },
  );
}
