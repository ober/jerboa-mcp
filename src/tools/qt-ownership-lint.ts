import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

interface OwnershipIssue {
  kind: 'double-free' | 'orphaned-child' | 'use-after-parent-destroy';
  severity: 'error' | 'warning';
  line?: number;
  detail: string;
  fix?: string;
}

/**
 * Scan C++ Qt shim code or Jerboa Scheme FFI call sequences for
 * Qt parent-child ownership violations:
 *
 * 1. Double-free: explicit child destroy after parent destroy
 *    (parent destroy implicitly destroys all children)
 * 2. Child pointer used after parent was destroyed on same code path
 */
function scanQtOwnership(source: string, filename: string): OwnershipIssue[] {
  const issues: OwnershipIssue[] = [];
  const lines = source.split('\n');

  // ── C++ / Qt shim scanning ──────────────────────────────────────────────

  if (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.h')) {
    // Find delete / destroy calls and track which variables are parents vs children
    // Pattern: variable is set as a child by passing a parent pointer to constructor,
    // or by setParent(). Track parent→children relationships.

    // Simple heuristic: detect when a variable X is destroyed via delete/qt_widget_destroy,
    // and later in the same function/scope, the same variable or a child of X is also destroyed.

    interface DestroyEvent {
      varName: string;
      line: number;
    }

    // Detect parent pointer associations: SomeWidget* child = new SomeWidget(parent)
    const parentOf = new Map<string, string>(); // child var → parent var

    const parentCtorRe = /\b(\w+)\s*=\s*new\s+\w+\s*\((\w+)(?:,|\))/g;
    for (const line of lines) {
      const m = parentCtorRe.exec(line);
      if (m) {
        parentOf.set(m[1], m[2]);
      }
      parentCtorRe.lastIndex = 0;
    }

    // Also detect setParent calls: child->setParent(parent)
    const setParentRe = /(\w+)\s*->\s*setParent\s*\(\s*(\w+)\s*\)/g;
    for (const line of lines) {
      const m = setParentRe.exec(line);
      if (m) {
        parentOf.set(m[1], m[2]);
      }
      setParentRe.lastIndex = 0;
    }

    // Find destroy events in order
    const destroyEvents: DestroyEvent[] = [];
    const destroyRe = /\bdelete\s+(\w+)|qt_widget_destroy\s*\(\s*(\w+)\s*\)|(\w+)\s*->\s*deleteLater\s*\(\)/g;

    lines.forEach((line, idx) => {
      let m: RegExpExecArray | null;
      destroyRe.lastIndex = 0;
      while ((m = destroyRe.exec(line)) !== null) {
        const varName = m[1] ?? m[2] ?? m[3];
        if (varName) {
          destroyEvents.push({ varName, line: idx + 1 });
        }
      }
    });

    // Check for double-free: if X is destroyed, and later a child of X is also destroyed
    const destroyedVars = new Set<string>();
    const destroyedParents = new Set<string>();

    for (const event of destroyEvents) {
      const v = event.varName;

      // Check if this var's parent was already destroyed (parent destroy includes children)
      const parent = parentOf.get(v);
      if (parent && destroyedParents.has(parent)) {
        issues.push({
          kind: 'double-free',
          severity: 'error',
          line: event.line,
          detail:
            `"${v}" is destroyed at line ${event.line}, but its parent "${parent}" was ` +
            `already destroyed earlier. Qt parent-destroy automatically destroys all children — ` +
            `this is a double-free that will crash with QBindingStorage::clear() or similar.`,
          fix:
            `Set ${v} = nullptr before destroying ${parent}, then guard: if (${v}) { qt_widget_destroy(${v}); }`,
        });
      }

      // If this is a parent being destroyed, note that its children are now gone
      destroyedParents.add(v);
      destroyedVars.add(v);
    }

    // Check for use-after-parent-destroy: accessing a child widget after its parent was destroyed
    for (const [child, parent] of parentOf) {
      const parentDestroy = destroyEvents.find((e) => e.varName === parent);
      const childUseRe = new RegExp(`\\b${child}\\b`, 'g');

      if (parentDestroy) {
        lines.forEach((line, idx) => {
          const lineNo = idx + 1;
          if (lineNo <= parentDestroy.line) return; // only after parent destroy
          // Skip destroy lines (already reported as double-free)
          if (destroyEvents.find((e) => e.line === lineNo && e.varName === child)) return;
          // Skip null-checks
          if (/if\s*\(.*null|nullptr|== null|!= null/.test(line.toLowerCase())) return;

          childUseRe.lastIndex = 0;
          if (childUseRe.test(line)) {
            issues.push({
              kind: 'use-after-parent-destroy',
              severity: 'warning',
              line: lineNo,
              detail:
                `"${child}" (child of "${parent}") is accessed at line ${lineNo} after ` +
                `"${parent}" was destroyed at line ${parentDestroy.line}. ` +
                `"${child}" may be a dangling pointer.`,
              fix: `Null-check ${child} before use, or set it to nullptr when destroying ${parent}.`,
            });
          }
        });
      }
    }
  }

  // ── Scheme FFI call sequence scanning ──────────────────────────────────

  if (filename.endsWith('.ss') || filename.endsWith('.scm')) {
    // Detect patterns like:
    // (qt-widget-destroy! parent)
    // ... later ...
    // (qt-widget-destroy! child)  ; double-free if child was created with parent as parent arg

    // Look for (qt-*-new parent-widget ...) patterns to infer parent→child
    const childCreation = new Map<string, string>(); // child binding → parent arg

    // (let ([child (qt-something-new parent ...)]) ...)
    // or (def child (qt-something-new parent ...))
    const schemeCtorRe = /\((?:let\s*\[\s*|def\s+)(\w[\w-]*)\s+\(qt-[\w-]+-new\s+(\w[\w-]*)/g;
    lines.forEach((line) => {
      let m: RegExpExecArray | null;
      schemeCtorRe.lastIndex = 0;
      while ((m = schemeCtorRe.exec(line)) !== null) {
        childCreation.set(m[1], m[2]);
      }
    });

    interface SchemeDestroyEvent {
      varName: string;
      line: number;
    }

    const schemeDestroys: SchemeDestroyEvent[] = [];
    const schemeDestroyRe = /\(qt-widget-destroy!\s+([\w-]+)/g;

    lines.forEach((line, idx) => {
      let m: RegExpExecArray | null;
      schemeDestroyRe.lastIndex = 0;
      while ((m = schemeDestroyRe.exec(line)) !== null) {
        schemeDestroys.push({ varName: m[1], line: idx + 1 });
      }
    });

    const schemeDestroyedParents = new Set<string>();
    for (const event of schemeDestroys) {
      const v = event.varName;
      const parent = childCreation.get(v);

      if (parent && schemeDestroyedParents.has(parent)) {
        issues.push({
          kind: 'double-free',
          severity: 'error',
          line: event.line,
          detail:
            `(qt-widget-destroy! ${v}) at line ${event.line}: ` +
            `"${v}" is a child of "${parent}" which was already destroyed. ` +
            `Qt parent destroy cascades to all children — double-free.`,
          fix: `Set ${v} to #f before destroying ${parent}, then guard: (when ${v} (qt-widget-destroy! ${v}))`,
        });
      }

      schemeDestroyedParents.add(v);
    }
  }

  return issues;
}

export function registerQtOwnershipLintTool(server: McpServer): void {
  server.registerTool(
    'jerboa_qt_ownership_lint',
    {
      title: 'Qt Parent-Child Ownership Lint',
      description:
        'Detect Qt parent-child double-free bugs in C++ shim code or Jerboa Scheme FFI call sequences. ' +
        'Qt QObject parent destruction automatically destroys all child widgets — explicitly ' +
        'destroying a child after its parent causes a double-free SIGSEGV (QBindingStorage::clear crash). ' +
        'Also detects child pointer use-after-parent-destroy. ' +
        'Works on .cpp/.h Qt shim files and .ss Scheme FFI files.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a .cpp, .h, or .ss file to scan'),
        code: z.string().optional().describe('Inline code to scan'),
        filename: z
          .string()
          .optional()
          .describe(
            'Filename hint for mode selection (e.g. "qt_shim.cpp" or "frames.ss") ' +
            'when using the code parameter',
          ),
      },
    },
    async ({ file_path, code, filename }) => {
      let source: string;
      let fname = filename ?? file_path ?? 'unknown.cpp';

      if (file_path) {
        try {
          source = await readFile(file_path, 'utf-8');
          fname = file_path;
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          return {
            content: [{ type: 'text' as const, text: `Cannot read file: ${msg}` }],
            isError: true,
          };
        }
      } else if (code) {
        source = code;
      } else {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or code.' }],
          isError: true,
        };
      }

      const issues = scanQtOwnership(source, fname);

      if (issues.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No Qt ownership issues detected in ${fname}.\n` +
                'Note: This is a heuristic scan based on naming patterns. ' +
                'Manual review is still recommended for complex ownership chains.',
            },
          ],
        };
      }

      const lines: string[] = [
        `Qt ownership lint: ${fname}`,
        `${issues.length} issue(s) found:`,
        '',
      ];

      for (const issue of issues) {
        const sev = issue.severity === 'error' ? '✗ ERROR' : '⚠ WARNING';
        lines.push(`${sev} [${issue.kind}]${issue.line ? ` line ${issue.line}` : ''}:`);
        lines.push(`  ${issue.detail}`);
        if (issue.fix) {
          lines.push(`  Fix: ${issue.fix}`);
        }
        lines.push('');
      }

      const hasErrors = issues.some((i) => i.severity === 'error');
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: hasErrors,
      };
    },
  );
}
