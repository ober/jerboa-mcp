/**
 * jerboa_ffi_null_safety — Find foreign-procedure pointer parameters
 * that are dereferenced without null checks.
 * Pure TypeScript, no subprocess.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

interface ForeignProcDecl {
  schemeName: string;
  cName: string;
  argTypes: string[];
  returnType: string;
  line: number;
}

interface WrapperFunction {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  callsProc: string;
  callLine: number;
}

interface NullSafetyIssue {
  wrapperName: string;
  procName: string;
  pointerType: string;
  line: number;
  suggestion: string;
}

/** Returns true if a type is a pointer type. */
function isPointerType(t: string): boolean {
  const trimmed = t.trim();
  return (
    trimmed.startsWith('(*') ||
    trimmed === '(* void)' ||
    trimmed.endsWith('*') ||
    trimmed === 'void*' ||
    trimmed === '(* char)' ||
    trimmed === 'string'    // char* / const char* maps to string but still pointer
  );
}

/** Parse foreign-procedure declarations from Scheme source. */
function parseForeignProcDecls(content: string): ForeignProcDecl[] {
  const decls: ForeignProcDecl[] = [];
  const lines = content.split('\n');

  const singleLineRe =
    /\(define\s+([\w\-!?*]+)\s+\(foreign-procedure\s+"([^"]+)"\s+\(([^)]*)\)\s+([\w\s*()?*\-]+?)\s*\)\s*\)/;
  const defineStartRe = /\(define\s+([\w\-!?*]+)\s+\(foreign-procedure/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const single = singleLineRe.exec(line);
    if (single) {
      const argTypes = single[3].trim() ? single[3].trim().split(/\s+/).filter(Boolean) : [];
      decls.push({
        schemeName: single[1],
        cName: single[2],
        argTypes,
        returnType: single[4].trim(),
        line: i + 1,
      });
      continue;
    }

    const startMatch = defineStartRe.exec(line);
    if (startMatch) {
      const chunk = lines.slice(i, Math.min(i + 10, lines.length)).join(' ');
      const multi = singleLineRe.exec(chunk);
      if (multi) {
        const argTypes = multi[3].trim() ? multi[3].trim().split(/\s+/).filter(Boolean) : [];
        decls.push({
          schemeName: multi[1],
          cName: multi[2],
          argTypes,
          returnType: multi[4].trim(),
          line: i + 1,
        });
      }
    }
  }

  return decls;
}

/**
 * Extract wrapper function bodies that call the given foreign procedures.
 * Looks for (define (wrapper-name ...) body...) patterns.
 */
function findWrappers(content: string, procNames: Set<string>): WrapperFunction[] {
  const wrappers: WrapperFunction[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Look for (define (name ...) ...)
    const defMatch = line.match(/^\(define\s+\(([\w\-!?*]+)/);
    if (!defMatch) continue;

    const wrapperName = defMatch[1];

    // Collect the entire function body by counting parens
    let depth = 0;
    let body = '';
    let endLine = i;
    let callLine = -1;
    let callsProc = '';

    for (let j = i; j < Math.min(i + 50, lines.length); j++) {
      const bodyLine = lines[j];
      body += bodyLine + '\n';

      for (const ch of bodyLine) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }

      // Check if this line calls any of our foreign procs
      if (j > i) {
        for (const name of procNames) {
          if (bodyLine.includes(`(${name}`) || bodyLine.includes(`(${name} `) ||
              bodyLine.includes(`(${name})`)) {
            if (callLine === -1) {
              callLine = j + 1;
              callsProc = name;
            }
          }
        }
      }

      if (depth === 0 && j > i) {
        endLine = j;
        break;
      }
    }

    if (callLine > 0) {
      wrappers.push({
        name: wrapperName,
        startLine: i + 1,
        endLine,
        body,
        callsProc,
        callLine,
      });
    }
  }

  return wrappers;
}

/**
 * Check if a function body contains null guard patterns before calling a proc.
 * Looks for: (when ptr ...), (if ptr ...), (assert ptr), (unless (eq? ptr #f) ...)
 */
function hasNullGuard(body: string): boolean {
  // (when VAR ...)
  if (/\(when\s+[\w\-!?*]+/.test(body)) return true;
  // (if VAR ...)
  if (/\(if\s+[\w\-!?*]+\s/.test(body)) return true;
  // (assert VAR)
  if (/\(assert\s+[\w\-!?*]+\)/.test(body)) return true;
  // (unless (eq? VAR #f) ...)
  if (/\(unless\s+\(eq\?/.test(body)) return true;
  // (unless (not VAR) ...)
  if (/\(unless\s+\(not/.test(body)) return true;
  // (and VAR ...)
  if (/\(and\s+[\w\-!?*]+/.test(body)) return true;
  // (cond [VAR ...] ...)
  if (/\(cond\s+\[[\w\-!?*]+/.test(body)) return true;
  // explicit #f check: (eq? ptr #f)
  if (/\(eq\?\s+[\w\-!?*]+\s+#f\)/.test(body)) return true;
  if (/\(not\s+[\w\-!?*]+\)/.test(body)) return true;

  return false;
}

export function registerFfiNullSafetyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_ffi_null_safety',
    {
      title: 'FFI Null Safety',
      description:
        'Find foreign-procedure pointer parameters that are dereferenced without null checks. ' +
        'Static analysis of .ss/.sls FFI files. ' +
        'Reports pointer parameters without guard/when null checks.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z.string().describe('Path to the Scheme source file (.ss or .sls) to analyze'),
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
      const decls = parseForeignProcDecls(content);

      // Only care about procs that have pointer-type parameters
      const pointerProcs = decls.filter((d) => d.argTypes.some(isPointerType));

      if (pointerProcs.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `FFI Null Safety: ${shortName}\n\nNo foreign-procedure declarations with pointer parameters found.`,
          }],
        };
      }

      const procNames = new Set<string>(pointerProcs.map((d) => d.schemeName));
      const wrappers = findWrappers(content, procNames);

      if (wrappers.length === 0) {
        // Foreign procs with pointer params exist but no Scheme wrappers found
        // Still report the raw procs as potential issues
        const issues: NullSafetyIssue[] = pointerProcs.map((d) => {
          const pointerTypes = d.argTypes.filter(isPointerType);
          return {
            wrapperName: d.schemeName,
            procName: d.cName,
            pointerType: pointerTypes[0],
            line: d.line,
            suggestion: `Consider wrapping '${d.schemeName}' and adding: (when ptr ...)`,
          };
        });

        const lines: string[] = [
          `FFI Null Safety: ${shortName}`,
          '',
          `WARNING: ${issues.length} foreign procedure(s) with pointer parameters have no wrapper functions`,
          '',
        ];
        for (const issue of issues) {
          lines.push(`WARNING: '${issue.wrapperName}' has pointer parameter '${issue.pointerType}' with no null guard wrapper`);
          lines.push(`  → ${issue.suggestion}`);
          lines.push('');
        }
        return {
          content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
        };
      }

      const issues: NullSafetyIssue[] = [];

      for (const wrapper of wrappers) {
        const decl = pointerProcs.find((d) => d.schemeName === wrapper.callsProc);
        if (!decl) continue;

        const pointerTypes = decl.argTypes.filter(isPointerType);
        if (pointerTypes.length === 0) continue;

        if (!hasNullGuard(wrapper.body)) {
          issues.push({
            wrapperName: wrapper.name,
            procName: wrapper.callsProc,
            pointerType: pointerTypes[0],
            line: wrapper.callLine,
            suggestion:
              `Add: (when ptr (${wrapper.callsProc} ptr ...)) or ` +
              `(unless (eq? ptr #f) ...)`,
          });
        }
      }

      if (issues.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `FFI Null Safety: ${shortName}\n\nNo null safety issues found.`,
          }],
        };
      }

      const lines: string[] = [
        `FFI Null Safety: ${shortName}`,
        '',
      ];

      for (const issue of issues) {
        lines.push(
          `WARNING: '${issue.wrapperName}' calls '${issue.procName}' with pointer param ` +
          `'${issue.pointerType}' but no null check found`,
        );
        lines.push(`  → ${issue.suggestion}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
      };
    },
  );
}
