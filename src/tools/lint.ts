import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  parseDefinitions,
  extractModulePaths,
  type FileAnalysis,
} from './parse-utils.js';

interface LintDiagnostic {
  line: number | null;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

const COMMON_STDLIB = new Set([
  'map',
  'filter',
  'fold',
  'for-each',
  'apply',
  'append',
  'cons',
  'car',
  'cdr',
  'list',
  'length',
  'reverse',
  'sort',
  'display',
  'newline',
  'write',
  'read',
  'string-append',
  'number->string',
  'string->number',
  'not',
  'error',
  'raise',
  'values',
  'call-with-values',
  'begin',
  'vector',
  'string',
  'number?',
  'string?',
  'pair?',
  'null?',
  'boolean?',
  'symbol?',
  'vector?',
  'procedure?',
  'equal?',
  'eq?',
  'eqv?',
]);

export function registerLintTool(server: McpServer): void {
  server.registerTool(
    'jerboa_lint',
    {
      title: 'Basic Linting',
      description:
        'Static analysis for common Jerboa/Chez issues: unused imports, duplicate definitions, ' +
        'style warnings (define vs def), shadowed standard bindings, ' +
        'hash literal symbol key warnings, pitfall detection (unquote outside quasiquote, ' +
        'dot in brackets), missing exported definitions, ' +
        'unsafe resource patterns without unwind-protect, ' +
        'and char/byte I/O mixing on the same port.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z
          .string()
          .describe('Absolute path to a Jerboa source file to lint'),
      },
    },
    async ({ file_path }) => {
      let content: string;
      try {
        content = await readFile(file_path, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [
            { type: 'text' as const, text: `Failed to read file: ${msg}` },
          ],
          isError: true,
        };
      }

      const diagnostics: LintDiagnostic[] = [];
      const analysis = parseDefinitions(content);
      const lines = content.split('\n');

      checkUnusedImports(content, analysis, diagnostics);
      checkDuplicateDefinitions(analysis, diagnostics);
      checkStyleIssues(lines, diagnostics);
      checkShadowedBindings(analysis, diagnostics);
      checkHashLiteralKeys(lines, diagnostics);
      checkUnquoteOutsideQuasiquote(lines, diagnostics);
      checkDotInBrackets(lines, diagnostics);
      checkMissingExportedDefinitions(analysis, diagnostics);
      checkUnsafeResourcePattern(lines, diagnostics);
      checkCharByteIOMixing(lines, diagnostics);
      checkMacroSuggestions(lines, diagnostics);

      if (diagnostics.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No issues found in ${file_path}.`,
            },
          ],
        };
      }

      const sevOrder: Record<string, number> = {
        error: 0,
        warning: 1,
        info: 2,
      };
      diagnostics.sort((a, b) => {
        const sa = sevOrder[a.severity] ?? 3;
        const sb = sevOrder[b.severity] ?? 3;
        if (sa !== sb) return sa - sb;
        return (a.line ?? 0) - (b.line ?? 0);
      });

      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');
      const infos = diagnostics.filter((d) => d.severity === 'info');

      const sections: string[] = [
        `Lint: ${file_path}`,
        `  ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`,
        '',
      ];

      for (const d of diagnostics) {
        const loc = d.line ? `L${d.line}` : '---';
        sections.push(
          `  [${d.severity.toUpperCase()}] ${loc} (${d.code}): ${d.message}`,
        );
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
        isError: errors.length > 0,
      };
    },
  );
}

function checkUnusedImports(
  content: string,
  analysis: FileAnalysis,
  diagnostics: LintDiagnostic[],
): void {
  const contentLines = content.split('\n');

  for (const imp of analysis.imports) {
    const modPaths = extractModulePaths(imp.raw);
    for (const modPath of modPaths) {
      if (modPath.startsWith('./')) continue;

      const lastSeg = modPath.split('/').pop() || '';
      if (!lastSeg) continue;

      const afterImport = contentLines.slice(imp.line).join('\n');
      if (!afterImport.includes(lastSeg) && !afterImport.includes(modPath)) {
        diagnostics.push({
          line: imp.line,
          severity: 'warning',
          code: 'possibly-unused-import',
          message: `Import ${modPath} may be unused`,
        });
      }
    }
  }
}

function checkDuplicateDefinitions(
  analysis: FileAnalysis,
  diagnostics: LintDiagnostic[],
): void {
  const seen = new Map<string, number>();
  for (const def of analysis.definitions) {
    if (seen.has(def.name)) {
      diagnostics.push({
        line: def.line,
        severity: 'warning',
        code: 'duplicate-definition',
        message: `"${def.name}" already defined at line ${seen.get(def.name)}`,
      });
    } else {
      seen.set(def.name, def.line);
    }
  }
}

function checkStyleIssues(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const lineNum = i + 1;

    if (trimmed.startsWith(';')) continue;

    // Prefer def over define (in Jerboa/Gerbil-style code)
    if (trimmed.startsWith('(define ') && !trimmed.startsWith('(define-')) {
      diagnostics.push({
        line: lineNum,
        severity: 'info',
        code: 'style-prefer-def',
        message: 'Consider "def" over "define" (Jerboa prelude provides def with optional/keyword args)',
      });
    }

    // defstruct without transparent:
    if (trimmed.startsWith('(defstruct ') && !trimmed.includes('transparent:')) {
      const lookAhead = lines
        .slice(i, Math.min(i + 5, lines.length))
        .join(' ');
      if (!lookAhead.includes('transparent:')) {
        diagnostics.push({
          line: lineNum,
          severity: 'info',
          code: 'style-missing-transparent',
          message:
            'Consider adding transparent: #t to defstruct for debugging/printing',
        });
      }
    }
  }
}

function checkShadowedBindings(
  analysis: FileAnalysis,
  diagnostics: LintDiagnostic[],
): void {
  for (const def of analysis.definitions) {
    if (COMMON_STDLIB.has(def.name)) {
      diagnostics.push({
        line: def.line,
        severity: 'warning',
        code: 'shadowed-binding',
        message: `"${def.name}" shadows a common standard binding`,
      });
    }
  }
}

function extractFormFromLines(lines: string[], startIdx: number): string {
  let depth = 0;
  let result = '';
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    result += (i > startIdx ? '\n' : '') + line;
    for (const ch of line) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
    }
    if (depth <= 0 && result.includes('(')) break;
  }
  return result;
}

function extractHashEntries(form: string): string[] {
  const keys: string[] = [];
  const start = form.indexOf('(hash');
  if (start === -1) return keys;
  let pos = start + 5;
  const len = form.length;

  while (pos < len) {
    const ch = form[pos];
    if (/\s/.test(ch)) { pos++; continue; }
    if (ch === ')') break;
    if (ch === '(') {
      pos++;
      while (pos < len && /\s/.test(form[pos])) pos++;
      const keyStart = pos;
      while (pos < len && !/[\s()]/.test(form[pos])) pos++;
      const key = form.slice(keyStart, pos);
      if (key.length > 0) keys.push(key);
      let depth = 1;
      while (pos < len && depth > 0) {
        if (form[pos] === '(' || form[pos] === '[') depth++;
        else if (form[pos] === ')' || form[pos] === ']') depth--;
        if (form[pos] === '"') {
          pos++;
          while (pos < len && form[pos] !== '"') {
            if (form[pos] === '\\') pos++;
            pos++;
          }
        }
        pos++;
      }
    } else {
      pos++;
    }
  }
  return keys;
}

function isBareIdentifier(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith('"')) return false;
  if (/^-?[0-9]/.test(token)) return false;
  if (token === '#t' || token === '#f') return false;
  if (token.endsWith(':')) return false;
  if (token.startsWith('#\\')) return false;
  if (token.startsWith("'")) return false;
  return true;
}

function checkHashLiteralKeys(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const lineNum = i + 1;

    if (trimmed.startsWith(';')) continue;
    if (!trimmed.match(/^\(hash[\s\n)]/)) continue;

    const form = extractFormFromLines(lines, i);
    const keys = extractHashEntries(form);
    for (const key of keys) {
      if (isBareIdentifier(key)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          code: 'hash-symbol-key',
          message:
            `Hash literal uses bare symbol key '${key}' — this creates a symbol key, not a string. ` +
            `Use ("${key}" ...) for string keys, or use equal? hashtable for intentional symbol keys.`,
        });
      }
    }
  }
}

function checkUnquoteOutsideQuasiquote(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  let qqDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trimStart();

    if (trimmed.startsWith(';')) continue;

    let inString = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"' && (j === 0 || line[j - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === ';') break;
      if (ch === '`') {
        qqDepth++;
      } else if (ch === ',' && qqDepth > 0) {
        qqDepth--;
      }
    }

    if (trimmed.startsWith('(') && !trimmed.startsWith('(`') && qqDepth > 0) {
      if (
        /^\((def\b|defstruct|defclass|defmethod|defrules?|defsyntax|export|import)/.test(
          trimmed,
        )
      ) {
        qqDepth = 0;
      }
    }

    inString = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      if (ch === '"' && (j === 0 || line[j - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === ';') break;

      if (ch === ',') {
        const leftOk = j === 0 || /[\s([\]{}'`]/.test(line[j - 1]);
        if (!leftOk) continue;

        const rest = line.slice(j + 1).trimStart();
        if (!rest || rest.startsWith(';')) continue;

        let inQQ = false;
        for (let k = j - 1; k >= 0; k--) {
          if (line[k] === '`') {
            inQQ = true;
            break;
          }
        }

        if (!inQQ && qqDepth <= 0) {
          let foundQQ = false;
          for (let back = i - 1; back >= Math.max(0, i - 20); back--) {
            const prevLine = lines[back].trimStart();
            if (prevLine.startsWith(';')) continue;
            if (
              /^\((def\b|defstruct|defclass|defmethod|defrules?|defsyntax|export|import)/.test(
                prevLine,
              )
            ) {
              break;
            }
            if (prevLine.includes('`')) {
              foundQQ = true;
              break;
            }
          }

          if (!foundQQ) {
            const snippet = line.slice(j, Math.min(j + 20, line.length));
            diagnostics.push({
              line: lineNum,
              severity: 'warning',
              code: 'unquote-outside-quasiquote',
              message:
                `Unquote "${snippet.trim()}" appears outside quasiquote context. ` +
                'Did you mean to use a backtick ` template?',
            });
          }
        }
      }
    }
  }
}

function checkDotInBrackets(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trimStart();

    if (trimmed.startsWith(';')) continue;
    if (!line.includes('[') || !line.includes('. ')) continue;

    let inString = false;
    let bracketDepth = 0;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      if (ch === '"' && (j === 0 || line[j - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === ';') break;

      if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']') {
        bracketDepth--;
      } else if (
        ch === '.' &&
        bracketDepth > 0 &&
        j + 1 < line.length &&
        line[j + 1] === ' '
      ) {
        const leftOk = j === 0 || /[\s([\]{}]/.test(line[j - 1]);
        if (leftOk) {
          diagnostics.push({
            line: lineNum,
            severity: 'warning',
            code: 'dot-in-brackets',
            message:
              'Dotted pair inside [...] brackets. ' +
              '[] is list sugar, not cons syntax. ' +
              'Use (a . b) with parentheses for dotted pairs, or [a b] for a list.',
          });
          break;
        }
      }
    }
  }
}

function checkMissingExportedDefinitions(
  analysis: FileAnalysis,
  diagnostics: LintDiagnostic[],
): void {
  const definedNames = new Set(analysis.definitions.map((d) => d.name));

  const importTokens = new Set<string>();
  let hasBareModuleImports = false;
  for (const imp of analysis.imports) {
    const tokens = imp.raw.match(/[a-zA-Z_!?<>=+\-*/][a-zA-Z0-9_!?<>=+\-*/.:~#]*/g);
    if (tokens) {
      for (const t of tokens) {
        if (!['import', 'only-in', 'except-out', 'rename-in', 'rename-out',
               'prefix-in', 'prefix-out', 'struct-out', 'group-in'].includes(t)) {
          importTokens.add(t);
        }
      }
    }
    const modPaths = extractModulePaths(imp.raw);
    if (modPaths.length > 0 && !imp.raw.includes('only-in')) {
      hasBareModuleImports = true;
    }
  }

  for (const exp of analysis.exports) {
    const raw = exp.raw;

    if (raw.includes('#t')) continue;

    const inner = raw
      .replace(/^\s*\(export\s+/, '')
      .replace(/\)\s*$/, '')
      .trim();

    if (!inner) continue;

    let pos = 0;
    while (pos < inner.length) {
      while (pos < inner.length && /\s/.test(inner[pos])) pos++;
      if (pos >= inner.length) break;

      if (inner[pos] === '(') {
        let depth = 1;
        pos++;
        while (pos < inner.length && depth > 0) {
          if (inner[pos] === '(') depth++;
          else if (inner[pos] === ')') depth--;
          pos++;
        }
      } else {
        const start = pos;
        while (pos < inner.length && !/[\s()[\]{}]/.test(inner[pos])) pos++;
        const sym = inner.slice(start, pos);

        if (sym.startsWith(';')) continue;
        if (sym && sym !== '#t' && sym !== '#f' && !definedNames.has(sym)) {
          if (importTokens.has(sym)) continue;
          if (hasBareModuleImports) continue;

          diagnostics.push({
            line: exp.line,
            severity: 'warning',
            code: 'missing-exported-definition',
            message: `Exports "${sym}" but no definition found in this file`,
          });
        }
      }
    }
  }
}

/**
 * Detect open-input-file/open-output-file without dynamic-wind or guard/unwind-protect.
 */
function checkUnsafeResourcePattern(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  const defBoundary = /^\s*\(\s*(def\b|def\*|defmethod|defclass|defstruct)/;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const lineNum = i + 1;

    if (trimmed.startsWith(';')) continue;

    const hasOpenFile = trimmed.includes('open-input-file') || trimmed.includes('open-output-file');
    if (!hasOpenFile) continue;

    // Check it's not inside a string or comment
    const keyword = trimmed.includes('open-input-file') ? 'open-input-file' : 'open-output-file';
    const idx = trimmed.indexOf(keyword);
    const before = trimmed.slice(0, idx);
    if (before.includes(';')) continue;
    const quoteCount = (before.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) continue;

    // Scan backward for unwind-protect or call-with-*
    let protected_ = false;
    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      const prev = lines[j].trimStart();
      if (defBoundary.test(prev) && j < i) break;
      if (prev.includes('unwind-protect') || prev.includes('dynamic-wind') ||
          prev.includes('call-with-port') || prev.includes('call-with-input-file') ||
          prev.includes('call-with-output-file') || prev.includes('with-input-from-file') ||
          prev.includes('with-output-to-file')) {
        protected_ = true;
        break;
      }
    }

    if (!protected_) {
      // Also scan forward briefly
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        if (defBoundary.test(lines[j])) break;
        if (lines[j].includes('unwind-protect') || lines[j].includes('dynamic-wind')) {
          protected_ = true;
          break;
        }
      }
    }

    if (!protected_) {
      diagnostics.push({
        line: lineNum,
        severity: 'warning',
        code: 'open-file-no-unwind-protect',
        message:
          `${keyword} without unwind-protect or call-with-port. ` +
          'If an exception occurs, the port will not be closed. ' +
          'Use call-with-port, call-with-input-file, or wrap with (unwind-protect ... (close-port p)).',
      });
    }
  }
}

function checkCharByteIOMixing(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  const CHAR_IO_FUNCTIONS = new Set([
    'display', 'write', 'write-char', 'read-char',
    'read-line', 'newline', 'pretty-print',
    'write-string', 'read-string', 'read',
  ]);

  const BYTE_IO_FUNCTIONS = new Set([
    'read-bytevector', 'write-bytevector', 'read-u8', 'write-u8',
    'get-u8', 'put-u8', 'get-bytevector-n', 'put-bytevector',
  ]);

  const defBoundary = /^\s*\(\s*(def\b|def\*|defmethod|defclass|defstruct)/;

  const scopes = new Map<number, Map<string, Array<{line: number; type: 'char' | 'byte'; fn: string}>>>();
  let currentScopeStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const lineNum = i + 1;

    if (trimmed.startsWith(';')) continue;

    if (defBoundary.test(trimmed)) {
      currentScopeStart = i;
      scopes.set(currentScopeStart, new Map());
    }

    const scopeMap = scopes.get(currentScopeStart);
    if (!scopeMap) continue;

    for (const fn of CHAR_IO_FUNCTIONS) {
      if (trimmed.includes(fn)) {
        const fnIdx = trimmed.indexOf(fn);
        const leftOk = fnIdx === 0 || /[\s([\]{}'`,;]/.test(trimmed[fnIdx - 1]);
        const rightIdx = fnIdx + fn.length;
        const rightOk = rightIdx >= trimmed.length || /[\s)[\]{}'`,;]/.test(trimmed[rightIdx]);
        if (leftOk && rightOk) {
          const vars = trimmed.match(/\b[a-zA-Z_][-a-zA-Z0-9_]*/g) || [];
          for (const v of vars) {
            if (v === fn || v === 'let' || v === 'def' || v === 'lambda') continue;
            if (!scopeMap.has(v)) scopeMap.set(v, []);
            scopeMap.get(v)!.push({line: lineNum, type: 'char', fn});
          }
          break;
        }
      }
    }

    for (const fn of BYTE_IO_FUNCTIONS) {
      if (trimmed.includes(fn)) {
        const fnIdx = trimmed.indexOf(fn);
        const leftOk = fnIdx === 0 || /[\s([\]{}'`,;]/.test(trimmed[fnIdx - 1]);
        const rightIdx = fnIdx + fn.length;
        const rightOk = rightIdx >= trimmed.length || /[\s)[\]{}'`,;]/.test(trimmed[rightIdx]);
        if (leftOk && rightOk) {
          const vars = trimmed.match(/\b[a-zA-Z_][-a-zA-Z0-9_]*/g) || [];
          for (const v of vars) {
            if (v === fn || v === 'let' || v === 'def' || v === 'lambda') continue;
            if (!scopeMap.has(v)) scopeMap.set(v, []);
            scopeMap.get(v)!.push({line: lineNum, type: 'byte', fn});
          }
          break;
        }
      }
    }
  }

  for (const [_scopeLine, varMap] of scopes) {
    for (const [varName, usages] of varMap) {
      const charUsages = usages.filter(u => u.type === 'char');
      const byteUsages = usages.filter(u => u.type === 'byte');

      if (charUsages.length > 0 && byteUsages.length > 0) {
        const charUsage = charUsages[0];
        const byteUsage = byteUsages[0];

        diagnostics.push({
          line: Math.min(charUsage.line, byteUsage.line),
          severity: 'error',
          code: 'char-byte-io-mixing',
          message:
            `Port variable "${varName}" uses both character I/O (${charUsage.fn} at L${charUsage.line}) ` +
            `and byte I/O (${byteUsage.fn} at L${byteUsage.line}). ` +
            'Mixing char and byte I/O on the same port is not safe. ' +
            'Use only char I/O or only byte I/O on a given port.',
        });
      }
    }
  }
}

function checkMacroSuggestions(
  lines: string[],
  diagnostics: LintDiagnostic[],
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const lineNum = i + 1;

    if (trimmed.startsWith(';')) continue;

    // Suggest when/unless for (if cond expr (void))
    if (trimmed.match(/\(if\s+\S+\s+\S+\s+\(void\)/)) {
      diagnostics.push({
        line: lineNum,
        severity: 'info',
        code: 'suggest-when',
        message: 'Consider using "when" instead of (if cond expr (void)): (when cond expr)',
      });
    }

    // Suggest let* for nested let
    if (trimmed.match(/\(let\s+\(\(/)) {
      const lookAhead = lines.slice(i, Math.min(i + 10, lines.length)).join('\n');
      const nestedLetCount = (lookAhead.match(/\(let\s+\(\(/g) || []).length;
      if (nestedLetCount >= 2) {
        diagnostics.push({
          line: lineNum,
          severity: 'info',
          code: 'suggest-let-star',
          message: 'Consider using "let*" for sequential bindings: (let* ((a expr1) (b (use-a a))) ...)',
        });
      }
    }

    // Suggest guard for begin + error handling
    if (trimmed.match(/\(begin\s/) && lines.slice(i, Math.min(i + 10, lines.length)).some(l => l.includes('error') || l.includes('raise'))) {
      // Only suggest if not already using guard
      const lookAhead = lines.slice(Math.max(0, i - 5), i + 10).join('\n');
      if (!lookAhead.includes('guard') && !lookAhead.includes('with-exception-handler')) {
        diagnostics.push({
          line: lineNum,
          severity: 'info',
          code: 'suggest-guard',
          message: 'Consider using "guard" for structured exception handling: (guard (e [condition? e] ...) body ...)',
        });
      }
    }
  }
}
