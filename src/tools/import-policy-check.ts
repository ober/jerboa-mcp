import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface PolicyViolation {
  file: string;
  line: number;
  import: string;
  rule: string;
  message: string;
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

// Default forbidden import patterns
const DEFAULT_FORBIDDEN: Array<{
  pattern: RegExp;
  rule: string;
  message: string;
}> = [
  {
    pattern: /\(\s*import\s+\(chezscheme\)\s*\)/,
    rule: 'no-chezscheme',
    message: 'Direct (import (chezscheme)) bypasses the capability system. Use (import (jerboa prelude)) or specific (std ...) modules.',
  },
  {
    pattern: /\(\s*import\s+\(scheme\)\s*\)/,
    rule: 'no-scheme',
    message: 'Direct (import (scheme)) bypasses the capability system. Use (import (jerboa prelude)) or specific (std ...) modules.',
  },
  {
    pattern: /\(\s*import\s+\(chezscheme\s+csv7\)\s*\)/,
    rule: 'no-csv7',
    message: '(chezscheme csv7) provides low-level record access. Use (std ...) equivalents.',
  },
  {
    pattern: /\bforeign-procedure\b/,
    rule: 'no-inline-ffi',
    message: 'Inline foreign-procedure in application code. Move FFI bindings to a dedicated (std ffi ...) module.',
  },
  {
    pattern: /\bload-shared-object\b/,
    rule: 'no-inline-lso',
    message: 'Inline load-shared-object in application code. Move to a dedicated FFI module.',
  },
  {
    pattern: /\b(system|process|shell)\s+"[^"]*\$\{/,
    rule: 'no-shell-interpolation',
    message: 'Shell command with string interpolation. Use run-process with argument list instead.',
  },
];

function isInCommentOrString(line: string, matchIndex: number): boolean {
  const semicolon = line.indexOf(';');
  if (semicolon >= 0 && semicolon < matchIndex) return true;
  const before = line.substring(0, matchIndex);
  const quoteCount = (before.match(/"/g) || []).length;
  return quoteCount % 2 !== 0;
}

export function registerImportPolicyCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_import_policy_check',
    {
      title: 'Import Policy Check',
      description:
        'Build-time check that scans Jerboa .ss files for forbidden imports and unsafe patterns. ' +
        'Detects direct (chezscheme) imports, inline foreign-procedure, load-shared-object in ' +
        'application code, and shell interpolation. Reports file, line, and violation details. ' +
        'Excludes .sls library files by default (they legitimately need low-level access).',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        project_path: z.string().describe('Project directory to scan'),
        include_libraries: z.boolean().optional().describe('Also scan .sls files (default: false, they need low-level access)'),
        extra_forbidden: z.array(z.object({
          pattern: z.string().describe('Regex pattern to match'),
          rule: z.string().describe('Rule ID'),
          message: z.string().describe('Violation message'),
        })).optional().describe('Additional forbidden patterns'),
      },
    },
    async ({ project_path, include_libraries, extra_forbidden }) => {
      const files: string[] = [];
      await scanDirRecursive(project_path, files);
      files.sort();

      // Also scan .sls if requested
      if (include_libraries) {
        const slsFiles: string[] = [];
        const scanSls = async (dir: string): Promise<void> => {
          let entries: string[];
          try { entries = await readdir(dir); } catch { return; }
          for (const entry of entries) {
            if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
            const fullPath = join(dir, entry);
            try {
              const info = await stat(fullPath);
              if (info.isDirectory()) await scanSls(fullPath);
              else if (entry.endsWith('.sls')) slsFiles.push(fullPath);
            } catch { /* skip */ }
          }
        };
        await scanSls(project_path);
        files.push(...slsFiles.sort());
      }

      const rules = [...DEFAULT_FORBIDDEN];
      if (extra_forbidden) {
        for (const ef of extra_forbidden) {
          try {
            rules.push({ pattern: new RegExp(ef.pattern), rule: ef.rule, message: ef.message });
          } catch { /* skip invalid regex */ }
        }
      }

      const violations: PolicyViolation[] = [];

      for (const fp of files) {
        let content: string;
        try { content = await readFile(fp, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith(';')) continue;

          // Check for suppression
          const suppressMatch = line.match(/;\s*policy:\s*allow\b/);
          if (suppressMatch) continue;

          for (const rule of rules) {
            const match = rule.pattern.exec(line);
            if (!match) continue;
            if (isInCommentOrString(line, match.index)) continue;

            violations.push({
              file: fp,
              line: i + 1,
              import: match[0].trim(),
              rule: rule.rule,
              message: rule.message,
            });
          }
        }
      }

      violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

      const sections: string[] = [];
      sections.push(`Import Policy Check: ${project_path}`);
      sections.push(`Files scanned: ${files.length}`);
      sections.push(`Rules: ${rules.length}`);
      sections.push('');

      if (violations.length === 0) {
        sections.push('No policy violations found.');
      } else {
        sections.push(`POLICY VIOLATIONS: ${violations.length}`);
        sections.push('');

        for (const v of violations) {
          const shortFile = v.file.replace(project_path + '/', '');
          sections.push(`  ${shortFile}:${v.line} [${v.rule}]`);
          sections.push(`    ${v.import}`);
          sections.push(`    -> ${v.message}`);
          sections.push('');
        }

        sections.push('Suppress a violation with: ; policy: allow');
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
        isError: violations.length > 0,
      };
    },
  );
}
