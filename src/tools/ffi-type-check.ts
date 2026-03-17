/**
 * jerboa_ffi_type_check — Detect type mismatches in Jerboa FFI declarations.
 * Analyzes foreign-procedure declarations and their call sites.
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

interface CallSite {
  procName: string;
  args: string[];
  line: number;
}

type IssueSeverity = 'ERROR' | 'WARNING';

interface TypeIssue {
  severity: IssueSeverity;
  line: number;
  message: string;
  suggestion: string;
}

/** Parse all foreign-procedure declarations in Scheme source. */
function parseForeignProcDecls(content: string): ForeignProcDecl[] {
  const decls: ForeignProcDecl[] = [];
  const lines = content.split('\n');

  // Pattern: (define NAME (foreign-procedure "C_NAME" (TYPES...) RETURN_TYPE))
  // May span multiple lines; do a basic single-line match first, then fallback
  const singleLineRe = /\(define\s+([\w\-!?*]+)\s+\(foreign-procedure\s+"([^"]+)"\s+\(([^)]*)\)\s+([\w\s*()?*\-]+?)\s*\)\s*\)/;
  const defineStartRe = /\(define\s+([\w\-!?*]+)\s+\(foreign-procedure/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try single-line match
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

    // Try multi-line: collect lines until balanced parens
    const startMatch = defineStartRe.exec(line);
    if (startMatch) {
      // Collect enough context (up to 10 lines)
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

/** Infer the "type class" of a call-site argument expression. */
function inferArgType(arg: string): string {
  const a = arg.trim();
  if (a.startsWith('(make-bytevector') || a.startsWith('(make-u8vector')) return 'bytevector';
  if (a.startsWith('(bytevector') || a.startsWith('(u8vector')) return 'bytevector';
  if (/^#u8\(/.test(a)) return 'bytevector';
  if (/^"/.test(a)) return 'string';
  if (/^-?\d+(\.\d+)?$/.test(a)) return a.includes('.') ? 'float' : 'integer';
  if (a === '#t' || a === '#f') return 'boolean';
  if (a.startsWith("'") || a.startsWith('(list') || a.startsWith('(cons')) return 'list';
  if (a.startsWith('(make-vector') || /^#\(/.test(a)) return 'vector';
  if (a.startsWith('(integer->address')) return 'address';
  if (a.startsWith('(utf8->string')) return 'string';
  return 'unknown';
}

/** Check compatibility between inferred arg type and declared FFI type. */
function checkTypeCompatibility(
  inferredType: string,
  declaredType: string,
  argIndex: number,
  procName: string,
  callLine: number,
): TypeIssue | null {
  const dt = declaredType.trim();

  if (inferredType === 'bytevector') {
    if (dt === 'string' || dt === '(* char)') {
      return {
        severity: 'WARNING',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': bytevector passed to '${dt}' parameter`,
        suggestion: `Use (utf8->string bv) to convert first, or use bytevector->u8* if available`,
      };
    }
    if (dt === 'integer-32' || dt === 'long' || dt === 'unsigned-32' || dt === 'size_t') {
      return {
        severity: 'ERROR',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': bytevector passed to integer type '${dt}'`,
        suggestion: `Bytevectors cannot be passed as integers; use bytevector-length or a pointer`,
      };
    }
  }

  if (inferredType === 'string') {
    if (dt === 'integer-32' || dt === 'unsigned-32' || dt === 'long' || dt === 'size_t') {
      return {
        severity: 'ERROR',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': string passed to integer type '${dt}'`,
        suggestion: `Strings cannot be passed as integers; use string-length or convert first`,
      };
    }
    if (dt === '(* void)' || dt === 'void*') {
      return {
        severity: 'WARNING',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': string passed to void pointer '${dt}'`,
        suggestion: `Strings are automatically converted in Chez FFI; verify encoding expectations`,
      };
    }
  }

  if (inferredType === 'integer') {
    if (dt === '(* void)' || dt === 'void*' || dt.startsWith('(*')) {
      return {
        severity: 'WARNING',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': integer passed to pointer type '${dt}'`,
        suggestion: `Use (integer->address n) to convert an integer to a pointer address`,
      };
    }
    if (dt === 'string' || dt === '(* char)') {
      return {
        severity: 'ERROR',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': integer passed to string/char* parameter '${dt}'`,
        suggestion: `Pass a proper string or char* pointer instead of a bare integer`,
      };
    }
  }

  if (inferredType === 'boolean') {
    if (
      dt === 'integer-32' || dt === 'long' || dt === 'unsigned-32' ||
      dt === 'string' || dt.startsWith('(*')
    ) {
      return {
        severity: 'WARNING',
        line: callLine,
        message: `Arg ${argIndex + 1} of '${procName}': boolean #t/#f passed to '${dt}' parameter`,
        suggestion: `Booleans in Chez FFI map to 1/#f=0 for integer types; verify intent`,
      };
    }
  }

  return null;
}

/** Extract call sites for known foreign procedures. */
function findCallSites(content: string, procNames: Set<string>): CallSite[] {
  const sites: CallSite[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip definitions of foreign-procedure
    if (line.includes('foreign-procedure')) continue;
    if (line.trim().startsWith(';')) continue;

    for (const name of procNames) {
      // Match (name arg1 arg2 ...) — basic single-line call detection
      const callRe = new RegExp(`\\(${escapeRegex(name)}\\s+([^)]+)\\)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(line)) !== null) {
        // Split args naively by whitespace (doesn't handle nested expressions well)
        const rawArgs = m[1].trim();
        const args = splitArgs(rawArgs);
        sites.push({ procName: name, args, line: i + 1 });
      }
    }
  }

  return sites;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\-');
}

/** Split a flat argument string into individual arg tokens (naive, no nesting). */
function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of raw) {
    if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ' ' && depth === 0) {
      if (current.trim()) {
        args.push(current.trim());
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

export function registerFfiTypeCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_ffi_type_check',
    {
      title: 'FFI Type Check',
      description:
        'Detect type mismatches in Jerboa FFI declarations. ' +
        'Analyzes foreign-procedure declarations and their call sites, ' +
        'flagging known incompatible type combinations (e.g. bytevector passed to (* char), ' +
        'string passed to integer-32).',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z.string().describe('Path to the Scheme source file to analyze'),
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

      if (decls.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `FFI Type Check: ${shortName}\n\nNo foreign-procedure declarations found.`,
          }],
        };
      }

      const declMap = new Map<string, ForeignProcDecl>(decls.map((d) => [d.schemeName, d]));
      const procNames = new Set<string>(decls.map((d) => d.schemeName));
      const callSites = findCallSites(content, procNames);

      const issues: TypeIssue[] = [];

      for (const site of callSites) {
        const decl = declMap.get(site.procName);
        if (!decl) continue;

        for (let i = 0; i < site.args.length; i++) {
          const expectedType = decl.argTypes[i];
          if (!expectedType) continue;
          const inferred = inferArgType(site.args[i]);
          const issue = checkTypeCompatibility(
            inferred,
            expectedType,
            i,
            site.procName,
            site.line,
          );
          if (issue) issues.push(issue);
        }
      }

      if (issues.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `FFI Type Check: ${shortName}\n\nNo FFI type issues found.`,
          }],
        };
      }

      const lines: string[] = [
        `FFI Type Check: ${shortName}`,
        '',
        `Issues found: ${issues.length}`,
        '',
      ];

      // Sort by line number
      issues.sort((a, b) => a.line - b.line);

      for (const issue of issues) {
        lines.push(`${issue.severity} line ${issue.line}: ${issue.message}`);
        lines.push(`  → ${issue.suggestion}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
        isError: issues.some((i) => i.severity === 'ERROR'),
      };
    },
  );
}
