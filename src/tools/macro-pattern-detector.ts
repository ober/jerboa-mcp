import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

interface DetectedPattern {
  name: string;
  occurrences: Array<{ line: number; text: string }>;
  suggestedMacro: string;
  macroUsages: string[];
  linesBefore: number;
  linesAfter: number;
}

/**
 * Extract top-level forms from source text with approximate line numbers.
 * Returns each form along with its starting line number.
 */
function extractTopLevelForms(src: string): Array<{ line: number; text: string }> {
  const results: Array<{ line: number; text: string }> = [];
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Skip blank lines and comments
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith(';')) {
      i++;
      continue;
    }

    // Start of a top-level form
    if (trimmed.startsWith('(')) {
      const startLine = i + 1; // 1-based
      let depth = 0;
      const formLines: string[] = [];

      while (i < lines.length) {
        const line = lines[i];
        for (const ch of line) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
        formLines.push(line);
        i++;
        if (depth <= 0) break;
      }

      results.push({ line: startLine, text: formLines.join('\n').trim() });
    } else {
      i++;
    }
  }

  return results;
}

/**
 * Tokenize a Scheme expression into a flat list of tokens.
 */
function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  const re = /[()[\]{}']|"(?:[^"\\]|\\.)*"|;[^\n]*|[^\s()[\]{}'";]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const t = m[0];
    if (!t.startsWith(';')) tokens.push(t);
  }
  return tokens;
}

/**
 * Try to match a hash accessor pattern:
 *   (define (get-FOO obj) (hash-ref obj 'FOO))
 *   (define get-FOO (lambda (obj) (hash-ref obj 'FOO)))
 */
interface AccessorMatch {
  getter: string;
  field: string;
}

function matchHashAccessor(text: string): AccessorMatch | null {
  // (define (get-X obj) (hash-ref obj 'X))
  const m1 = /^\(define\s+\((\S+)\s+\S+\)\s+\(hash-ref\s+\S+\s+'(\S+)\)\s*\)$/.exec(text.replace(/\s+/g, ' ').trim());
  if (m1) return { getter: m1[1], field: m1[2] };

  // (define get-X (lambda (obj) (hash-ref obj 'X)))
  const m2 = /^\(define\s+(\S+)\s+\(lambda\s+\(\S+\)\s+\(hash-ref\s+\S+\s+'(\S+)\)\)\s*\)$/.exec(
    text.replace(/\s+/g, ' ').trim(),
  );
  if (m2) return { getter: m2[1], field: m2[2] };

  return null;
}

/**
 * Try to match a method wrapper pattern:
 *   (define (foo-BAR obj . args) (apply (send obj 'BAR) args))
 *   (define (foo-BAR obj) (send obj 'BAR))
 */
interface MethodWrapperMatch {
  wrapperName: string;
  method: string;
}

function matchMethodWrapper(text: string): MethodWrapperMatch | null {
  const normalized = text.replace(/\s+/g, ' ').trim();

  // (define (name obj . args) (apply (send obj 'method) args))
  const m1 = /^\(define\s+\((\S+)\s+\S+\s+\.\s+\S+\)\s+\(apply\s+\(send\s+\S+\s+'(\S+)\)\s+\S+\)\s*\)$/.exec(
    normalized,
  );
  if (m1) return { wrapperName: m1[1], method: m1[2] };

  // (define (name obj) (send obj 'method))
  const m2 = /^\(define\s+\((\S+)\s+\S+\)\s+\(send\s+\S+\s+'(\S+)\)\s*\)$/.exec(normalized);
  if (m2) return { wrapperName: m2[1], method: m2[2] };

  return null;
}

/**
 * Given a list of top-level forms, detect patterns with >= minOccurrences.
 */
function detectPatterns(
  forms: Array<{ line: number; text: string }>,
  minOccurrences: number,
): DetectedPattern[] {
  const detected: DetectedPattern[] = [];

  // ---- Pattern 1: Hash accessors ----
  const accessorForms: Array<{ line: number; text: string; match: AccessorMatch }> = [];
  for (const f of forms) {
    const m = matchHashAccessor(f.text);
    if (m) accessorForms.push({ ...f, match: m });
  }

  if (accessorForms.length >= minOccurrences) {
    const linesAfter = 1 + accessorForms.length + 1; // macro def + N invocations
    detected.push({
      name: 'Hash accessor',
      occurrences: accessorForms.map((f) => ({ line: f.line, text: f.text.split('\n')[0] })),
      suggestedMacro: [
        '(defrule (def-accessor getter field)',
        '  (define (getter obj) (hash-ref obj (quote field))))',
      ].join('\n'),
      macroUsages: accessorForms.map((f) => `(def-accessor ${f.match.getter} ${f.match.field})`),
      linesBefore: accessorForms.length,
      linesAfter,
    });
  }

  // ---- Pattern 2: Method wrappers ----
  const methodForms: Array<{ line: number; text: string; match: MethodWrapperMatch }> = [];
  for (const f of forms) {
    const m = matchMethodWrapper(f.text);
    if (m) methodForms.push({ ...f, match: m });
  }

  if (methodForms.length >= minOccurrences) {
    const linesAfter = 3 + methodForms.length;
    detected.push({
      name: 'Method wrapper',
      occurrences: methodForms.map((f) => ({ line: f.line, text: f.text.split('\n')[0] })),
      suggestedMacro: [
        '(defrule (def-method-wrapper name method-sym)',
        '  (define (name obj . args)',
        "    (apply (send obj 'method-sym) args)))",
      ].join('\n'),
      macroUsages: methodForms.map((f) => `(def-method-wrapper ${f.match.wrapperName} ${f.match.method})`),
      linesBefore: methodForms.length,
      linesAfter,
    });
  }

  // ---- Pattern 3: Similar function structure (same token shape, one varying symbol) ----
  // Group define forms by their token structure with positions masked
  interface FormShape {
    tokens: string[];
    varPositions: number[]; // positions that vary across the group
  }

  // Collect all (define ...) forms that haven't been matched above
  const matchedLines = new Set<number>();
  for (const f of accessorForms) matchedLines.add(f.line);
  for (const f of methodForms) matchedLines.add(f.line);

  const defineForms = forms.filter((f) => f.text.trimStart().startsWith('(define') && !matchedLines.has(f.line));

  // Group by token count
  const byLength = new Map<number, Array<{ line: number; text: string; tokens: string[] }>>();
  for (const f of defineForms) {
    const toks = tokenize(f.text);
    const bucket = byLength.get(toks.length) ?? [];
    bucket.push({ line: f.line, text: f.text, tokens: toks });
    byLength.set(toks.length, bucket);
  }

  const usedLines = new Set<number>();

  for (const group of byLength.values()) {
    if (group.length < minOccurrences) continue;

    // Find positions where tokens differ
    const len = group[0].tokens.length;
    const varPositions: number[] = [];
    for (let pos = 0; pos < len; pos++) {
      const first = group[0].tokens[pos];
      if (group.some((g) => g.tokens[pos] !== first)) {
        varPositions.push(pos);
      }
    }

    // Only flag if exactly 1-3 varying positions (otherwise too noisy)
    if (varPositions.length === 0 || varPositions.length > 3) continue;

    // Avoid re-reporting already flagged lines
    if (group.some((g) => usedLines.has(g.line))) continue;
    for (const g of group) usedLines.add(g.line);

    // Build macro template tokens
    const varNames = ['var1', 'var2', 'var3'];
    const templateTokens = group[0].tokens.slice();
    const patternVars: string[] = [];
    for (let vi = 0; vi < varPositions.length; vi++) {
      templateTokens[varPositions[vi]] = varNames[vi];
      patternVars.push(varNames[vi]);
    }

    // Reconstruct approximate s-expr (simple, not perfectly indented)
    const templateExpr = reconstructExpr(templateTokens);
    const macroName = 'my-macro';
    const suggestedMacro = `(defrule (${macroName} ${patternVars.join(' ')})\n  ${templateExpr})`;

    const macroUsages = group.map((g) => {
      const vals = varPositions.map((p) => g.tokens[p]);
      return `(${macroName} ${vals.join(' ')})`;
    });

    detected.push({
      name: 'Similar function structure',
      occurrences: group.map((g) => ({ line: g.line, text: g.text.split('\n')[0] })),
      suggestedMacro,
      macroUsages,
      linesBefore: group.length,
      linesAfter: 1 + group.length + 1,
    });
  }

  return detected;
}

/**
 * Very simple token-list → s-expr reconstruction.
 * Not perfectly formatted but sufficient to convey the macro template.
 */
function reconstructExpr(tokens: string[]): string {
  const parts: string[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t === '(' || t === '[') {
      parts.push(t);
      depth++;
    } else if (t === ')' || t === ']') {
      // strip trailing space before closing paren
      if (parts.length > 0 && parts[parts.length - 1] === ' ') parts.pop();
      parts.push(t);
      depth--;
      if (depth > 0) parts.push(' ');
    } else {
      parts.push(t);
      parts.push(' ');
    }
  }
  // Remove trailing space
  if (parts.length > 0 && parts[parts.length - 1] === ' ') parts.pop();
  return parts.join('');
}

export function registerMacroPatternDetectorTool(server: McpServer): void {
  server.registerTool(
    'jerboa_macro_pattern_detector',
    {
      title: 'Macro Pattern Detector',
      description:
        'Analyze Jerboa source files for repetitive code patterns that could be replaced with macros. ' +
        'Detects repeated function definitions with similar structure, repeated hash-ref accessors, ' +
        'and repeated method wrappers. Suggests macro definitions.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().describe('Path to .ss/.sls file to analyze'),
        min_occurrences: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe('Minimum repetitions to flag (default: 3)'),
      },
    },
    async ({ file_path, min_occurrences }) => {
      const minOcc = min_occurrences ?? 3;
      const absPath = path.resolve(file_path);

      let src: string;
      try {
        src = fs.readFileSync(absPath, 'utf8');
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Error: Cannot read file: ${absPath}` }],
          isError: true,
        };
      }

      const forms = extractTopLevelForms(src);
      const patterns = detectPatterns(forms, minOcc);

      const baseName = path.basename(absPath);
      const lines: string[] = [`Macro Pattern Analysis: ${baseName}`, ''];

      if (patterns.length === 0) {
        lines.push(`No repetitive patterns found (threshold: ${minOcc} occurrences).`);
        lines.push(`Analyzed ${forms.length} top-level forms.`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      lines.push(`Found ${patterns.length} repetitive pattern${patterns.length > 1 ? 's' : ''}:`);

      for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i];
        const saved = p.linesBefore - p.linesAfter;
        const savedStr = saved > 0 ? `${p.linesBefore} lines → ${p.linesAfter} lines with macro` : `${p.linesBefore} lines`;

        lines.push('');
        lines.push(
          `Pattern ${i + 1}: ${p.name} (${p.occurrences.length} occurrences, ${savedStr})`,
        );
        lines.push('Forms detected:');
        for (const occ of p.occurrences) {
          lines.push(`  line ${occ.line}: ${occ.text}`);
        }
        lines.push('Suggested macro:');
        lines.push(p.suggestedMacro);
        lines.push('Invocations:');
        for (const usage of p.macroUsages) {
          lines.push(usage);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
