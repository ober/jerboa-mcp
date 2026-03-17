/**
 * jerboa_ffi_scaffold — Parse a C header file and generate Jerboa FFI binding code.
 * Uses Chez Scheme's foreign-procedure and load-shared-object.
 * Pure TypeScript, no subprocess.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

interface CParam {
  cType: string;
  name: string;
}

interface CFunctionDecl {
  returnType: string;
  name: string;
  params: CParam[];
  line: number;
}

interface ParsedHeader {
  functions: CFunctionDecl[];
  skippedLines: number[];
}

/** Map a C type string to a Chez Scheme FFI type expression. */
function mapCTypeToChez(cType: string): string {
  const t = cType.trim().replace(/\s+/g, ' ');

  // Pointer types
  if (t === 'void *' || t === 'void*' || t === 'pointer') return '(* void)';
  if (t.endsWith(' *') || t.endsWith('*')) {
    const base = t.replace(/\s*\*$/, '').trim();
    if (base === 'char' || base === 'const char') return 'string';
    return `(* void)`;
  }

  // Numeric types
  if (t === 'void') return 'void';
  if (t === 'int' || t === 'signed int') return 'integer-32';
  if (t === 'long' || t === 'long int') return 'long';
  if (t === 'long long' || t === 'long long int') return 'integer-64';
  if (t === 'short' || t === 'short int') return 'integer-16';
  if (t === 'unsigned int' || t === 'unsigned') return 'unsigned-32';
  if (t === 'unsigned long' || t === 'unsigned long int') return 'unsigned-long';
  if (t === 'unsigned short') return 'unsigned-16';
  if (t === 'size_t') return 'size_t';
  if (t === 'ssize_t') return 'ssize_t';
  if (t === 'ptrdiff_t') return 'ptrdiff_t';
  if (t === 'double') return 'double';
  if (t === 'float') return 'float';
  if (t === 'char') return 'integer-8';
  if (t === 'unsigned char') return 'unsigned-8';
  if (t === 'bool' || t === '_Bool') return 'boolean';
  if (t === 'int8_t') return 'integer-8';
  if (t === 'int16_t') return 'integer-16';
  if (t === 'int32_t') return 'integer-32';
  if (t === 'int64_t') return 'integer-64';
  if (t === 'uint8_t') return 'unsigned-8';
  if (t === 'uint16_t') return 'unsigned-16';
  if (t === 'uint32_t') return 'unsigned-32';
  if (t === 'uint64_t') return 'unsigned-64';

  // Fallback: treat unknown types as void pointer
  return '(* void)';
}

/** Convert a C identifier to a Scheme-style hyphenated name. */
function cNameToScheme(name: string): string {
  return name.replace(/_/g, '-');
}

/**
 * Parse a single C function declaration line.
 * Handles: `return_type function_name(arg1_type arg1_name, ...)`
 * Returns null if the line cannot be parsed.
 */
function parseFunctionDecl(line: string): CFunctionDecl | null {
  // Strip trailing semicolons and inline comments
  const cleaned = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/;$/, '').trim();

  // Match: returnType name(params)
  // We need to handle pointer types like `char *` or `void *`
  const funcMatch = cleaned.match(
    /^([\w\s*]+?)\s+([\w]+)\s*\(([^)]*)\)\s*$/,
  );
  if (!funcMatch) return null;

  const rawReturn = funcMatch[1].trim();
  const funcName = funcMatch[2].trim();
  const rawParams = funcMatch[3].trim();

  // Skip non-function lines (macros, typedefs, etc.)
  if (funcName === 'define' || rawReturn.startsWith('#')) return null;
  // Must look like a real identifier
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(funcName)) return null;

  const params: CParam[] = [];
  if (rawParams !== '' && rawParams !== 'void') {
    for (const paramStr of rawParams.split(',')) {
      const p = paramStr.trim();
      if (!p) continue;

      // Try to split type and name: last word is the name (unless it ends with *)
      // e.g. "const char *buf", "int size", "void *ptr"
      const paramMatch = p.match(/^(.*?)\s+(\*?\s*[\w]+)\s*$/);
      if (paramMatch) {
        let pType = paramMatch[1].trim();
        let pName = paramMatch[2].trim();
        // Handle pointer attached to name: "char *buf" → type "char *", name "buf"
        if (pName.startsWith('*')) {
          pType = pType + ' *';
          pName = pName.replace(/^\*+\s*/, '');
        }
        params.push({ cType: pType, name: pName || `arg${params.length}` });
      } else {
        // Param with no name (just a type), e.g. "int"
        params.push({ cType: p, name: `arg${params.length}` });
      }
    }
  }

  return { returnType: rawReturn, name: funcName, params, line: 0 };
}

function parseHeader(content: string): ParsedHeader {
  const functions: CFunctionDecl[] = [];
  const skippedLines: number[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip empty lines, preprocessor directives, comments, typedefs, struct/enum defs
    if (
      !line ||
      line.startsWith('#') ||
      line.startsWith('//') ||
      line.startsWith('/*') ||
      line.startsWith('*') ||
      line.startsWith('typedef') ||
      line.startsWith('struct') ||
      line.startsWith('enum') ||
      line.startsWith('}') ||
      line.startsWith('{')
    ) {
      continue;
    }

    // Only try to parse lines that look like they contain a function declaration
    if (!line.includes('(') || !line.includes(')')) continue;

    const decl = parseFunctionDecl(line);
    if (decl) {
      decl.line = i + 1;
      functions.push(decl);
    } else {
      skippedLines.push(i + 1);
    }
  }

  return { functions, skippedLines };
}

interface CreateDestroyPair {
  typeName: string;
  createFn: CFunctionDecl;
  destroyFn: CFunctionDecl;
}

/** Detect create/destroy pairs among function declarations. */
function detectCreateDestroyPairs(functions: CFunctionDecl[]): CreateDestroyPair[] {
  const pairs: CreateDestroyPair[] = [];
  const names = new Map<string, CFunctionDecl>(functions.map((f) => [f.name, f]));

  for (const fn of functions) {
    let typeName: string | null = null;
    let destroyName: string | null = null;

    // Pattern: foo_create / foo_destroy
    const createMatch = fn.name.match(/^(.+)_create$/);
    if (createMatch) {
      typeName = createMatch[1];
      destroyName = `${typeName}_destroy`;
    }

    // Pattern: foo_new / foo_free
    const newMatch = fn.name.match(/^(.+)_new$/);
    if (!destroyName && newMatch) {
      typeName = newMatch[1];
      destroyName = `${typeName}_free`;
    }

    // Pattern: new_foo / free_foo
    const newPrefixMatch = fn.name.match(/^new_(.+)$/);
    if (!destroyName && newPrefixMatch) {
      typeName = newPrefixMatch[1];
      destroyName = `free_${typeName}`;
    }

    // Pattern: foo_open / foo_close
    const openMatch = fn.name.match(/^(.+)_open$/);
    if (!destroyName && openMatch) {
      typeName = openMatch[1];
      destroyName = `${typeName}_close`;
    }

    if (typeName && destroyName && names.has(destroyName)) {
      pairs.push({
        typeName,
        createFn: fn,
        destroyFn: names.get(destroyName)!,
      });
    }
  }

  return pairs;
}

/** Generate the Scheme record name from a C type name. */
function recordName(typeName: string): string {
  return cNameToScheme(typeName);
}

function generateFfiCode(
  moduleName: string,
  libraryName: string,
  parsed: ParsedHeader,
): string {
  const { functions, skippedLines } = parsed;

  const schemeFunctions = functions.map((fn) => {
    const schemeName = cNameToScheme(fn.name);
    const chezArgs = fn.params.map((p) => mapCTypeToChez(p.cType));
    const chezReturn = mapCTypeToChez(fn.returnType);
    const argsStr = chezArgs.length > 0 ? `(${chezArgs.join(' ')})` : '()';
    return `  ; Function: ${fn.name} (line ${fn.line})\n  (define ${schemeName}\n    (foreign-procedure "${fn.name}"\n      ${argsStr}\n      ${chezReturn}))`;
  });

  const pairs = detectCreateDestroyPairs(functions);

  const guardianWrappers = pairs.map((pair) => {
    const recName = recordName(pair.typeName);
    const schemeMake = cNameToScheme(pair.createFn.name);
    const schemeDestroy = cNameToScheme(pair.destroyFn.name);
    const paramNames = pair.createFn.params.map((p) => cNameToScheme(p.name));
    const paramsStr = paramNames.join(' ');
    const callArgs = paramNames.join(' ');

    return [
      `  ; GC-managed wrapper for ${pair.typeName} create/destroy pair`,
      `  (define-record-type ${recName}-type`,
      `    (make-${recName}-record ptr)`,
      `    ${recName}-type?`,
      `    (ptr ${recName}-ptr))`,
      ``,
      `  (define ${recName}-guardian (make-guardian))`,
      ``,
      `  (define (make-${recName}${paramsStr ? ' ' + paramsStr : ''})`,
      `    (let* ([ptr (${schemeMake}${callArgs ? ' ' + callArgs : ''})]`,
      `           [obj (make-${recName}-record ptr)])`,
      `      (${recName}-guardian obj)`,
      `      obj))`,
      ``,
      `  (define (${recName}-finalize!)`,
      `    (let loop ([obj (${recName}-guardian)])`,
      `      (when obj`,
      `        (${schemeDestroy} (${recName}-ptr obj))`,
      `        (loop (${recName}-guardian)))))`,
    ].join('\n');
  });

  const allExports: string[] = [
    ...functions.map((fn) => cNameToScheme(fn.name)),
    ...pairs.flatMap((p) => {
      const recName = recordName(p.typeName);
      return [
        `make-${recName}`,
        `${recName}-type?`,
        `${recName}-ptr`,
        `${recName}-finalize!`,
      ];
    }),
  ];

  const exportStr = allExports.map((e) => `    ${e}`).join('\n');
  const skippedComment = skippedLines.length > 0
    ? `\n  ; NOTE: Skipped unparseable lines: ${skippedLines.join(', ')}\n`
    : '';

  const parts: string[] = [
    `(library (${moduleName})`,
    `  (export`,
    exportStr,
    `  )`,
    `  (import (chezscheme))`,
    ``,
    `  (load-shared-object "${libraryName}")`,
    skippedComment,
    ...schemeFunctions,
  ];

  if (guardianWrappers.length > 0) {
    parts.push('');
    parts.push('  ; ── Guardian-based GC wrappers for create/destroy pairs ──');
    parts.push(...guardianWrappers);
  }

  parts.push(')');

  return parts.join('\n');
}

export function registerFfiScaffoldTool(server: McpServer): void {
  server.registerTool(
    'jerboa_ffi_scaffold',
    {
      title: 'FFI Scaffold',
      description:
        "Parse a C header file and generate Jerboa FFI binding code using Chez Scheme's " +
        "`foreign-procedure` and `load-shared-object`. Recognizes create/destroy pairs for GC cleanup patterns.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        header_path: z
          .string()
          .describe('Path to the C header file (.h)'),
        module_name: z
          .string()
          .optional()
          .describe('Module name for the generated bindings (default: derived from filename)'),
        library_name: z
          .string()
          .optional()
          .describe('Shared library name (e.g. "libfoo.so")'),
      },
    },
    async ({ header_path, module_name, library_name }) => {
      let content: string;
      try {
        content = await readFile(header_path, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to read header file: ${msg}` }],
          isError: true,
        };
      }

      // Derive module name from filename if not provided
      const base = basename(header_path).replace(/\.[^.]+$/, '');
      const derivedModuleName = module_name ?? base.replace(/_/g, '-');
      const derivedLibraryName = library_name ?? `lib${base}.so`;

      let parsed: ParsedHeader;
      try {
        parsed = parseHeader(content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to parse header: ${msg}` }],
          isError: true,
        };
      }

      if (parsed.functions.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text:
              `No function declarations found in ${header_path}.\n` +
              (parsed.skippedLines.length > 0
                ? `Skipped lines: ${parsed.skippedLines.join(', ')}`
                : ''),
          }],
        };
      }

      const generated = generateFfiCode(derivedModuleName, derivedLibraryName, parsed);

      const pairs = detectCreateDestroyPairs(parsed.functions);
      const summary: string[] = [
        `; Generated from: ${header_path}`,
        `; Functions found: ${parsed.functions.length}`,
        `; Create/destroy pairs: ${pairs.length}${pairs.length > 0 ? ' (' + pairs.map((p) => p.typeName).join(', ') + ')' : ''}`,
        parsed.skippedLines.length > 0
          ? `; Skipped lines (unparseable): ${parsed.skippedLines.join(', ')}`
          : `; No parse errors`,
        '',
        generated,
      ];

      return {
        content: [{ type: 'text' as const, text: summary.join('\n') }],
      };
    },
  );
}
