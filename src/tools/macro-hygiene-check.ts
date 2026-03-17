/**
 * jerboa_macro_hygiene_check — Detect free variable capture in
 * defrule/define-syntax/syntax-rules macro definitions.
 * Pure TypeScript, no subprocess.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

type IssueSeverity = 'WARNING' | 'INFO';

interface HygieneIssue {
  severity: IssueSeverity;
  macroName: string;
  line: number;
  message: string;
  suggestion: string;
}

interface MacroDef {
  name: string;
  kind: 'defrule' | 'define-syntax' | 'syntax-rules';
  line: number;
  literals: string[];
  patterns: string[][];   // one entry per rule/clause
  templates: string[][];  // one entry per rule/clause
  body: string;
}

/** Common "suspicious" helper variable names likely to cause captures. */
const CAPTURE_PRONE_NAMES = new Set([
  'result', 'tmp', 'temp', 'x', 'y', 'z', 'i', 'j', 'k',
  'loop', 'val', 'value', 'acc', 'accum', 'iter', 'item',
  'lst', 'list', 'head', 'tail', 'rest', 'body', 'expr',
  'n', 'v', 'e', 'err', 'obj', 'args', 'arg', 'ret',
]);

/** Extract all symbols (atom identifiers) from a Scheme expression string. */
function extractSymbols(expr: string): Set<string> {
  const syms = new Set<string>();
  // Match identifiers: starts with letter, !, ?, _, then alphanumeric + special chars
  const re = /[a-zA-Z!?_\-+*/<=>&|][a-zA-Z0-9!?_\-+*/<=>&|]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const sym = m[0];
    // Skip Scheme keywords/literals that aren't identifiers
    if (sym !== '#t' && sym !== '#f' && sym !== '#void') {
      syms.add(sym);
    }
  }
  return syms;
}

/**
 * Parse a syntax-rules clause: ((pattern ...) template)
 * Returns [patternSymbols, templateSymbols] or null if unparseable.
 */
function parseSyntaxRulesClause(
  clause: string,
): { patternSyms: string[]; templateStr: string } | null {
  // Very rough: find first balanced (pattern) then rest is template
  let depth = 0;
  let patternEnd = -1;

  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === '(') depth++;
    if (clause[i] === ')') {
      depth--;
      if (depth === 0) {
        patternEnd = i;
        break;
      }
    }
  }

  if (patternEnd < 0) return null;

  const patternPart = clause.slice(0, patternEnd + 1);
  const templatePart = clause.slice(patternEnd + 1).trim();
  const patternSyms = Array.from(extractSymbols(patternPart));

  return { patternSyms, templateStr: templatePart };
}

/**
 * Extract macro definitions from source content.
 * Handles:
 * - (defrule name (pattern) template)
 * - (define-syntax name (syntax-rules (literals) [clauses...]))
 */
function parseMacroDefs(content: string): MacroDef[] {
  const defs: MacroDef[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments
    if (line.startsWith(';')) continue;

    // ── defrule ──────────────────────────────────────────────────
    // (defrule NAME (PATTERN) TEMPLATE)
    const defruleMatch = line.match(/^\(defrule\s+([\w\-!?*+<=>]+)/);
    if (defruleMatch) {
      const macroName = defruleMatch[1];

      // Collect body: defrule is typically on one or a few lines
      const chunk = lines.slice(i, Math.min(i + 10, lines.length)).join('\n');
      // Pattern: (defrule name (PATTERN) TEMPLATE)
      const fullMatch = chunk.match(
        /\(defrule\s+([\w\-!?*+<=>]+)\s+(\([^)]*\))\s+(.+?)\s*\)\s*$/s,
      );

      if (fullMatch) {
        const patternSyms = Array.from(extractSymbols(fullMatch[2]));
        const templateStr = fullMatch[3];
        defs.push({
          name: macroName,
          kind: 'defrule',
          line: i + 1,
          literals: [],
          patterns: [patternSyms],
          templates: [Array.from(extractSymbols(templateStr))],
          body: chunk,
        });
      } else {
        // Simpler: just record name + line for basic analysis
        const bodyLines = lines.slice(i, Math.min(i + 15, lines.length));
        defs.push({
          name: macroName,
          kind: 'defrule',
          line: i + 1,
          literals: [],
          patterns: [],
          templates: [],
          body: bodyLines.join('\n'),
        });
      }
      continue;
    }

    // ── define-syntax ─────────────────────────────────────────────
    // (define-syntax NAME (syntax-rules (LITERALS) [CLAUSES...]))
    const defineSyntaxMatch = line.match(/^\(define-syntax\s+([\w\-!?*+<=>]+)/);
    if (defineSyntaxMatch) {
      const macroName = defineSyntaxMatch[1];

      // Collect the full definition body
      let depth = 0;
      const bodyLines: string[] = [];
      let j = i;
      for (; j < Math.min(i + 50, lines.length); j++) {
        const bodyLine = lines[j];
        bodyLines.push(bodyLine);
        for (const ch of bodyLine) {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
        }
        if (depth === 0 && j > i) break;
      }

      const fullBody = bodyLines.join('\n');

      // Extract literals from syntax-rules
      const literalsMatch = fullBody.match(/\(syntax-rules\s+\(([^)]*)\)/);
      const literals = literalsMatch
        ? literalsMatch[1].trim().split(/\s+/).filter(Boolean)
        : [];

      // Extract clauses: [(...) ...]
      const clausePatterns: string[][] = [];
      const clauseTemplates: string[][] = [];

      // Find all [...] or ((...) ...) pairs after syntax-rules
      const clauseRe = /\[\s*(\([^)]*\))\s+([^\]]+)\]/g;
      let clauseMatch: RegExpExecArray | null;
      while ((clauseMatch = clauseRe.exec(fullBody)) !== null) {
        const patSyms = Array.from(extractSymbols(clauseMatch[1]));
        const tplSyms = Array.from(extractSymbols(clauseMatch[2]));
        clausePatterns.push(patSyms);
        clauseTemplates.push(tplSyms);
      }

      defs.push({
        name: macroName,
        kind: 'define-syntax',
        line: i + 1,
        literals,
        patterns: clausePatterns,
        templates: clauseTemplates,
        body: fullBody,
      });

      // Skip to end of definition
      i = j;
      continue;
    }
  }

  return defs;
}

/** Analyze a macro for hygiene issues and return any findings. */
function analyzeMacro(def: MacroDef): HygieneIssue[] {
  const issues: HygieneIssue[] = [];

  // Build the set of all pattern variables across all clauses
  const allPatternVars = new Set<string>([def.name, ...def.literals]);
  for (const patVars of def.patterns) {
    for (const v of patVars) allPatternVars.add(v);
  }

  // Check template variables that are not in patterns
  for (let clauseIdx = 0; clauseIdx < def.templates.length; clauseIdx++) {
    const templateVars = def.templates[clauseIdx];
    const patternVars = new Set(def.patterns[clauseIdx] ?? []);
    // Add macro name and literals as "bound"
    patternVars.add(def.name);
    for (const lit of def.literals) patternVars.add(lit);

    for (const v of templateVars) {
      // Skip scheme builtins
      if (isSchemeBuiltin(v)) continue;
      // Skip ellipsis
      if (v === '...' || v === '_') continue;
      // Check if it's a "capture-prone" helper name not in pattern
      if (CAPTURE_PRONE_NAMES.has(v) && !patternVars.has(v)) {
        issues.push({
          severity: def.kind === 'define-syntax' ? 'INFO' : 'WARNING',
          macroName: def.name,
          line: def.line,
          message: `Uses template variable '${v}' not in pattern`,
          suggestion:
            def.kind === 'define-syntax'
              ? `syntax-rules provides automatic hygiene; explicit rename may be unnecessary, but verify '${v}' is intentionally introduced`
              : `'${v}' may capture user bindings; use a generated name via (gensym) or switch to syntax-rules`,
        });
      }
    }
  }

  // Check for recursive macro: macro body references its own name (not via pattern)
  if (def.body.includes(`(${def.name}`) || def.body.match(new RegExp(`\\b${def.name}\\b`))) {
    // Only warn if it's not a proper syntax-rules self-reference in pattern
    const allPats = def.patterns.flat();
    if (!allPats.includes(def.name)) {
      issues.push({
        severity: 'INFO',
        macroName: def.name,
        line: def.line,
        message: `Recursive macro '${def.name}' references itself in template`,
        suggestion:
          'Recursive macros may cause infinite expansion. Ensure the base case terminates expansion.',
      });
    }
  }

  // Check for bare (begin ...) or (let ...) introduces in defrule without hygiene
  if (def.kind === 'defrule') {
    if (def.body.includes('(let ') || def.body.includes('(let* ')) {
      // Find the let bindings variable names
      const letVarRe = /\(let\*?\s+\(+\((\w[\w\-!?]*)/g;
      let m: RegExpExecArray | null;
      while ((m = letVarRe.exec(def.body)) !== null) {
        const letVar = m[1];
        if (CAPTURE_PRONE_NAMES.has(letVar)) {
          issues.push({
            severity: 'WARNING',
            macroName: def.name,
            line: def.line,
            message: `defrule introduces let-binding '${letVar}' in template`,
            suggestion:
              `'${letVar}' introduced by let in a defrule template may shadow user bindings. ` +
              `Convert to syntax-rules for automatic hygiene, or use (gensym '${letVar}) for defrule.`,
          });
        }
      }
    }
  }

  return issues;
}

/** Check if a symbol is a well-known Scheme built-in (should not be flagged). */
function isSchemeBuiltin(sym: string): boolean {
  const builtins = new Set([
    // Special forms
    'define', 'lambda', 'let', 'let*', 'letrec', 'letrec*', 'begin', 'if',
    'cond', 'case', 'when', 'unless', 'and', 'or', 'not', 'do', 'delay',
    'force', 'quote', 'quasiquote', 'unquote', 'unquote-splicing', 'set!',
    'define-syntax', 'syntax-rules', 'let-syntax', 'letrec-syntax',
    'define-record-type', 'guard', 'raise', 'raise-continuable',
    'with-exception-handler', 'dynamic-wind', 'values', 'call-with-values',
    'apply', 'call-with-current-continuation', 'call/cc',
    // Predicates
    'null?', 'pair?', 'list?', 'number?', 'string?', 'symbol?', 'boolean?',
    'procedure?', 'vector?', 'char?', 'bytevector?', 'port?', 'eof-object?',
    'zero?', 'positive?', 'negative?', 'odd?', 'even?', 'equal?', 'eqv?', 'eq?',
    // Arithmetic
    '+', '-', '*', '/', 'quotient', 'remainder', 'modulo', 'abs', 'max', 'min',
    'expt', 'floor', 'ceiling', 'truncate', 'round', 'sqrt',
    // List operations
    'car', 'cdr', 'cons', 'list', 'length', 'append', 'reverse', 'map', 'for-each',
    'filter', 'fold-left', 'fold-right', 'assoc', 'assq', 'assv', 'member',
    // String/char
    'string', 'string-length', 'string-ref', 'string-append', 'string->symbol',
    'symbol->string', 'string->number', 'number->string',
    // I/O
    'display', 'write', 'newline', 'read', 'current-input-port', 'current-output-port',
    // Misc
    'error', 'void', 'gensym', 'make-parameter', 'parameterize',
    // Chez-specific
    'fluid-let', 'printf', 'format', 'with-output-to-string',
    'open-string-input-port', 'open-string-output-port',
  ]);
  return builtins.has(sym);
}

export function registerMacroHygieneCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_macro_hygiene_check',
    {
      title: 'Macro Hygiene Check',
      description:
        'Detect free variable capture in defrule/define-syntax/syntax-rules macro definitions. ' +
        'Reports variables that may be inadvertently captured and suggests using ' +
        'syntax-rules or gensym-based hygiene.',
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
      const macroDefs = parseMacroDefs(content);

      if (macroDefs.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Hygiene Check: ${shortName}\n\nNo macro definitions found (defrule, define-syntax).`,
          }],
        };
      }

      const allIssues: HygieneIssue[] = [];
      for (const def of macroDefs) {
        const issues = analyzeMacro(def);
        allIssues.push(...issues);
      }

      // Deduplicate
      const seen = new Set<string>();
      const dedupedIssues = allIssues.filter((issue) => {
        const key = `${issue.macroName}:${issue.line}:${issue.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const header = [
        `Hygiene Check: ${shortName}`,
        `Macros found: ${macroDefs.map((d) => d.name).join(', ')}`,
        '',
      ];

      if (dedupedIssues.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: header.join('\n') + 'No hygiene issues found.',
          }],
        };
      }

      const lines: string[] = [...header];

      for (const issue of dedupedIssues) {
        lines.push(`${issue.severity}: Macro '${issue.macroName}' at line ${issue.line}: ${issue.message}`);
        lines.push(`  → ${issue.suggestion}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
      };
    },
  );
}
