/**
 * jerboa_ai_scaffold — Generate Jerboa FFI bindings from Rust extern "C" function signatures.
 *
 * Takes Rust-style extern "C" function declarations (the kind from crate C APIs or
 * cbindgen-generated headers) and produces:
 * - load-shared-object + foreign-procedure declarations
 * - Safe wrapper functions with type guards
 * - A test skeleton
 *
 * Handles Rust primitive types (i32, f64, usize, *mut T, etc.) and
 * libc/FFI types (c_int, c_double, c_char, etc.).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface RustParam {
  name: string;
  rustType: string;
}

interface RustFnDecl {
  name: string;
  params: RustParam[];
  returnType: string; // empty string means ()
}

/** Map a Rust type string to a Chez Scheme FFI type expression. */
function mapRustTypeToChez(rustType: string): string {
  const t = rustType.trim();

  // Void return
  if (t === '()' || t === 'c_void' || t === 'std::ffi::c_void') return 'void';

  // String pointer types → Chez string
  if (
    t === '*mut c_char' ||
    t === '*const c_char' ||
    t === '*mut u8' ||
    t === '*const u8'
  ) {
    return 'string';
  }

  // Generic pointer types → void pointer
  if (t.startsWith('*mut ') || t.startsWith('*const ')) return '(* void)';

  // Rust primitive types
  const primitiveMap: Record<string, string> = {
    i8: 'integer-8',
    i16: 'integer-16',
    i32: 'integer-32',
    i64: 'integer-64',
    u8: 'unsigned-8',
    u16: 'unsigned-16',
    u32: 'unsigned-32',
    u64: 'unsigned-64',
    f32: 'float',
    f64: 'double',
    bool: 'boolean',
    usize: 'size_t',
    isize: 'ssize_t',
    // libc / std::os::raw types
    c_int: 'integer-32',
    c_uint: 'unsigned-32',
    c_long: 'long',
    c_ulong: 'unsigned-long',
    c_short: 'integer-16',
    c_ushort: 'unsigned-16',
    c_char: 'integer-8',
    c_uchar: 'unsigned-8',
    c_float: 'float',
    c_double: 'double',
    c_longlong: 'integer-64',
    c_ulonglong: 'unsigned-64',
    c_size_t: 'size_t',
    c_ssize_t: 'ssize_t',
    // Strip module prefixes (e.g. libc::c_int → c_int)
  };

  // Strip module prefix if present (e.g. libc::c_int, std::os::raw::c_int)
  const stripped = t.replace(/^.*::/, '');
  if (primitiveMap[stripped]) return primitiveMap[stripped];
  if (primitiveMap[t]) return primitiveMap[t];

  // Unknown type — treat as opaque pointer
  return '(* void)';
}

/** Convert a Rust snake_case identifier to Scheme hyphen-style. */
function rustNameToScheme(name: string): string {
  return name.replace(/_/g, '-');
}

/**
 * Parse Rust extern "C" fn declarations from a multi-line string.
 * Accepts both standalone `pub extern "C" fn ...` and `extern "C" { fn ... }` blocks.
 */
function parseRustSignatures(input: string): { fns: RustFnDecl[]; skipped: string[] } {
  const fns: RustFnDecl[] = [];
  const skipped: string[] = [];

  // Normalize: join continued lines, strip block braces
  const normalized = input
    .replace(/extern\s+"C"\s*\{/g, '')
    .replace(/^\s*\}\s*$/gm, '')
    .replace(/#\[.*?\]/g, '') // strip attributes like #[no_mangle]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let i = 0;
  while (i < normalized.length) {
    let line = normalized[i++];

    // Skip comments and empty lines
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

    // Strip visibility, unsafe, extern qualifiers
    line = line
      .replace(/\bpub\s+/g, '')
      .replace(/\bunsafe\s+/g, '')
      .replace(/\bextern\s+"C"\s+/g, '')
      .replace(/;$/, '')
      .trim();

    if (!line.startsWith('fn ')) {
      if (line) skipped.push(line.slice(0, 70));
      continue;
    }

    // Join continuation lines (for multi-line signatures)
    while (!line.includes(')') && i < normalized.length) {
      line += ' ' + normalized[i++].replace(/;$/, '').trim();
    }

    // Match: fn name(params) -> ReturnType  or  fn name(params)
    const fnMatch = line.match(/^fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?(?:\s*\{.*)?$/);
    if (!fnMatch) {
      skipped.push(line.slice(0, 70));
      continue;
    }

    const name = fnMatch[1];
    const paramsRaw = fnMatch[2].trim();
    const returnRaw = (fnMatch[3] ?? '').trim();

    const params: RustParam[] = [];
    if (paramsRaw) {
      for (const p of paramsRaw.split(',')) {
        const pt = p.trim();
        if (!pt || pt === '...' || pt === 'self' || pt === '&self' || pt === '&mut self') continue;

        const colonIdx = pt.indexOf(':');
        if (colonIdx === -1) {
          // No colon: treat whole thing as a type
          params.push({ name: `arg${params.length}`, rustType: pt });
        } else {
          const pName = pt.slice(0, colonIdx).trim().replace(/^_+$/, '_');
          const pType = pt.slice(colonIdx + 1).trim();
          params.push({
            name: pName === '_' ? `arg${params.length}` : pName,
            rustType: pType,
          });
        }
      }
    }

    fns.push({ name, params, returnType: returnRaw });
  }

  return { fns, skipped };
}

/** Detect create/destroy pairs: foo_new/foo_free, foo_create/foo_destroy, foo_open/foo_close. */
function detectResourcePairs(
  fns: RustFnDecl[],
): Array<{ typeName: string; createFn: RustFnDecl; destroyFn: RustFnDecl }> {
  const pairs: Array<{ typeName: string; createFn: RustFnDecl; destroyFn: RustFnDecl }> = [];
  const byName = new Map(fns.map((f) => [f.name, f]));

  for (const fn of fns) {
    for (const [suffix, destroySuffix] of [
      ['_new', '_free'],
      ['_create', '_destroy'],
      ['_open', '_close'],
      ['_init', '_deinit'],
      ['_alloc', '_dealloc'],
    ]) {
      if (fn.name.endsWith(suffix)) {
        const typeName = fn.name.slice(0, -suffix.length);
        const destroyName = `${typeName}${destroySuffix}`;
        if (byName.has(destroyName)) {
          pairs.push({ typeName, createFn: fn, destroyFn: byName.get(destroyName)! });
          break;
        }
      }
    }
  }
  return pairs;
}

/** Generate a type guard expression for a Rust type. */
function typeGuard(schemeParamName: string, rustType: string): string | null {
  const t = rustType.trim();
  if (t.startsWith('*mut ') || t.startsWith('*const ')) {
    return `(assert! (and (integer? ${schemeParamName}) (not (zero? ${schemeParamName}))) "null pointer: ${schemeParamName}")`;
  }
  if (t === 'i32' || t === 'c_int' || t === 'i64' || t === 'i16' || t === 'i8') {
    return `(assert! (integer? ${schemeParamName}) "expected integer: ${schemeParamName}")`;
  }
  if (t === 'u32' || t === 'c_uint' || t === 'usize' || t === 'u64' || t === 'u16' || t === 'u8') {
    return `(assert! (and (integer? ${schemeParamName}) (>= ${schemeParamName} 0)) "expected non-negative integer: ${schemeParamName}")`;
  }
  if (t === 'f64' || t === 'c_double' || t === 'f32' || t === 'c_float') {
    return `(assert! (real? ${schemeParamName}) "expected real number: ${schemeParamName}")`;
  }
  if (t === 'bool') {
    return `(assert! (boolean? ${schemeParamName}) "expected boolean: ${schemeParamName}")`;
  }
  return null;
}

function generateScaffold(
  libraryName: string,
  moduleName: string,
  fns: RustFnDecl[],
  safeWrappers: boolean,
): string {
  const lines: string[] = [];

  lines.push(`(import (jerboa prelude))`);
  lines.push('');
  lines.push(`(load-shared-object "${libraryName}")`);
  lines.push('');
  lines.push(';; ── Raw FFI bindings ──────────────────────────────────────────────');

  for (const fn of fns) {
    const schemeName = rustNameToScheme(fn.name);
    const chezArgs = fn.params.map((p) => mapRustTypeToChez(p.rustType));
    const chezReturn = fn.returnType ? mapRustTypeToChez(fn.returnType) : 'void';
    const argsStr = chezArgs.length > 0 ? `(${chezArgs.join(' ')})` : '()';

    lines.push('');
    lines.push(`(def ${schemeName}`);
    lines.push(`  (foreign-procedure "${fn.name}"`);
    lines.push(`    ${argsStr}`);
    lines.push(`    ${chezReturn}))`);
  }

  if (safeWrappers) {
    lines.push('');
    lines.push('');
    lines.push(';; ── Safe wrappers with type guards ───────────────────────────────');

    for (const fn of fns) {
      const rawName = rustNameToScheme(fn.name);
      const safeName = `safe-${rawName}`;
      const paramNames = fn.params.map((p) => rustNameToScheme(p.name));
      const paramsStr = paramNames.length > 0 ? ' ' + paramNames.join(' ') : '';

      const guards = fn.params
        .map((p) => typeGuard(rustNameToScheme(p.name), p.rustType))
        .filter(Boolean) as string[];

      const chezReturn = fn.returnType ? mapRustTypeToChez(fn.returnType) : 'void';
      const isPointerReturn =
        fn.returnType.startsWith('*') || chezReturn === '(* void)';

      lines.push('');
      lines.push(`(def (${safeName}${paramsStr})`);
      for (const g of guards) lines.push(`  ${g}`);
      if (isPointerReturn) {
        lines.push(`  (let ([result (${rawName}${paramsStr})])`);
        lines.push(`    (assert! (not (zero? result)) "${rawName} returned null pointer")`);
        lines.push(`    result))`);
      } else {
        lines.push(`  (${rawName}${paramsStr}))`);
      }
    }

    // Resource wrappers for create/destroy pairs
    const pairs = detectResourcePairs(fns);
    if (pairs.length > 0) {
      lines.push('');
      lines.push('');
      lines.push(';; ── Resource wrappers (with-resource compatible) ─────────────────');

      for (const { typeName, createFn, destroyFn } of pairs) {
        const recName = rustNameToScheme(typeName);
        const safeMake = `safe-${rustNameToScheme(createFn.name)}`;
        const rawDestroy = rustNameToScheme(destroyFn.name);
        const paramNames = createFn.params.map((p) => rustNameToScheme(p.name));
        const paramsStr = paramNames.length > 0 ? ' ' + paramNames.join(' ') : '';

        lines.push('');
        lines.push(`(def (call-with-${recName}${paramsStr} proc)`);
        lines.push(`  (let ([handle (${safeMake}${paramsStr})])`);
        lines.push(`    (unwind-protect`);
        lines.push(`      (proc handle)`);
        lines.push(`      (${rawDestroy} handle))))`);
      }
    }
  }

  // Test skeleton
  lines.push('');
  lines.push('');
  lines.push(`;; ── Test skeleton ─────────────────────────────────────────────────`);
  lines.push(`(import (jerboa test))`);
  lines.push('');
  lines.push(`(test-suite "${moduleName} FFI"`);
  for (const fn of fns) {
    const name = safeWrappers
      ? `safe-${rustNameToScheme(fn.name)}`
      : rustNameToScheme(fn.name);
    lines.push(`  (test "${name} is a procedure"`);
    lines.push(`    (assert! (procedure? ${name})))`);
  }
  lines.push(')');

  return lines.join('\n');
}

export function registerAiScaffoldTool(server: McpServer): void {
  server.registerTool(
    'jerboa_ai_scaffold',
    {
      title: 'AI/ML FFI Scaffold from Rust Signatures',
      description:
        'Generate Jerboa FFI bindings from Rust extern "C" function signatures. ' +
        'Paste function declarations from a Rust crate\'s C API (cbindgen output, manual extern "C" fns, ' +
        'or an extern "C" { ... } block). Produces: load-shared-object, foreign-procedure declarations, ' +
        'safe wrappers with type guards, resource wrappers (unwind-protect) for create/destroy pairs, ' +
        'and a test skeleton. Handles Rust primitives (i32, f64, usize, *mut T) and libc types (c_int, c_double).',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        signatures: z
          .string()
          .describe(
            'Rust extern "C" function signatures, one per line. Accepts pub extern "C" fn ..., ' +
              'or an extern "C" { fn ...; } block. Example:\n' +
              '  pub extern "C" fn model_new(layers: i32) -> *mut Model;\n' +
              '  pub extern "C" fn model_free(m: *mut Model);\n' +
              '  pub extern "C" fn model_predict(m: *const Model, x: *const f32, len: usize) -> f64;',
          ),
        library_name: z
          .string()
          .describe('Shared library filename to load (e.g. "libtch.so", "libndarray.so")'),
        module_name: z
          .string()
          .optional()
          .describe('Module/crate name for comments and test suite label (default: derived from library_name)'),
        safe_wrappers: z
          .boolean()
          .optional()
          .describe('Generate safe wrapper functions with type guards (default: true)'),
      },
    },
    async ({ signatures, library_name, module_name, safe_wrappers }) => {
      const useSafe = safe_wrappers !== false;
      const modName =
        module_name ?? library_name.replace(/^lib/, '').replace(/\.so.*$|\.dylib$|\.dll$/, '');

      const { fns, skipped } = parseRustSignatures(signatures);

      if (fns.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'No function declarations found.\n' +
                'Expected: `pub extern "C" fn name(param: type) -> ReturnType;`\n' +
                (skipped.length > 0 ? `Skipped lines:\n${skipped.map((l) => `  ${l}`).join('\n')}` : ''),
            },
          ],
          isError: true,
        };
      }

      const pairs = detectResourcePairs(fns);
      const code = generateScaffold(library_name, modName, fns, useSafe);

      const summary: string[] = [
        `; Generated Jerboa FFI bindings for ${library_name}`,
        `; Functions: ${fns.length}`,
        `; Resource pairs: ${pairs.length}${pairs.length > 0 ? ' (' + pairs.map((p) => p.typeName).join(', ') + ')' : ''}`,
        skipped.length > 0 ? `; Skipped (unparseable): ${skipped.length}` : `; No parse errors`,
        '',
        code,
      ];

      if (skipped.length > 0) {
        summary.push('');
        summary.push(`; Skipped lines:\n${skipped.map((l) => `;   ${l}`).join('\n')}`);
      }

      return {
        content: [{ type: 'text' as const, text: summary.join('\n') }],
      };
    },
  );
}
