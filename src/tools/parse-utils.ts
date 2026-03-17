import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ── Definition Parsing ──────────────────────────────────────────────

export interface SymbolDefinition {
  name: string;
  kind: string;
  line: number;
}

export interface ImportInfo {
  raw: string;
  line: number;
}

export interface ExportInfo {
  raw: string;
  line: number;
}

export interface FileAnalysis {
  definitions: SymbolDefinition[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}

const DEF_PATTERNS: Array<{ keyword: string; kind: string }> = [
  { keyword: 'def*', kind: 'procedure' },
  { keyword: 'def/c', kind: 'procedure' },
  { keyword: 'defstruct', kind: 'struct' },
  { keyword: 'defclass', kind: 'class' },
  { keyword: 'definterface', kind: 'interface' },
  { keyword: 'defrules', kind: 'macro' },
  { keyword: 'defrule', kind: 'macro' },
  { keyword: 'defsyntax-call', kind: 'macro' },
  { keyword: 'defsyntax', kind: 'macro' },
  { keyword: 'defmacro', kind: 'macro' },
  { keyword: 'defmethod', kind: 'method' },
  { keyword: 'defconst', kind: 'constant' },
  { keyword: 'definline', kind: 'inline' },
  { keyword: 'defvalues', kind: 'values' },
  { keyword: 'defalias', kind: 'alias' },
  { keyword: 'deftype', kind: 'type' },
  { keyword: 'define', kind: 'procedure' },
  { keyword: 'def', kind: 'procedure' },
];

/**
 * Parse definitions, imports, and exports from Jerboa source text.
 * Pure TypeScript line-based parsing — fast, no subprocess needed.
 */
export function parseDefinitions(content: string): FileAnalysis {
  const lines = content.split('\n');
  const definitions: SymbolDefinition[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const lineNum = i + 1;

    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#|')) {
      continue;
    }

    if (trimmed.startsWith('(import ') || trimmed === '(import') {
      imports.push({ raw: extractForm(lines, i), line: lineNum });
      continue;
    }

    if (trimmed.startsWith('(export ') || trimmed === '(export') {
      exports.push({ raw: extractForm(lines, i), line: lineNum });
      continue;
    }

    for (const { keyword, kind } of DEF_PATTERNS) {
      const prefix = `(${keyword} `;
      if (trimmed.startsWith(prefix)) {
        const rest = trimmed.slice(prefix.length);
        const name = extractDefName(rest, keyword);
        if (name) {
          definitions.push({ name, kind, line: lineNum });
        }
        break;
      }
    }
  }

  return { definitions, imports, exports };
}

function extractDefName(rest: string, keyword: string): string | null {
  const trimmed = rest.trimStart();
  if (!trimmed) return null;

  if (trimmed.startsWith('(')) {
    const inner = trimmed.slice(1);
    return readToken(inner) || null;
  }

  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1);
    // For defmethod {name type}, extract the first token inside braces
    const token = readToken(inner);
    if (keyword === 'defmethod' && token) {
      // Could be {:name type} — strip leading colon if present
      return token.startsWith(':') ? token.slice(1) : token;
    }
    return token || null;
  }

  return readToken(trimmed) || null;
}

function readToken(text: string): string {
  const delimiters = new Set([
    ' ', '\t', '\n', '\r', '(', ')', '[', ']', '{', '}',
    '"', "'", '`', ',', ';',
  ]);
  let i = 0;
  while (i < text.length && !delimiters.has(text[i])) {
    i++;
  }
  return text.slice(0, i);
}

function extractForm(lines: string[], startIdx: number): string {
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

// ── File System Scanning ────────────────────────────────────────────

const SKIP_DIRS = new Set([
  '.git', '.svn', 'node_modules', '.gerbil', '__pycache__', 'dist',
]);

/**
 * Recursively scan a directory for .ss and .scm files.
 */
export async function scanSchemeFiles(directory: string): Promise<string[]> {
  const results: string[] = [];
  await scanDir(directory, results);
  return results.sort();
}

async function scanDir(dir: string, results: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    try {
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        await scanDir(fullPath, results);
      } else if (entry.endsWith('.ss') || entry.endsWith('.scm')) {
        results.push(fullPath);
      }
    } catch {
      // skip inaccessible entries
    }
  }
}

// ── Scheme Word Boundary Detection ──────────────────────────────────

const SCHEME_DELIMITERS = new Set([
  ' ', '\t', '\n', '\r', '(', ')', '[', ']', '{', '}',
  '"', "'", '`', ',', ';', '#',
]);

export function isSchemeDelimiter(ch: string): boolean {
  return SCHEME_DELIMITERS.has(ch);
}

/**
 * Find all occurrences of a symbol in text with word-boundary checking.
 * Skips matches inside comments and string literals (heuristic).
 */
export function findSymbolOccurrences(
  content: string,
  symbol: string,
): Array<{ line: number; column: number; lineText: string }> {
  const results: Array<{ line: number; column: number; lineText: string }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let searchFrom = 0;
    while (true) {
      const idx = line.indexOf(symbol, searchFrom);
      if (idx === -1) break;

      const leftOk = idx === 0 || isSchemeDelimiter(line[idx - 1]);
      const rightIdx = idx + symbol.length;
      const rightOk =
        rightIdx >= line.length || isSchemeDelimiter(line[rightIdx]);

      if (leftOk && rightOk) {
        const beforeMatch = line.slice(0, idx);
        const inComment = beforeMatch.includes(';');
        const quoteCount = (beforeMatch.match(/"/g) || []).length;
        const inString = quoteCount % 2 !== 0;

        if (!inComment && !inString) {
          results.push({ line: i + 1, column: idx + 1, lineText: line });
        }
      }

      searchFrom = idx + 1;
    }
  }

  return results;
}

// ── Compiler Error Parsing ───────────────────────────────────────────

export interface Diagnostic {
  file: string;
  line: number | null;
  column: number | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/**
 * Parse compiler stderr output into structured diagnostics.
 */
export function parseGxcErrors(
  stderr: string,
  defaultFile?: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stderr.split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;

    // Pattern 1: /path/file.ss:LINE:COL: message
    const match1 = trimmed.match(/^(.+\.ss?):(\d+):(\d+):\s*(.+)$/);
    if (match1) {
      const context = collectErrorContext(lines, idx);
      diagnostics.push({
        file: match1[1],
        line: parseInt(match1[2], 10),
        column: parseInt(match1[3], 10),
        severity: classifySeverity(match1[4]),
        message: context ? `${match1[4]}\n${context}` : match1[4],
      });
      continue;
    }

    // Pattern 2: "file.ss"@LINE.COL -- message  (Gambit format)
    const match2 = trimmed.match(/"([^"]+)"@(\d+)\.(\d+)\s+--\s+(.+)$/);
    if (match2) {
      const context = collectErrorContext(lines, idx);
      diagnostics.push({
        file: match2[1],
        line: parseInt(match2[2], 10),
        column: parseInt(match2[3], 10),
        severity: 'error',
        message: context ? `${match2[4]}\n${context}` : match2[4],
      });
      continue;
    }

    // Pattern 3: *** ERROR ... -- message
    const match3 = trimmed.match(
      /^\*\*\*\s+ERROR\s+(?:IN\s+.+?\s+)?--\s*(.+)$/,
    );
    if (match3) {
      const context = collectErrorContext(lines, idx);
      diagnostics.push({
        file: defaultFile || '<unknown>',
        line: null,
        column: null,
        severity: 'error',
        message: context ? `${match3[1]}\n${context}` : match3[1],
      });
      continue;
    }

    // Fallback: unrecognized error line
    if (trimmed.startsWith('***') || trimmed.startsWith('Error')) {
      diagnostics.push({
        file: defaultFile || '<unknown>',
        line: null,
        column: null,
        severity: 'error',
        message: trimmed,
      });
    }
  }

  return diagnostics;
}

/**
 * Collect multi-line error context following an error line.
 */
function collectErrorContext(lines: string[], errorIdx: number): string {
  const contextLines: string[] = [];
  for (let j = errorIdx + 1; j < lines.length && j <= errorIdx + 10; j++) {
    const next = lines[j].trim();
    if (!next) break;
    if (
      /^(at|form|context|where|source)\s*:/.test(next) ||
      next.startsWith('...') ||
      (lines[j].startsWith('   ') && !next.startsWith('***'))
    ) {
      contextLines.push(`  ${next}`);
    } else {
      break;
    }
  }
  return contextLines.join('\n');
}

function classifySeverity(message: string): 'error' | 'warning' | 'info' {
  const lower = message.toLowerCase();
  if (lower.includes('warning')) return 'warning';
  if (lower.includes('info') || lower.includes('note')) return 'info';
  return 'error';
}

// ── Build Script Parsing ────────────────────────────────────────────

export interface BuildTargets {
  libraries: string[];
  executables: Array<{ module: string; binary: string }>;
}

/**
 * Parse build.ss defbuild-script content to extract build targets.
 */
export function parseBuildTargets(content: string): BuildTargets {
  const libraries: string[] = [];
  const executables: Array<{ module: string; binary: string }> = [];

  // Extract the quoted list from defbuild-script '(...)
  const listMatch = content.match(/defbuild-script\s*\n?\s*'?\(([^]*)\)/);
  if (!listMatch) return { libraries, executables };

  const body = listMatch[1];

  // Match executable entries: (exe: "module" bin: "binary")
  const exePattern = /\(exe:\s*"([^"]+)"\s+bin:\s*"([^"]+)"\)/g;
  let exeMatch;
  while ((exeMatch = exePattern.exec(body)) !== null) {
    executables.push({ module: exeMatch[1], binary: exeMatch[2] });
  }

  // Match plain string entries (library modules)
  const strPattern = /"([^"]+)"/g;
  let strMatch;
  const allStrings: string[] = [];
  while ((strMatch = strPattern.exec(body)) !== null) {
    allStrings.push(strMatch[1]);
  }

  // Library strings are those not part of exe entries
  const exeModules = new Set(executables.map((e) => e.module));
  const exeBinaries = new Set(executables.map((e) => e.binary));
  for (const s of allStrings) {
    if (!exeModules.has(s) && !exeBinaries.has(s)) {
      libraries.push(s);
    }
  }

  return { libraries, executables };
}

/**
 * Extract module paths from an import form text.
 */
export function extractModulePaths(importText: string): string[] {
  const absolute = importText.match(/:[a-zA-Z][a-zA-Z0-9/_-]*/g) || [];
  const relative = importText.match(/\.\/[a-zA-Z][a-zA-Z0-9/_-]*/g) || [];
  return [...absolute, ...relative];
}

// ── Call Site Extraction ─────────────────────────────────────────────

export interface CallSite {
  symbol: string;
  argCount: number;
  line: number;
  column: number;
}

/**
 * Set of syntax/special forms that should NOT be treated as function calls.
 */
const SKIP_FORMS = new Set([
  'def', 'def*', 'def/c', 'define', 'defvalues', 'defconst', 'definline',
  'defstruct', 'defclass', 'definterface', 'defrules', 'defrule',
  'defsyntax', 'defsyntax-call', 'defmacro', 'defmethod', 'defalias', 'deftype',
  'import', 'export', 'if', 'cond', 'case', 'when', 'unless',
  'let', 'let*', 'letrec', 'letrec*', 'alet', 'alet*', 'and-let*',
  'lambda', 'case-lambda',
  'match', 'match*', 'with', 'with*',
  'begin', 'begin0', 'begin-syntax',
  'try', 'catch', 'finally',
  'set!', 'do', 'while', 'until',
  'declare', 'cond-expand',
  'syntax-case', 'with-syntax', 'syntax/loc',
  'quote', 'quasiquote', 'unquote', 'unquote-splicing',
  'and', 'or', 'not',
  'for', 'for/collect', 'for/fold',
  'parameterize', 'using',
  'interface', 'struct',
  'let/cc', 'let/esc',
  'if-let', 'when-let',
  'guard',
]);

const enum ScanState {
  Normal,
  String,
  LineComment,
  BlockComment,
  CharLiteral,
}

/**
 * Extract function call sites from Jerboa source code.
 */
export function extractCallSites(content: string): CallSite[] {
  const results: CallSite[] = [];
  const len = content.length;
  let state = ScanState.Normal;
  let blockCommentDepth = 0;
  let line = 1;
  let col = 1;

  for (let i = 0; i < len; i++) {
    const ch = content[i];

    if (ch === '\n') {
      if (state === ScanState.LineComment) {
        state = ScanState.Normal;
      }
      line++;
      col = 1;
      continue;
    }

    switch (state) {
      case ScanState.String:
        if (ch === '\\') { i++; col += 2; continue; }
        if (ch === '"') { state = ScanState.Normal; }
        col++;
        continue;

      case ScanState.LineComment:
        col++;
        continue;

      case ScanState.BlockComment:
        if (ch === '#' && i + 1 < len && content[i + 1] === '|') {
          blockCommentDepth++;
          i++; col += 2; continue;
        }
        if (ch === '|' && i + 1 < len && content[i + 1] === '#') {
          blockCommentDepth--;
          if (blockCommentDepth === 0) state = ScanState.Normal;
          i++; col += 2; continue;
        }
        col++;
        continue;

      case ScanState.CharLiteral:
        while (i < len && content[i] !== ' ' && content[i] !== '\t' &&
               content[i] !== '\n' && content[i] !== ')' && content[i] !== '(' &&
               content[i] !== '[' && content[i] !== ']') {
          i++; col++;
        }
        state = ScanState.Normal;
        i--; col--;
        continue;

      case ScanState.Normal:
        break;
    }

    if (ch === '"') {
      state = ScanState.String;
      col++;
      continue;
    }
    if (ch === ';') {
      state = ScanState.LineComment;
      col++;
      continue;
    }
    if (ch === '#' && i + 1 < len) {
      if (content[i + 1] === '|') {
        state = ScanState.BlockComment;
        blockCommentDepth = 1;
        i++; col += 2; continue;
      }
      if (content[i + 1] === '\\') {
        state = ScanState.CharLiteral;
        i++; col += 2; continue;
      }
    }

    if (ch === '{') {
      let braceDepth = 1;
      i++; col++;
      while (i < len && braceDepth > 0) {
        if (content[i] === '{') braceDepth++;
        else if (content[i] === '}') braceDepth--;
        else if (content[i] === '\n') { line++; col = 0; }
        i++; col++;
      }
      i--; col--;
      continue;
    }

    if (ch === '(') {
      const callLine = line;
      const callCol = col;
      col++;

      let j = i + 1;
      while (j < len && (content[j] === ' ' || content[j] === '\t')) { j++; col++; }

      const tokenStart = j;
      while (j < len && !isDelimChar(content[j])) { j++; }
      const headToken = content.slice(tokenStart, j);

      if (headToken.length > 0 && !SKIP_FORMS.has(headToken) &&
          !headToken.startsWith("'") && !headToken.startsWith("`") &&
          !headToken.startsWith(",") && !headToken.startsWith("#")) {
        const argCount = countArgs(content, j, len);
        if (argCount >= 0) {
          results.push({
            symbol: headToken,
            argCount,
            line: callLine,
            column: callCol,
          });
        }
      }
    }
    col++;
  }

  return results;
}

function isDelimChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
         ch === '(' || ch === ')' || ch === '[' || ch === ']' ||
         ch === '{' || ch === '}' || ch === '"' || ch === "'" ||
         ch === '`' || ch === ',' || ch === ';';
}

function countArgs(content: string, start: number, end: number): number {
  let count = 0;
  let i = start;
  let depth = 1;
  let inString = false;
  let seenNonSpace = false;

  while (i < end && depth > 0) {
    const ch = content[i];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      if (depth === 1 && !seenNonSpace) { count++; seenNonSpace = true; }
      i++;
      continue;
    }

    if (ch === ';') {
      while (i < end && content[i] !== '\n') i++;
      continue;
    }

    if (ch === '#' && i + 1 < end && content[i + 1] === '|') {
      let bd = 1;
      i += 2;
      while (i < end && bd > 0) {
        if (content[i] === '#' && i + 1 < end && content[i + 1] === '|') { bd++; i += 2; }
        else if (content[i] === '|' && i + 1 < end && content[i + 1] === '#') { bd--; i += 2; }
        else i++;
      }
      continue;
    }

    if (ch === '(' || ch === '[') {
      if (depth === 1 && !seenNonSpace) { count++; seenNonSpace = true; }
      depth++;
      i++;
      continue;
    }

    if (ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) break;
      i++;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      seenNonSpace = false;
      i++;
      continue;
    }

    if (depth === 1 && !seenNonSpace) {
      count++;
      seenNonSpace = true;
    }
    i++;
  }

  return depth === 0 ? count : -1;
}

// ── Local Arity Extraction ──────────────────────────────────────────

export interface ArityInfo {
  name: string;
  minArity: number;
  maxArity: number | null;
  isMacro: boolean;
  isCaseLambda: boolean;
  caseArities?: number[];
}

export function extractLocalArities(
  content: string,
  definitions: SymbolDefinition[],
): ArityInfo[] {
  const results: ArityInfo[] = [];
  const lines = content.split('\n');

  for (const def of definitions) {
    if (def.kind === 'macro') {
      results.push({
        name: def.name,
        minArity: 0,
        maxArity: null,
        isMacro: true,
        isCaseLambda: false,
      });
      continue;
    }

    if (def.kind !== 'procedure') continue;

    const lineIdx = def.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const trimmed = lines[lineIdx].trimStart();

    if (trimmed.startsWith('(def* ')) {
      const arities = extractCaseLambdaArities(lines, lineIdx);
      results.push({
        name: def.name,
        minArity: arities.length > 0 ? Math.min(...arities) : 0,
        maxArity: arities.length > 0 ? Math.max(...arities) : null,
        isMacro: false,
        isCaseLambda: true,
        caseArities: arities,
      });
      continue;
    }

    const paramInfo = parseParamArity(lines, lineIdx);
    if (paramInfo) {
      results.push({
        name: def.name,
        minArity: paramInfo.min,
        maxArity: paramInfo.max,
        isMacro: false,
        isCaseLambda: false,
      });
    }
  }

  return results;
}

function parseParamArity(
  lines: string[],
  startIdx: number,
): { min: number; max: number | null } | null {
  let text = '';
  for (let i = startIdx; i < lines.length && i < startIdx + 20; i++) {
    text += (i > startIdx ? '\n' : '') + lines[i];
    if (hasFullParamList(text)) break;
  }

  const match = text.match(/^\(\s*(?:def|define)\s+\(/);
  if (!match) {
    return null;
  }

  const parenStart = text.indexOf('(', text.indexOf('(') + 1);
  if (parenStart === -1) return null;

  let depth = 1;
  let j = parenStart + 1;
  while (j < text.length && depth > 0) {
    if (text[j] === '(' || text[j] === '[') depth++;
    else if (text[j] === ')' || text[j] === ']') depth--;
    j++;
  }

  const paramText = text.slice(parenStart + 1, j - 1);

  const tokens = paramText.trim().split(/\s+/);
  if (tokens.length === 0) return null;

  let required = 0;
  let optional = 0;
  let hasRest = false;

  const paramContent = paramText.trim();
  let nameEnd = 0;
  while (nameEnd < paramContent.length && !/[\s()[\]]/.test(paramContent[nameEnd])) nameEnd++;

  let pi = nameEnd;
  while (pi < paramContent.length) {
    while (pi < paramContent.length && /\s/.test(paramContent[pi])) pi++;
    if (pi >= paramContent.length) break;

    const ch = paramContent[pi];

    if (ch === '.') {
      hasRest = true;
      break;
    }

    if (ch === '(' || ch === '[') {
      optional++;
      let d = 1;
      pi++;
      while (pi < paramContent.length && d > 0) {
        if (paramContent[pi] === '(' || paramContent[pi] === '[') d++;
        else if (paramContent[pi] === ')' || paramContent[pi] === ']') d--;
        pi++;
      }
      continue;
    }

    let tokenEnd = pi;
    while (tokenEnd < paramContent.length && !/[\s()[\]]/.test(paramContent[tokenEnd])) tokenEnd++;
    const token = paramContent.slice(pi, tokenEnd);

    if (token.endsWith(':')) {
      pi = tokenEnd;
      while (pi < paramContent.length && /\s/.test(paramContent[pi])) pi++;
      if (pi < paramContent.length && (paramContent[pi] === '(' || paramContent[pi] === '[')) {
        let d = 1;
        pi++;
        while (pi < paramContent.length && d > 0) {
          if (paramContent[pi] === '(' || paramContent[pi] === '[') d++;
          else if (paramContent[pi] === ')' || paramContent[pi] === ']') d--;
          pi++;
        }
      } else {
        while (pi < paramContent.length && !/[\s()[\]]/.test(paramContent[pi])) pi++;
      }
      optional++;
      continue;
    }

    required++;
    pi = tokenEnd;
  }

  return {
    min: required,
    max: hasRest ? null : required + optional,
  };
}

function hasFullParamList(text: string): boolean {
  const first = text.indexOf('(');
  if (first === -1) return false;
  const second = text.indexOf('(', first + 1);
  if (second === -1) return false;

  let depth = 0;
  for (let i = second; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '[') depth++;
    else if (text[i] === ')' || text[i] === ']') depth--;
    if (depth === 0) return true;
  }
  return false;
}

function extractCaseLambdaArities(lines: string[], startIdx: number): number[] {
  let text = '';
  for (let i = startIdx; i < lines.length && i < startIdx + 30; i++) {
    text += (i > startIdx ? '\n' : '') + lines[i];
  }

  const arities: number[] = [];
  const clausePattern = /\((\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_*!?/-]*)\s/g;
  let m;
  let skipped = false;
  while ((m = clausePattern.exec(text)) !== null) {
    if (!skipped) { skipped = true; continue; }
    const params = m[1];
    if (params.startsWith('(')) {
      const inner = params.slice(1, -1).trim();
      if (inner.length === 0) {
        arities.push(0);
      } else if (inner.includes('.')) {
        const parts = inner.split(/\s+/);
        const dotIdx = parts.indexOf('.');
        arities.push(dotIdx);
      } else {
        arities.push(inner.split(/\s+/).length);
      }
    } else {
      arities.push(0);
    }
  }

  return arities;
}
