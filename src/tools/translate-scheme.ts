import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface TranslationRule {
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
  warning?: string;
  category: 'syntax' | 'function' | 'import' | 'macro' | 'pattern';
}

const TRANSLATION_RULES: TranslationRule[] = [
  // ── Syntax transforms ─────────────────────────────────────────
  {
    // Gerbil-style (define (f args) body) → Jerboa (define (f args) body) — same
    // But Gerbil-specific def → define
    pattern: /\(def\s+\((\w[^\s)]*)\s/g,
    replacement: '(define ($1 ',
    category: 'syntax',
    warning: 'Gerbil def → Jerboa/R7RS define.',
  },
  {
    pattern: /\(def\s+(\w[^\s)]*)\s/g,
    replacement: '(define $1 ',
    category: 'syntax',
    warning: 'Gerbil def → Jerboa/R7RS define.',
  },
  {
    // R7RS define-record-type → Jerboa define-record-type (same) or defstruct
    pattern: /\(define-record-type\s+<(\w+)>/g,
    replacement: '(define-record-type $1',
    category: 'syntax',
    warning: 'R7RS define-record-type: removed angle brackets from type name for Jerboa/Chez.',
  },
  {
    // Racket struct → Jerboa define-record-type
    pattern: /\(struct\s+(\w+)\s+\(([^)]*)\)/g,
    replacement: (_, name, fields) => {
      const fieldList = fields.trim().split(/\s+/).filter(Boolean);
      const fieldDefs = fieldList.map((f: string) => `(${f} ${name}-${f} set-${name}-${f}!)`).join('\n  ');
      return `(define-record-type ${name}\n  (make-${name} ${fieldList.join(' ')})\n  ${name}?\n  ${fieldDefs})`;
    },
    category: 'syntax',
    warning: 'Racket struct → Jerboa define-record-type. Constructor is make-<name>, predicate is <name>?.',
  },
  {
    // Gerbil defstruct → define-record-type
    pattern: /\(defstruct\s+(\w+)\s+\(([^)]*)\)[^)]*\)/g,
    replacement: (_, name, fields) => {
      const fieldList = fields.trim().split(/\s+/).filter(Boolean);
      const fieldDefs = fieldList.map((f: string) => `(${f} ${name}-${f} set-${name}-${f}!)`).join('\n  ');
      return `(define-record-type ${name}\n  (make-${name} ${fieldList.join(' ')})\n  ${name}?\n  ${fieldDefs})`;
    },
    category: 'syntax',
    warning: 'Gerbil defstruct → Jerboa define-record-type.',
  },

  // ── Exception handling ─────────────────────────────────────────
  {
    // Gerbil with-catch → Jerboa guard
    pattern: /\(with-catch\s+(lambda\s*\([^)]+\)[^)]+)\s+(lambda\s*\(\)\s*([^)]+))\)/g,
    replacement: '(guard (exn [else (let ((e exn)) $1)]) $2)',
    category: 'pattern',
    warning: 'Gerbil with-catch → Jerboa guard. Manually adjust the exception binding syntax.',
  },
  {
    // Gerbil try/catch → guard
    pattern: /\(try\s/g,
    replacement: '(guard (exn ',
    category: 'pattern',
    warning: 'Gerbil try → Jerboa guard. Syntax differs: (guard (e [condition handler]) body...).',
  },

  // ── Import/export ────────────────────────────────────────────
  {
    // Racket require → import
    pattern: /\(require\s+([^)]+)\)/g,
    replacement: '(import $1)',
    category: 'import',
    warning: 'Racket require → Jerboa import. Module paths need manual translation to (lib module) form.',
  },
  {
    // Racket provide → export
    pattern: /\(provide\s+([^)]+)\)/g,
    replacement: '(export $1)',
    category: 'import',
  },
  {
    // Gerbil :std/sort → (std sort)
    pattern: /(?<=\(import\s+):std\/([a-zA-Z0-9/]+)/g,
    replacement: (_, path) => `(std ${path.replace(/\//g, ' ')})`,
    category: 'import',
    warning: 'Gerbil :std/ module path → Jerboa (std ...) form.',
  },

  // ── Macro system ──────────────────────────────────────────────
  {
    // Gerbil defrule → define-syntax + syntax-rules
    pattern: /\(defrule\s+(\w+)\s+\(([^)]*)\)\s+([^)]+)\)/g,
    replacement: '(define-syntax $1 (syntax-rules () (($1 $2) $3)))',
    category: 'macro',
    warning: 'Gerbil defrule → Jerboa define-syntax with syntax-rules.',
  },
  {
    // define-syntax-rule → define-syntax with syntax-rules
    pattern: /\(define-syntax-rule\s+\((\w+)([^)]*)\)\s+/g,
    replacement: '(define-syntax $1 (syntax-rules () (($1$2) ',
    category: 'macro',
    warning: 'define-syntax-rule → Jerboa define-syntax with syntax-rules. Add closing )).',
  },

  // ── Function renames ──────────────────────────────────────────
  {
    // Gerbil hash-put! → hash-set! (R7RS/SRFI-69)
    pattern: /\bhash-put!\b/g,
    replacement: 'hash-set!',
    category: 'function',
    warning: 'Gerbil hash-put! → Jerboa hash-set! (SRFI-69 mutable hash tables).',
  },
  {
    // Gerbil hash-get → hash-ref
    pattern: /\bhash-get\b/g,
    replacement: 'hash-ref',
    category: 'function',
    warning: 'Gerbil hash-get → Jerboa hash-ref. Note: hash-ref raises error for missing key by default.',
  },
  {
    // Gerbil hash-key? → hash-ref with default
    pattern: /\bhash-key\?\b/g,
    replacement: 'hash-ref',
    category: 'function',
    warning: 'Gerbil hash-key? has no direct Jerboa equivalent. Use (hash-ref h k #f) to check.',
  },
  {
    // Gerbil make-hash-table → make-hashtable or make-equal-hashtable
    pattern: /\bmake-hash-table\b/g,
    replacement: 'make-equal-hashtable',
    category: 'function',
    warning: 'Gerbil make-hash-table → Jerboa make-equal-hashtable (uses equal? for keys).',
  },
  {
    // Gerbil for/collect → map or filter-map
    pattern: /\bfor\/collect\b/g,
    replacement: 'map',
    category: 'function',
    warning: 'Gerbil for/collect → Jerboa map (for simple cases). For iteration over ranges, use do or iota.',
  },
  {
    // Gerbil displayln → display + newline
    pattern: /\bdisplayln\b/g,
    replacement: 'display',
    category: 'function',
    warning: 'Gerbil displayln → Jerboa display. Add (newline) after or use (begin (display x) (newline)).',
  },
  {
    // Gerbil string-contains → string-search-forward
    pattern: /\bstring-contains\b/g,
    replacement: 'string-search-forward',
    category: 'function',
    warning: 'Gerbil string-contains → Chez string-search-forward (returns index or #f).',
  },
  {
    // Gerbil object->string → format or with-output-to-string
    pattern: /\bobject->string\b/g,
    replacement: 'format #f "~a"',
    category: 'function',
    warning: 'Gerbil object->string → Jerboa (format #f "~a" obj) for display representation.',
  },

  // ── R7RS specific ─────────────────────────────────────────────
  {
    // R7RS (import (scheme ...)) — mostly built-in in Chez
    pattern: /\(import\s+\(scheme\s+[^)]+\)\)/g,
    replacement: '; R7RS (scheme ...) import removed — Chez has these built-in',
    category: 'import',
    warning: 'R7RS (import (scheme ...)) libraries are mostly built into Chez Scheme.',
  },
  {
    // R7RS error-object? → condition? in Chez
    pattern: /\berror-object\?\b/g,
    replacement: 'condition?',
    category: 'function',
    warning: 'R7RS error-object? → Chez condition?.',
  },
  {
    // R7RS error-message → condition/message
    pattern: /\berror-object-message\b/g,
    replacement: 'condition/report-string',
    category: 'function',
    warning: 'R7RS error-object-message → Chez condition/report-string.',
  },
];

/** Module path mappings from Racket/Gerbil to Jerboa (std ...) form */
const MODULE_MAPPINGS: Record<string, string> = {
  'racket/list': '(std list)',
  'racket/string': '(std string)',
  'racket/port': '(std io)',
  'json': '(std text json)',
  'net/url': '(std net http)',
  'racket/format': '(std format)',
  'srfi/1': '(std srfi 1)',
  'srfi/13': '(std srfi 13)',
  'srfi/19': '(std srfi 19)',
  'racket/system': '(std os)',
  'racket/tcp': '(std net socket)',
  ':std/iter': '(std iter)',
  ':std/sugar': '(jerboa prelude)',
  ':std/test': '(std test)',
  ':std/format': '(std format)',
  ':std/sort': '(std sort)',
  ':std/text/json': '(std text json)',
  ':std/pregexp': '(std pregexp)',
  ':std/actor': '(std actor)',
  ':std/db/sqlite': '(std db sqlite)',
  ':std/db/postgresql': '(std db postgresql)',
  ':std/os': '(std os)',
  ':std/net/httpd': '(std net http)',
  ':std/misc/list': '(std list)',
  ':std/misc/string': '(std string)',
};

export function registerTranslateSchemeTool(server: McpServer): void {
  server.registerTool(
    'jerboa_translate_scheme',
    {
      title: 'Translate Scheme to Jerboa',
      description:
        'Mechanically translate R7RS, Racket, or Gerbil Scheme code to idiomatic Jerboa. ' +
        'Handles syntax transforms (def→define, defstruct→define-record-type), ' +
        'function renames (hash-put!→hash-set!, displayln→display+newline), ' +
        'import translation (require→import, :std/sort→(std sort)), ' +
        'exception handling (with-catch/try→guard), and macro differences ' +
        '(defrule→define-syntax). ' +
        'Returns translated code plus semantic warnings where behavior differs.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        code: z
          .string()
          .describe('Scheme (R7RS, Racket, or Gerbil) code to translate'),
        dialect: z
          .enum(['racket', 'r7rs', 'gerbil', 'auto'])
          .optional()
          .describe('Source dialect (default: auto-detect)'),
      },
    },
    async ({ code, dialect }) => {
      const warnings: string[] = [];
      let translated = code;

      // Auto-detect dialect
      const effectiveDialect = dialect || (
        code.includes('#lang racket') || code.includes('(require ') ? 'racket' :
        code.includes('(import (scheme') || code.includes('define-record-type') ? 'r7rs' :
        (code.includes('(def ') || code.includes(':std/') || code.includes('with-catch')) ? 'gerbil' :
        'auto'
      );

      // Remove #lang line if present
      if (translated.includes('#lang ')) {
        translated = translated.replace(/^#lang\s+\S+\s*\n?/m, '');
        warnings.push('Removed #lang directive (Jerboa/Chez does not use #lang).');
      }

      // Apply translation rules
      for (const rule of TRANSLATION_RULES) {
        const before = translated;
        if (typeof rule.replacement === 'string') {
          translated = translated.replace(rule.pattern, rule.replacement);
        } else {
          translated = translated.replace(rule.pattern, rule.replacement as (...args: string[]) => string);
        }
        if (before !== translated && rule.warning) {
          warnings.push(rule.warning);
        }
      }

      // Translate module paths in imports
      for (const [srcMod, jerboaMod] of Object.entries(MODULE_MAPPINGS)) {
        if (translated.includes(srcMod)) {
          translated = translated.replace(
            new RegExp(srcMod.replace(/[/:]/g, (c) => `\\${c}`), 'g'),
            jerboaMod,
          );
          warnings.push(`Module: ${srcMod} → ${jerboaMod}`);
        }
      }

      // Check for remaining Gerbil/Racket-isms
      if (/\(module\s/.test(translated)) {
        warnings.push('Racket (module ...) form detected — Jerboa uses file-based modules with (import ...).');
      }
      if (/\(define\/contract\b/.test(translated)) {
        warnings.push('define/contract has no Jerboa equivalent — use assertions or pre/postcondition checks manually.');
      }
      if (/\(class\s/.test(translated)) {
        warnings.push('Racket class system → Jerboa uses define-record-type with different syntax. Manual translation needed.');
      }
      if (/\bspawn\/name\b/.test(translated)) {
        warnings.push('Gerbil spawn/name → Jerboa spawn (without name arg). Named actors are managed differently.');
      }
      if (/<-\s/.test(translated)) {
        warnings.push('Gerbil <- (receive) → Jerboa (receive). Check actor message receive API.');
      }
      if (/\bdisplayln\b/.test(translated)) {
        warnings.push('Remaining displayln: wrap as (begin (display x) (newline)) or define a helper.');
      }

      // Format output
      const sections: string[] = [
        `## Translated Code (${effectiveDialect} → Jerboa)\n`,
        '```scheme',
        translated,
        '```',
      ];

      if (warnings.length > 0) {
        sections.push('');
        sections.push('## Semantic Warnings\n');
        for (const w of warnings) {
          sections.push(`- ${w}`);
        }
      }

      sections.push('');
      sections.push('## Recommended Next Steps\n');
      sections.push('1. `jerboa_check_syntax` — verify the translated code parses');
      sections.push('2. `jerboa_compile_check` — catch unbound identifiers');
      sections.push('3. `jerboa_suggest_imports` — resolve any missing imports');
      sections.push('4. `jerboa_howto` — search for idiomatic Jerboa patterns');

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
