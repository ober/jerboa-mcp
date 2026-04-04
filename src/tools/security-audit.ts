import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface AuditFinding {
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
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
      else if (entry.endsWith('.ss') || entry.endsWith('.sls') || entry.endsWith('.scm')) results.push(fullPath);
    } catch { /* skip */ }
  }
}

// Define Jerboa-specific security audit rules
const AUDIT_RULES: Array<{
  id: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  pattern: RegExp;
  contextCheck?: (lines: string[], lineIdx: number) => boolean;
  message: string;
  remediation: string;
}> = [
  // Sanitization context misuse
  {
    id: 'sanitize-html-in-attr',
    category: 'sanitization',
    severity: 'high',
    pattern: /\bsanitize-html\b/,
    contextCheck: (lines, i) => {
      const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join(' ');
      return /\b(href|src|action|formaction|data|poster|codebase)\b/i.test(context) ||
             /attribute/i.test(context);
    },
    message: 'sanitize-html used in URL attribute context. sanitize-html does not sanitize URL schemes (javascript:, data:).',
    remediation: 'Use sanitize-url-attribute for href/src/action attributes, or sanitize-url for bare URL values.',
  },
  {
    id: 'sanitize-missing-at-sink',
    category: 'sanitization',
    severity: 'critical',
    pattern: /\b(http-respond|display|write-string|format)\b.*\b(tainted|user-input|request-body|query-param|form-data)\b/,
    message: 'Potentially tainted data passed directly to output sink without sanitization.',
    remediation: 'Apply sanitize-html, sanitize-url, or appropriate sanitizer before output. Consider using taint-check at the sink.',
  },
  // Taint tracking
  {
    id: 'taint-check-missing',
    category: 'taint',
    severity: 'high',
    pattern: /\b(request-body|query-param|form-field|header-ref|cookie-ref|path-param)\b/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 10)).join(' ');
      return !surrounding.includes('taint-check') && !surrounding.includes('sanitize') &&
             !surrounding.includes('validate') && !surrounding.includes('check-');
    },
    message: 'User input source used without visible taint-check or sanitization in surrounding context.',
    remediation: 'Wrap with (taint-check value validator) or apply sanitization before use.',
  },
  // Capability system bypass
  {
    id: 'bare-chezscheme-import',
    category: 'capability',
    severity: 'high',
    pattern: /\(import\s+\(chezscheme\)\)/,
    contextCheck: (lines, i) => {
      // OK in .sls library files (they need low-level access)
      return true; // Always flag in .ss files
    },
    message: 'Direct (import (chezscheme)) bypasses the Jerboa capability system. All Chez primitives become available.',
    remediation: 'Import specific modules instead: (import (jerboa prelude)) or (import (std ...)). If raw Chez access is needed, document the reason.',
  },
  // Read safety
  {
    id: 'bare-read-no-eval-guard',
    category: 'eval-injection',
    severity: 'critical',
    pattern: /\(\s*read\s+/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 5)).join(' ');
      return !surrounding.includes('read-eval') && !surrounding.includes('#f') &&
             !surrounding.includes('parameterize');
    },
    message: 'Bare (read port) without (parameterize ([read-eval #f]) ...). Chez read can evaluate #. reader macros.',
    remediation: 'Wrap in (parameterize ([read-eval #f]) (read port)) to prevent reader-macro injection.',
  },
  // Environment copying
  {
    id: 'copy-env-no-restrict',
    category: 'capability',
    severity: 'medium',
    pattern: /\bcopy-environment\b/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 10)).join(' ');
      return !surrounding.includes('restrict') && !surrounding.includes('sandbox');
    },
    message: 'copy-environment without restrict. The copied environment inherits all bindings including dangerous ones.',
    remediation: 'After copy-environment, manually remove dangerous bindings (system, eval, load, foreign-procedure) from the environment, or use (eval expr (environment \'(only (rnrs) ...))) with an explicit allowlist.',
  },
  // Privilege separation
  {
    id: 'privsep-missing-drop',
    category: 'privsep',
    severity: 'medium',
    pattern: /\bprivsep-init\b/,
    contextCheck: (lines, i) => {
      const after = lines.slice(i, Math.min(lines.length, i + 30)).join(' ');
      return !after.includes('privsep-drop') && !after.includes('drop-privileges');
    },
    message: 'privsep-init called without corresponding privsep-drop. Privileges may not be dropped.',
    remediation: 'Call (privsep-drop) after initialization to drop elevated privileges.',
  },
  // Unsafe eval
  {
    id: 'eval-user-input',
    category: 'eval-injection',
    severity: 'critical',
    pattern: /\(\s*eval\s+/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join(' ');
      return /\b(request|input|param|query|body|user|arg)\b/.test(surrounding);
    },
    message: 'eval called with potentially user-controlled input. This allows arbitrary code execution.',
    remediation: 'Never eval user input. Use a restricted environment with (eval expr (environment ...)) if absolutely necessary.',
  },
  // SQL injection via string interpolation
  {
    id: 'sql-string-interpolation',
    category: 'injection',
    severity: 'critical',
    pattern: /\b(sqlite-exec|sqlite-eval|sqlite-query|sql-exec|db-exec)\b/,
    contextCheck: (lines, i) => {
      const line = lines[i];
      return line.includes('string-append') || line.includes('format ') || line.includes('str ');
    },
    message: 'SQL query built with string interpolation. Vulnerable to SQL injection.',
    remediation: 'Use parameterized queries: (sqlite-exec db "SELECT * FROM t WHERE id = ?" id)',
  },
  // File path traversal
  {
    id: 'path-traversal',
    category: 'injection',
    severity: 'high',
    pattern: /\b(open-input-file|open-output-file|file-exists\?|delete-file|call-with-input-file)\b/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join(' ');
      return (/\b(request|input|param|query|path-param|user)\b/.test(surrounding)) &&
             !surrounding.includes('path-normalize') && !surrounding.includes('path-sanitize');
    },
    message: 'File operation with potentially user-controlled path without path normalization.',
    remediation: 'Use (path-normalize path base-dir) and verify the result is under the expected directory.',
  },
  // Unsafe deserialization
  {
    id: 'fasl-read-untrusted',
    category: 'deserialization',
    severity: 'critical',
    pattern: /\b(fasl-read|load|load-program)\b/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join(' ');
      return /\b(request|input|upload|user|remote|network)\b/.test(surrounding);
    },
    message: 'fasl-read/load with potentially untrusted input. FASL files can contain arbitrary code.',
    remediation: 'Never load FASL files from untrusted sources. Use read-json or a safe data format instead.',
  },
  // Missing with-resource
  {
    id: 'resource-no-cleanup',
    category: 'resource',
    severity: 'medium',
    pattern: /\b(sqlite-open|tcp-connect|open-input-file|open-output-file)\b/,
    contextCheck: (lines, i) => {
      const surrounding = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 15)).join(' ');
      return !surrounding.includes('with-resource') && !surrounding.includes('unwind-protect') &&
             !surrounding.includes('dynamic-wind') && !surrounding.includes('call-with-port') &&
             !surrounding.includes('call-with-input-file') && !surrounding.includes('call-with-output-file');
    },
    message: 'Resource acquired without with-resource or unwind-protect. May leak on exception.',
    remediation: 'Use (with-resource [r (resource-open ...)] body ...) for automatic cleanup.',
  },
];

function isInCommentOrString(line: string, matchIndex: number): boolean {
  const semicolon = line.indexOf(';');
  if (semicolon >= 0 && semicolon < matchIndex) return true;
  const before = line.substring(0, matchIndex);
  const quoteCount = (before.match(/"/g) || []).length;
  return quoteCount % 2 !== 0;
}

function auditFile(filePath: string, content: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lines = content.split('\n');
  const isLibrary = filePath.endsWith('.sls');

  for (const rule of AUDIT_RULES) {
    // Skip capability checks in .sls files (they legitimately need low-level access)
    if (isLibrary && rule.id === 'bare-chezscheme-import') continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      if (trimmed.startsWith(';')) continue;

      const match = rule.pattern.exec(line);
      if (!match) continue;
      if (isInCommentOrString(line, match.index)) continue;

      // Check suppression
      const suppressMatch = line.match(/;\s*jerboa-security:\s*suppress(?:-all|[\s]+(\S+))/);
      if (suppressMatch) {
        if (line.includes('suppress-all') || suppressMatch[1] === rule.id) continue;
      }

      // Run context check if defined
      if (rule.contextCheck && !rule.contextCheck(lines, i)) continue;

      findings.push({
        file: filePath,
        line: i + 1,
        severity: rule.severity,
        category: rule.category,
        message: rule.message,
        remediation: rule.remediation,
      });
    }
  }

  return findings;
}

export function registerSecurityAuditTool(server: McpServer): void {
  server.registerTool(
    'jerboa_security_audit',
    {
      title: 'Jerboa Security Audit',
      description:
        'Jerboa-specific security auditor that understands Jerboa\'s security modules ' +
        '(taint, capability, restrict, sanitize, privsep). Detects: sanitizer context misuse, ' +
        'missing taint checks at sinks, bare read without read-eval #f, copy-environment without ' +
        'restrict, eval of user input, SQL injection, path traversal, and resource leaks. ' +
        'More Jerboa-aware than the generic security_scan.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Single file to audit'),
        project_path: z.string().optional().describe('Project directory to audit recursively'),
        category: z.string().optional().describe('Filter by category: sanitization, taint, capability, eval-injection, injection, privsep, deserialization, resource'),
        severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Minimum severity to report (default: low)'),
      },
    },
    async ({ file_path, project_path, category, severity_threshold }) => {
      if (!file_path && !project_path) {
        return { content: [{ type: 'text' as const, text: 'Error: provide file_path or project_path.' }], isError: true };
      }

      const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const threshold = sevOrder[severity_threshold || 'low'];

      let files: string[] = [];
      if (file_path) {
        files = [file_path];
      } else if (project_path) {
        await scanDirRecursive(project_path, files);
        files.sort();
      }

      const allFindings: AuditFinding[] = [];
      for (const fp of files) {
        let content: string;
        try { content = await readFile(fp, 'utf-8'); } catch { continue; }
        const findings = auditFile(fp, content);
        allFindings.push(...findings);
      }

      // Filter by category and severity
      const filtered = allFindings.filter(f => {
        if (sevOrder[f.severity] > threshold) return false;
        if (category && f.category !== category) return false;
        return true;
      });

      filtered.sort((a, b) => {
        const s = sevOrder[a.severity] - sevOrder[b.severity];
        if (s !== 0) return s;
        return a.file.localeCompare(b.file) || a.line - b.line;
      });

      const sections: string[] = [];
      const label = project_path || file_path;
      sections.push(`Jerboa Security Audit: ${label}`);
      sections.push(`Files scanned: ${files.length}`);
      sections.push(`Rules: ${AUDIT_RULES.length}`);
      sections.push('');

      if (filtered.length === 0) {
        sections.push('No security issues found.');
      } else {
        const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
        for (const f of filtered) counts[f.severity]++;
        const summaryParts = ['critical', 'high', 'medium', 'low'].filter(s => counts[s] > 0).map(s => `${counts[s]} ${s}`);
        sections.push(`Findings: ${filtered.length} (${summaryParts.join(', ')})`);
        sections.push('');

        for (const f of filtered) {
          const shortFile = project_path ? f.file.replace(project_path + '/', '') : f.file;
          sections.push(`[${f.severity.toUpperCase()}] ${shortFile}:${f.line} [${f.category}]`);
          sections.push(`  ${f.message}`);
          sections.push(`  Fix: ${f.remediation}`);
          sections.push('');
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
        isError: filtered.some(f => f.severity === 'critical'),
      };
    },
  );
}
