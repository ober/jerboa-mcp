/**
 * jerboa_batch_audit — Run multiple analyses in one call.
 *
 * Runs lint + security_scan + check_import_conflicts + dead_code in parallel
 * for a project directory or single file. Returns a combined report with
 * sections per analysis and an overall health summary.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { runChez, ERROR_MARKER, normalizeImport } from '../chez.js';
import { scanSchemeFiles, parseDefinitions, extractModulePaths } from './parse-utils.js';
import { checkBalance } from './check-balance.js';
import { runLintChecks, type LintDiagnostic } from './lint.js';
import { scanFileContent, loadSecurityRules, REPO_SECURITY_RULES_PATH } from './security-scan.js';

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface AuditResult {
  check: string;
  issues: number;
  errors: number;
  warnings: number;
  details: string;
}

function severityToNumber(s: string): number {
  return SEVERITY_ORDER[s] ?? 4;
}

/** Build a section header line */
function section(title: string, issues: number): string {
  const status = issues === 0 ? '✓' : '✗';
  return `\n${status} ${title.toUpperCase()} (${issues} issue${issues === 1 ? '' : 's'})`;
}

export function registerBatchAuditTool(server: McpServer): void {
  server.registerTool(
    'jerboa_batch_audit',
    {
      title: 'Batch Project Audit',
      description:
        'Run multiple analyses in one call: balance check, lint, security scan, and ' +
        'import conflict detection — all in parallel. ' +
        'Returns a combined report with section headers, issue counts, and an overall score. ' +
        'More comprehensive than jerboa_verify (which covers syntax/compile) and ' +
        'complementary to jerboa_project_health_check (which covers cycles/exports/duplicates). ' +
        'Use project_path for project-wide audit, file_path for single-file audit.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        project_path: z.string().optional()
          .describe('Project directory to audit all .ss files'),
        file_path: z.string().optional()
          .describe('Single .ss file to audit'),
        severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).optional()
          .describe('Minimum security finding severity to report (default: medium)'),
        jerboa_home: z.string().optional()
          .describe('Path to Jerboa home directory'),
        skip: z.array(z.enum(['balance', 'lint', 'security', 'imports'])).optional()
          .describe('Checks to skip'),
      },
    },
    async ({ project_path, file_path, severity_threshold, jerboa_home, skip = [] }) => {
      if (!project_path && !file_path) {
        return {
          content: [{ type: 'text' as const, text: 'Provide project_path or file_path.' }],
          isError: true,
        };
      }

      const skipSet = new Set(skip);
      const thresholdNum = severityToNumber(severity_threshold ?? 'medium');
      const securityRules = loadSecurityRules(REPO_SECURITY_RULES_PATH);

      // Collect files to audit
      let filePaths: string[];
      const basePath = project_path ?? (file_path as string);

      if (file_path) {
        filePaths = [file_path];
      } else {
        filePaths = await scanSchemeFiles(project_path!);
      }

      if (filePaths.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No .ss files found to audit.' }],
        };
      }

      // Read all files once, share across checks
      const fileContents = new Map<string, string>();
      await Promise.all(
        filePaths.map(async (fp) => {
          try {
            fileContents.set(fp, await readFile(fp, 'utf-8'));
          } catch {
            // skip unreadable
          }
        }),
      );

      const readable = [...fileContents.keys()];

      // ── Run all checks in parallel ──────────────────────────────────

      const [balanceResults, lintResults, securityResults, importResults] = await Promise.all([
        // 1. Balance check (pure TS, instant)
        skipSet.has('balance')
          ? Promise.resolve(null)
          : Promise.resolve(
              readable.map((fp) => ({
                file: fp,
                result: checkBalance(fileContents.get(fp)!),
              })),
            ),

        // 2. Lint (pure TS)
        skipSet.has('lint')
          ? Promise.resolve(null)
          : Promise.resolve(
              readable.map((fp) => ({
                file: fp,
                diagnostics: runLintChecks(fp, fileContents.get(fp)!),
              })),
            ),

        // 3. Security scan (pure TS with loaded rules)
        skipSet.has('security')
          ? Promise.resolve(null)
          : Promise.resolve(
              readable.flatMap((fp) =>
                scanFileContent(fp, fileContents.get(fp)!, securityRules, thresholdNum).filter(
                  (f) => !f.suppressed,
                ),
              ),
            ),

        // 4. Import conflict detection (Chez subprocess)
        skipSet.has('imports')
          ? Promise.resolve(null)
          : (async () => {
              // Build list of unique module paths to resolve
              const allModPaths = new Set<string>();
              for (const content of fileContents.values()) {
                const analysis = parseDefinitions(content);
                for (const imp of analysis.imports) {
                  for (const mp of extractModulePaths(imp.raw)) {
                    if (!mp.startsWith('./') && !mp.startsWith('(jerboa')) {
                      allModPaths.add(mp);
                    }
                  }
                }
              }

              if (allModPaths.size === 0) return { conflicts: [], resolvedModules: 0 };

              // Batch resolve exports
              const MARKER = 'BATCH-AUDIT-EXP:';
              const parts: string[] = ['(import (jerboa prelude))'];
              for (const mp of allModPaths) {
                const norm = normalizeImport(mp);
                const esc = JSON.stringify(mp);
                parts.push(`(guard (e [else (void)])`);
                parts.push(`  (let ((env (the-environment)))`);
                parts.push(`    (eval '(import ${norm}) env)`);
                parts.push(`    (display "${MARKER}MODULE\\t") (display ${esc}) (newline)`);
                parts.push(`    (environment-for-each env`);
                parts.push(`      (lambda (n v) (display "${MARKER}SYM\\t") (display n) (newline)))))`);
              }

              const chezResult = await runChez(parts.join('\n'), {
                timeout: 30_000,
                jerboaHome: jerboa_home,
              });

              const modExports = new Map<string, Set<string>>();
              let curMod: string | null = null;
              for (const line of chezResult.stdout.split('\n')) {
                if (!line.startsWith(MARKER)) continue;
                const payload = line.slice(MARKER.length);
                const tab = payload.indexOf('\t');
                if (tab === -1) continue;
                const key = payload.slice(0, tab).trim();
                const val = payload.slice(tab + 1).trim();
                if (key === 'MODULE') { curMod = val; modExports.set(val, new Set()); }
                else if (key === 'SYM' && curMod) modExports.get(curMod)?.add(val);
              }

              // Check each file for cross-import conflicts
              const conflicts: Array<{ file: string; sym: string; modules: string[] }> = [];
              for (const [fp, content] of fileContents) {
                const analysis = parseDefinitions(content);
                const symToMods = new Map<string, string[]>();
                for (const imp of analysis.imports) {
                  for (const mp of extractModulePaths(imp.raw)) {
                    const exports = modExports.get(mp);
                    if (!exports) continue;
                    for (const sym of exports) {
                      if (!symToMods.has(sym)) symToMods.set(sym, []);
                      symToMods.get(sym)!.push(mp);
                    }
                  }
                }
                for (const [sym, mods] of symToMods) {
                  const unique = [...new Set(mods)];
                  if (unique.length > 1) {
                    conflicts.push({ file: fp, sym, modules: unique });
                  }
                }
              }

              return { conflicts, resolvedModules: modExports.size };
            })(),
      ]);

      // ── Format combined report ──────────────────────────────────────

      const results: AuditResult[] = [];
      const reportLines: string[] = [];
      const target = project_path ? `${readable.length} file(s) in ${project_path}` : file_path!;
      reportLines.push(`Batch audit: ${target}`);
      reportLines.push('');

      // Balance
      if (balanceResults) {
        const bad = balanceResults.filter((r) => !r.result.ok);
        reportLines.push(section('Balance Check', bad.length));
        if (bad.length === 0) {
          reportLines.push(`  All ${readable.length} file(s) have balanced delimiters.`);
        } else {
          for (const { file, result } of bad) {
            const label = project_path ? relative(basePath, file) : file;
            for (const err of result.errors) {
              reportLines.push(`  ${label}:${err.line}: ${err.kind} '${err.char}'`);
            }
          }
        }
        results.push({ check: 'balance', issues: bad.length, errors: bad.length, warnings: 0, details: '' });
      }

      // Lint
      if (lintResults) {
        const allDiags: Array<{ file: string; d: LintDiagnostic }> = [];
        for (const { file, diagnostics } of lintResults) {
          for (const d of diagnostics) allDiags.push({ file, d });
        }
        const errors = allDiags.filter((x) => x.d.severity === 'error');
        const warnings = allDiags.filter((x) => x.d.severity !== 'error');

        reportLines.push(section('Lint', allDiags.length));
        if (allDiags.length === 0) {
          reportLines.push(`  No lint issues in ${readable.length} file(s).`);
        } else {
          for (const { file, d } of allDiags.slice(0, 30)) {
            const label = project_path ? relative(basePath, file) : file;
            const loc = d.line ? `${label}:${d.line}` : label;
            reportLines.push(`  [${d.severity.toUpperCase()}] ${loc}: ${d.message}`);
          }
          if (allDiags.length > 30) {
            reportLines.push(`  ... and ${allDiags.length - 30} more.`);
          }
        }
        results.push({ check: 'lint', issues: allDiags.length, errors: errors.length, warnings: warnings.length, details: '' });
      }

      // Security
      if (securityResults) {
        reportLines.push(section('Security Scan', securityResults.length));
        if (securityResults.length === 0) {
          reportLines.push(`  No security findings (threshold: ${severity_threshold ?? 'medium'}).`);
        } else {
          const sorted = [...securityResults].sort((a, b) => severityToNumber(a.severity) - severityToNumber(b.severity));
          for (const f of sorted.slice(0, 20)) {
            const label = project_path ? relative(basePath, f.file) : f.file;
            reportLines.push(`  [${f.severity.toUpperCase()}] ${label}:${f.line}: ${f.message}`);
          }
          if (sorted.length > 20) {
            reportLines.push(`  ... and ${sorted.length - 20} more.`);
          }
        }
        const crits = securityResults.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
        results.push({ check: 'security', issues: securityResults.length, errors: crits, warnings: securityResults.length - crits, details: '' });
      }

      // Import conflicts
      if (importResults && 'conflicts' in importResults) {
        const { conflicts, resolvedModules } = importResults;
        reportLines.push(section('Import Conflicts', conflicts.length));
        if (conflicts.length === 0) {
          reportLines.push(`  No cross-import conflicts (resolved ${resolvedModules} module(s)).`);
        } else {
          for (const c of conflicts.slice(0, 20)) {
            const label = project_path ? relative(basePath, c.file) : c.file;
            reportLines.push(`  ${label}: "${c.sym}" exported by: ${c.modules.join(', ')}`);
          }
        }
        results.push({ check: 'imports', issues: conflicts.length, errors: conflicts.length, warnings: 0, details: '' });
      }

      // Overall summary table
      const totalIssues = results.reduce((s, r) => s + r.issues, 0);
      const totalErrors = results.reduce((s, r) => s + r.errors, 0);
      reportLines.push('\n── SUMMARY ──────────────────────────────────');
      reportLines.push(`| Check    | Issues | Errors | Warnings |`);
      reportLines.push(`|----------|--------|--------|----------|`);
      for (const r of results) {
        reportLines.push(`| ${r.check.padEnd(8)} | ${String(r.issues).padEnd(6)} | ${String(r.errors).padEnd(6)} | ${String(r.warnings).padEnd(8)} |`);
      }
      reportLines.push(`| TOTAL    | ${String(totalIssues).padEnd(6)} | ${String(totalErrors).padEnd(6)} | ${String(totalIssues - totalErrors).padEnd(8)} |`);

      if (totalIssues === 0) {
        reportLines.push('\nAll checks passed — project looks clean.');
      } else if (totalErrors === 0) {
        reportLines.push(`\n${totalIssues} warning(s) found. No blocking errors.`);
      } else {
        reportLines.push(`\n${totalErrors} error(s) require attention before shipping.`);
      }

      return {
        content: [{ type: 'text' as const, text: reportLines.join('\n') }],
        isError: totalErrors > 0,
      };
    },
  );
}
