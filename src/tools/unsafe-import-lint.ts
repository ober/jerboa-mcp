import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface UnsafeImportWarning {
  file: string;
  line: number;
  import: string;
  severity: 'warning' | 'info';
  suggestion: string;
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

// Known unsafe modules and their safe alternatives
const UNSAFE_IMPORTS: Array<{
  pattern: RegExp;
  moduleName: string;
  severity: 'warning' | 'info';
  suggestion: string;
}> = [
  {
    pattern: /\(std\s+db\s+sqlite-native\)/,
    moduleName: '(std db sqlite-native)',
    severity: 'warning',
    suggestion: 'Use (std safe) for type-checked wrappers: safe-sqlite-open validates types and safe-sqlite-exec uses parameterized queries.',
  },
  {
    pattern: /\(std\s+db\s+sqlite\)/,
    moduleName: '(std db sqlite)',
    severity: 'info',
    suggestion: 'Consider (std safe) wrappers for additional type validation on sqlite operations.',
  },
  {
    pattern: /\(std\s+net\s+tcp-raw\)/,
    moduleName: '(std net tcp-raw)',
    severity: 'warning',
    suggestion: 'Use (std safe) safe-tcp-connect for type validation and port range checking.',
  },
  {
    pattern: /\(std\s+net\s+tcp\)/,
    moduleName: '(std net tcp)',
    severity: 'info',
    suggestion: 'Consider (std safe) wrappers for additional type validation on TCP connections.',
  },
  {
    pattern: /\(std\s+os\s+subprocess\)/,
    moduleName: '(std os subprocess)',
    severity: 'warning',
    suggestion: 'Use (std misc process) run-process with argument lists instead of shell strings.',
  },
  {
    pattern: /\bfork-thread\b/,
    moduleName: 'fork-thread (chezscheme)',
    severity: 'info',
    suggestion: 'Consider (std concur structured) for structured concurrency with proper cleanup and cancellation.',
  },
  {
    pattern: /\(\s*error\s+"[^"]*"/,
    moduleName: 'bare (error ...)',
    severity: 'info',
    suggestion: 'Consider structured conditions from (std error conditions) for richer error context and programmatic handling.',
  },
  {
    pattern: /\bopen-process-ports\b/,
    moduleName: 'open-process-ports (chezscheme)',
    severity: 'info',
    suggestion: 'Consider (std misc process) run-process for safer subprocess management with automatic cleanup.',
  },
  {
    pattern: /\bforeign-procedure\b/,
    moduleName: 'foreign-procedure',
    severity: 'warning',
    suggestion: 'Inline FFI bindings are error-prone. Move to a dedicated module and use jerboa_ffi_scaffold for code generation.',
  },
  {
    pattern: /\bmake-mutex\b/,
    moduleName: 'make-mutex (chezscheme)',
    severity: 'info',
    suggestion: 'Consider (std stm) for lock-free concurrency with software transactional memory.',
  },
];

export function registerUnsafeImportLintTool(server: McpServer): void {
  server.registerTool(
    'jerboa_unsafe_import_lint',
    {
      title: 'Unsafe Import Lint',
      description:
        'Lint pass that detects unsafe or raw module imports and suggests safe alternatives. ' +
        'Warns on: (std db sqlite-native), (std net tcp-raw), inline foreign-procedure, ' +
        'bare (error ...), fork-thread, open-process-ports, and more. ' +
        'Suggests (std safe) wrappers, structured concurrency, and structured conditions.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single file to lint'),
        project_path: z.string().optional().describe('Project directory to lint recursively'),
        warnings_only: z.coerce.boolean().optional().describe('Only show warnings, not info-level suggestions (default: false)'),
      },
    },
    async ({ file_path, project_path, warnings_only }) => {
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

      const warnings: UnsafeImportWarning[] = [];

      for (const fp of files) {
        let content: string;
        try { content = await readFile(fp, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith(';')) continue;

          for (const rule of UNSAFE_IMPORTS) {
            if (warnings_only && rule.severity === 'info') continue;

            const match = rule.pattern.exec(line);
            if (!match) continue;

            // Skip if in comment or string
            const semicolon = line.indexOf(';');
            if (semicolon >= 0 && semicolon < match.index) continue;
            const before = line.substring(0, match.index);
            if ((before.match(/"/g) || []).length % 2 !== 0) continue;

            warnings.push({
              file: fp,
              line: i + 1,
              import: rule.moduleName,
              severity: rule.severity,
              suggestion: rule.suggestion,
            });
          }
        }
      }

      warnings.sort((a, b) => {
        const sevOrder = { warning: 0, info: 1 };
        const s = sevOrder[a.severity] - sevOrder[b.severity];
        if (s !== 0) return s;
        return a.file.localeCompare(b.file) || a.line - b.line;
      });

      const sections: string[] = [];
      const label = project_path || file_path;
      sections.push(`Unsafe Import Lint: ${label}`);
      sections.push(`Files scanned: ${files.length}`);
      sections.push('');

      if (warnings.length === 0) {
        sections.push('No unsafe import patterns found.');
      } else {
        const warnCount = warnings.filter(w => w.severity === 'warning').length;
        const infoCount = warnings.filter(w => w.severity === 'info').length;
        sections.push(`Findings: ${warnings.length} (${warnCount} warnings, ${infoCount} suggestions)`);
        sections.push('');

        for (const w of warnings) {
          const shortFile = project_path ? w.file.replace(project_path + '/', '') : w.file;
          const tag = w.severity === 'warning' ? 'WARNING' : 'INFO';
          sections.push(`[${tag}] ${shortFile}:${w.line}`);
          sections.push(`  Import: ${w.import}`);
          sections.push(`  -> ${w.suggestion}`);
          sections.push('');
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
      };
    },
  );
}
