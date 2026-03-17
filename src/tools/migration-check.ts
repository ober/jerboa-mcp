/**
 * jerboa_migration_check — Scan Gerbil source files for patterns that need
 * adaptation when porting to Jerboa. Detects Gerbil-specific idioms and
 * suggests Jerboa equivalents.
 * Pure TypeScript, no subprocess.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO';

interface MigrationRule {
  id: string;
  pattern: RegExp;
  severity: IssueSeverity;
  message: string;
  suggestion: string;
}

interface MigrationIssue {
  severity: IssueSeverity;
  line: number;
  id: string;
  message: string;
  suggestion: string;
  lineText: string;
}

const MIGRATION_RULES: MigrationRule[] = [
  // ── Hard errors ───────────────────────────────────────────────
  {
    id: 'export-hash-t',
    pattern: /\(export\s+#t\)/,
    severity: 'ERROR',
    message: '(export #t) not supported',
    suggestion: 'Enumerate exports explicitly: (export foo bar baz)',
  },
  {
    id: 'import-gerbil-stdlib',
    pattern: /\(import\s+:gerbil\//,
    severity: 'ERROR',
    message: 'Gerbil standard library import (:gerbil/...)',
    suggestion: 'Use Chez Scheme built-ins or (jerboa ...) / (std ...) equivalents instead',
  },
  {
    id: 'import-gambit',
    pattern: /\(import\s+:gambit\b/,
    severity: 'ERROR',
    message: 'Gambit runtime import (:gambit) not available',
    suggestion: 'Use Chez Scheme built-ins instead; see (chezscheme) or (jerboa prelude)',
  },
  {
    id: 'gambit-primitives',
    pattern: /\(##[\w\-!?*/+<=>]+/,
    severity: 'ERROR',
    message: 'Gambit ## namespace primitive not available in Chez/Jerboa',
    suggestion: 'Find the Chez Scheme equivalent; use jerboa_apropos to search for alternatives',
  },
  {
    id: 'gxi-invocation',
    pattern: /\bgxi\b/,
    severity: 'ERROR',
    message: 'gxi (Gerbil interpreter) invocation',
    suggestion: 'Use scheme binary instead: scheme --libdirs JERBOA_HOME/lib --script file.ss',
  },
  {
    id: 'gxc-invocation',
    pattern: /\bgxc\b/,
    severity: 'ERROR',
    message: 'gxc (Gerbil compiler) invocation',
    suggestion: 'Use Chez compile tools or Jerboa build system instead',
  },

  // ── Import style ─────────────────────────────────────────────
  {
    id: 'std-import-colon-style',
    pattern: /\(import\s+:std\//,
    severity: 'WARNING',
    message: ':std/... import style (Gerbil convention)',
    suggestion: 'Use (std ...) form: (import (std sort)), (import (std text json))',
  },
  {
    id: 'gerbil-package-import',
    pattern: /\(import\s+:[a-zA-Z][a-zA-Z0-9_-]*\//,
    severity: 'WARNING',
    message: 'Gerbil-style colon-prefixed package import (:pkg/module)',
    suggestion: 'Use Jerboa module paths: (import (pkg module)) or (import :pkg/module) if supported',
  },

  // ── Exception handling ─────────────────────────────────────────
  {
    id: 'with-catch',
    pattern: /\bwith-catch\b/,
    severity: 'WARNING',
    message: 'with-catch is Gerbil-specific',
    suggestion: 'Use guard (R7RS/Chez): (guard (exn [(condition? exn) handler]) body...)',
  },

  // ── Macro syntax ──────────────────────────────────────────────
  {
    id: 'defsyntax',
    pattern: /\(defsyntax\s/,
    severity: 'WARNING',
    message: '(defsyntax ...) is Gerbil-specific',
    suggestion: 'Use (define-syntax ...) in Chez/Jerboa',
  },
  {
    id: 'set-macro-transformer',
    pattern: /\(set-macro-transformer!/,
    severity: 'WARNING',
    message: '(set-macro-transformer! ...) is Gerbil-specific',
    suggestion: 'Use (define-syntax ...) with (syntax-rules ...) or (er-macro-transformer ...)',
  },
  {
    id: 'begin-syntax',
    pattern: /\(begin-syntax\s/,
    severity: 'WARNING',
    message: '(begin-syntax ...) is Gerbil-specific',
    suggestion: 'Use (let-syntax ...) or (define-syntax ...) at top level instead',
  },

  // ── Definition forms ──────────────────────────────────────────
  {
    id: 'def-shorthand',
    pattern: /^\s*\(def\s+(?!ault)(?!er)(?!struct)(?!class)(?!syntax)/m,
    severity: 'WARNING',
    message: '(def ...) shorthand is Gerbil-specific',
    suggestion: 'Use (define ...) in Chez/Jerboa',
  },
  {
    id: 'defclass-colon-syntax',
    pattern: /\(defclass\s+\S+\s+\(/,
    severity: 'INFO',
    message: '(defclass ...) with parent class syntax',
    suggestion: 'Check defclass syntax; Jerboa may use different class definition forms. Verify with jerboa_module_exports.',
  },

  // ── Module definition ─────────────────────────────────────────
  {
    id: 'module-form',
    pattern: /\(module\s+[\w\-]+\s/,
    severity: 'INFO',
    message: '(module ...) form (may be R7RS library syntax)',
    suggestion: 'Use (library ...) for Chez Scheme libraries, or top-level module conventions in Jerboa',
  },

  // ── Macro suggestion ─────────────────────────────────────────
  {
    id: 'define-syntax-rule',
    pattern: /\(define-syntax-rule\s/,
    severity: 'INFO',
    message: '(define-syntax-rule ...) is from Racket/SRFI-89',
    suggestion: 'Use (defrule ...) from (jerboa prelude) for equivalent pattern-matching macro definition',
  },
];

function checkLine(
  line: string,
  lineNum: number,
  rules: MigrationRule[],
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];

  // Skip pure comment lines
  const trimmed = line.trim();
  if (trimmed.startsWith(';')) return issues;

  // Remove string literals to avoid false positives in string content
  const strippedLine = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');

  for (const rule of rules) {
    // For multiline patterns (anchored with /m), test the original line
    if (rule.pattern.test(strippedLine)) {
      issues.push({
        severity: rule.severity,
        line: lineNum,
        id: rule.id,
        message: rule.message,
        suggestion: rule.suggestion,
        lineText: trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed,
      });
    }
  }

  return issues;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
};

export function registerMigrationCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_migration_check',
    {
      title: 'Migration Check',
      description:
        'Scan Gerbil source files for patterns that need adaptation when porting to Jerboa. ' +
        'Detects Gerbil-specific idioms (gxi/gxc invocations, :std/ imports, (export #t), ' +
        'Gambit ## primitives, gerbil-specific macros) and suggests Jerboa equivalents.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z
          .string()
          .describe('Path to a .ss/.sls file to check for Gerbil → Jerboa migration issues'),
      },
    },
    async ({ file_path }) => {
      let content: string;
      try {
        content = await readFile(file_path, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to read file: ${msg}` }],
          isError: true,
        };
      }

      const shortName = basename(file_path);
      const fileLines = content.split('\n');
      const allIssues: MigrationIssue[] = [];

      for (let i = 0; i < fileLines.length; i++) {
        const lineIssues = checkLine(fileLines[i], i + 1, MIGRATION_RULES);
        allIssues.push(...lineIssues);
      }

      // Deduplicate: same rule + same line → keep only first
      const seen = new Set<string>();
      const dedupedIssues = allIssues.filter((issue) => {
        const key = `${issue.id}:${issue.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (dedupedIssues.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Migration Check: ${shortName}\n\nNo migration issues found. File looks Jerboa-compatible.`,
          }],
        };
      }

      // Sort by line number, then severity
      dedupedIssues.sort((a, b) => {
        const lineDiff = a.line - b.line;
        if (lineDiff !== 0) return lineDiff;
        return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      });

      const errorCount = dedupedIssues.filter((i) => i.severity === 'ERROR').length;
      const warnCount = dedupedIssues.filter((i) => i.severity === 'WARNING').length;
      const infoCount = dedupedIssues.filter((i) => i.severity === 'INFO').length;

      const summaryParts: string[] = [];
      if (errorCount > 0) summaryParts.push(`${errorCount} error(s)`);
      if (warnCount > 0) summaryParts.push(`${warnCount} warning(s)`);
      if (infoCount > 0) summaryParts.push(`${infoCount} info`);

      const lines: string[] = [
        `Migration Check: ${shortName}`,
        '',
        `Found ${dedupedIssues.length} issue(s) to address for Gerbil → Jerboa migration (${summaryParts.join(', ')}):`,
        '',
      ];

      for (const issue of dedupedIssues) {
        const lineNumStr = String(issue.line).padStart(3, ' ');
        lines.push(`${issue.severity.padEnd(7)} line ${lineNumStr}: ${issue.message}`);
        lines.push(`         → ${issue.suggestion}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
        isError: errorCount > 0,
      };
    },
  );
}
