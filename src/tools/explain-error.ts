import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Recipe {
  id: string;
  title: string;
  tags: string[];
  code: string;
  imports: string[];
  notes?: string;
}

/**
 * Known Chez/Jerboa error patterns with explanations and suggested tool calls.
 */
const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  explanation: string;
  suggestedTools: string[];
  cookbookTags: string[];
}> = [
  {
    pattern: /wrong number of arguments|incorrect number of arguments/i,
    type: 'Arity Error',
    explanation:
      'A function was called with the wrong number of arguments. This is common in Jerboa ' +
      'due to niche APIs with non-obvious arities, keyword arguments, and optional parameters.',
    suggestedTools: [
      'jerboa_function_signature — check the correct arity and keyword args',
      'jerboa_module_exports — verify the function name is correct',
      'jerboa_eval — reproduce the issue interactively',
    ],
    cookbookTags: ['arity', 'arguments', 'wrong number'],
  },
  {
    pattern: /unbound identifier|variable .* not bound|attempt to apply non-procedure/i,
    type: 'Unbound Identifier',
    explanation:
      'A symbol was used but is not defined or imported in the current scope. ' +
      'This usually means a missing import, a misspelled function name, or calling a non-procedure.',
    suggestedTools: [
      'jerboa_module_exports — check what a module actually exports',
      'jerboa_eval — test which module provides the symbol',
      'jerboa_repl_session — interactively explore available bindings',
    ],
    cookbookTags: ['unbound', 'import', 'identifier'],
  },
  {
    pattern: /syntax error|ill-formed|bad syntax/i,
    type: 'Syntax Error',
    explanation:
      'The code has a syntax error — possibly mismatched parentheses, incorrect ' +
      'macro usage, or invalid form structure.',
    suggestedTools: [
      'jerboa_check_balance — check for mismatched delimiters',
      'jerboa_check_syntax — validate syntax',
      'jerboa_expand_macro — debug macro expansion issues',
    ],
    cookbookTags: ['syntax', 'error', 'parse'],
  },
  {
    pattern: /type.*mismatch|expected.*got|not a valid|contract violation/i,
    type: 'Type Error',
    explanation:
      'A function received an argument of the wrong type. Chez Scheme has runtime type ' +
      'checking for primitive operations.',
    suggestedTools: [
      'jerboa_describe — inspect the actual value to see its type',
      'jerboa_function_signature — check expected parameter types',
      'jerboa_eval — test with known-good values',
    ],
    cookbookTags: ['type', 'error', 'argument'],
  },
  {
    pattern: /macro expansion|expand|transformer/i,
    type: 'Macro Expansion Error',
    explanation:
      'A macro failed to expand correctly. This can happen with incorrect macro invocation, ' +
      'wrong number of sub-forms, or issues with the macro definition.',
    suggestedTools: [
      'jerboa_expand_macro — see the fully expanded core form',
      'jerboa_check_syntax — validate the expression',
      'jerboa_eval — test the macro interactively',
    ],
    cookbookTags: ['macro', 'expand', 'syntax'],
  },
  {
    pattern: /division by zero|zero divisor/i,
    type: 'Division by Zero',
    explanation: 'An arithmetic operation attempted to divide by zero.',
    suggestedTools: [
      'jerboa_eval — reproduce and isolate the issue',
      'jerboa_repl_session — trace bindings interactively',
    ],
    cookbookTags: ['division', 'zero', 'arithmetic'],
  },
  {
    pattern: /file not found|no such file|cannot open|ENOENT/i,
    type: 'File Not Found',
    explanation: 'A file or module could not be found. Check file paths and library directories.',
    suggestedTools: [
      'jerboa_eval — test if the module path resolves correctly',
      'jerboa_preflight_check — verify Jerboa environment setup',
    ],
    cookbookTags: ['file', 'path', 'library'],
  },
  {
    pattern: /heap overflow|out of memory|storage exhausted/i,
    type: 'Memory Error',
    explanation: 'The program ran out of memory or triggered excessive GC.',
    suggestedTools: [
      'jerboa_eval — test with smaller inputs',
      'jerboa_repl_session — profile memory usage interactively',
    ],
    cookbookTags: ['memory', 'heap', 'gc'],
  },
  {
    pattern: /attempt to apply non-procedure|not a procedure/i,
    type: 'Non-Procedure Application',
    explanation:
      'Tried to call a value as a function, but it is not a procedure. ' +
      'Common causes: misnamed variable shadowing a procedure, wrong return value used as function.',
    suggestedTools: [
      'jerboa_describe — inspect the value that was applied',
      'jerboa_function_signature — confirm the symbol is a procedure',
      'jerboa_module_exports — check if the right binding is in scope',
    ],
    cookbookTags: ['apply', 'procedure', 'call'],
  },
  {
    // make-time shadowed: prelude exports a datetime make-time, not Chez's SRFI-19 make-time
    pattern: /\bmake-time\b/i,
    type: 'Prelude-Shadowed Builtin: make-time',
    explanation:
      '(jerboa prelude) shadows Chez\'s SRFI-19 `make-time` with a datetime constructor that ' +
      'takes different arguments. If you need the Chez `make-time` (e.g. for `sleep` or timers), ' +
      'capture it before importing the prelude:\n\n' +
      '  (define chez:make-time\n' +
      '    (let () (import (only (chezscheme) make-time)) make-time))\n\n' +
      'Then use `chez:make-time` for duration/monotonic time values:\n' +
      '  (sleep (chez:make-time \'time-duration 0 1))  ; sleep 1 second',
    suggestedTools: [
      'jerboa_eval — test (make-time \'time-duration 0 1) to confirm the shadow',
      'jerboa_function_signature — check the prelude\'s make-time arity',
    ],
    cookbookTags: ['make-time', 'sleep', 'prelude', 'shadow', 'duration'],
  },
  {
    // sort shadowed: prelude uses (sort pred list), Gerbil/SRFI uses (sort list pred)
    pattern: /\bsort\b.*wrong number|wrong number.*\bsort\b|\bsort\b.*type.*mismatch/i,
    type: 'Prelude-Shadowed Builtin: sort',
    explanation:
      '(jerboa prelude) shadows Chez\'s `sort` with a version that takes arguments in ' +
      'Chez order: `(sort predicate list)`. If you are seeing wrong-type or arity errors ' +
      'with sort, check argument order. The Jerboa/Chez order is:\n\n' +
      '  (sort < \'(3 1 2))  ; → (1 2 3)\n\n' +
      'NOT the Gerbil/SRFI order (sort list pred). Also note the prelude\'s sort ' +
      'expects a list, not a vector.',
    suggestedTools: [
      'jerboa_function_signature — check the prelude sort arity',
      'jerboa_eval — test (sort < \'(3 1 2)) directly',
    ],
    cookbookTags: ['sort', 'prelude', 'shadow', 'order', 'predicate'],
  },
  {
    // sleep shadowed: prelude may shadow Chez sleep
    pattern: /\bsleep\b.*wrong|wrong.*\bsleep\b|\bsleep\b.*type/i,
    type: 'Prelude-Shadowed Builtin: sleep',
    explanation:
      'If `sleep` fails with a type error, it may be that you are using the Chez `make-time` ' +
      'form but the prelude\'s `make-time` is shadowing it. The correct pattern for sleeping ' +
      'in Jerboa is:\n\n' +
      '  ; Capture Chez make-time before the prelude shadows it:\n' +
      '  (define chez:make-time\n' +
      '    (let () (import (only (chezscheme) make-time)) make-time))\n' +
      '  (sleep (chez:make-time \'time-duration 0 1))  ; 1 second\n\n' +
      'Or simply use a numeric seconds value if the prelude\'s sleep accepts one.',
    suggestedTools: [
      'jerboa_eval — test (sleep ...) with different argument forms',
      'jerboa_function_signature — check prelude sleep arity',
    ],
    cookbookTags: ['sleep', 'make-time', 'prelude', 'shadow', 'duration'],
  },
  {
    // printf/fprintf shadowed: prelude re-exports improved versions
    pattern: /\bprintf\b.*wrong|wrong.*\bprintf\b|\bfprintf\b.*wrong/i,
    type: 'Prelude-Shadowed Builtin: printf/fprintf',
    explanation:
      '(jerboa prelude) re-exports improved versions of `printf` and `fprintf` that may have ' +
      'different behavior from the raw Chez builtins. If you need the exact Chez printf, ' +
      'use: (let () (import (only (chezscheme) printf)) printf)\n\n' +
      'Other prelude-shadowed Chez builtins: make-hash-table, hash-table?, sort, sort!, ' +
      'path-extension, path-absolute?, with-input-from-string, with-output-to-string, ' +
      'iota, 1+, 1-, partition, make-date, make-time.',
    suggestedTools: [
      'jerboa_eval — test the function directly to see which version is in scope',
      'jerboa_module_exports — compare (jerboa prelude) vs (chezscheme) exports',
    ],
    cookbookTags: ['printf', 'fprintf', 'prelude', 'shadow', 'builtin'],
  },
];

function loadCookbookRecipes(): Recipe[] {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const cookbookPath = join(thisDir, '..', '..', 'cookbooks.json');
    const data = readFileSync(cookbookPath, 'utf-8');
    return JSON.parse(data) as Recipe[];
  } catch {
    return [];
  }
}

function searchCookbook(recipes: Recipe[], tags: string[]): Recipe[] {
  const matches: Array<{ recipe: Recipe; score: number }> = [];
  for (const recipe of recipes) {
    if ((recipe as { deprecated?: boolean }).deprecated) continue;
    let score = 0;
    const searchable = [
      ...recipe.tags,
      recipe.title.toLowerCase(),
      recipe.id.toLowerCase(),
    ].join(' ');
    for (const tag of tags) {
      if (searchable.includes(tag.toLowerCase())) {
        score++;
      }
    }
    if (score > 0) {
      matches.push({ recipe, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 3).map((m) => m.recipe);
}

export function registerExplainErrorTool(server: McpServer): void {
  server.registerTool(
    'jerboa_explain_error',
    {
      title: 'Explain Jerboa Error',
      description:
        'Take a raw Jerboa/Chez error message and return a structured explanation: ' +
        'error type, likely cause, common fix patterns from the cookbook, and suggested ' +
        'tool calls to investigate further. Automates the debugging workflow.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        error_message: z.string().describe('The error message or stack trace from Jerboa/Chez'),
        code: z
          .string()
          .optional()
          .describe('The code that produced the error (if available)'),
      },
    },
    async ({ error_message, code }) => {
      const sections: string[] = [];

      // 1. Match error patterns
      const matched = ERROR_PATTERNS.filter((p) => p.pattern.test(error_message));

      if (matched.length === 0) {
        sections.push('## Error Type\nUnknown/unclassified error\n');
        sections.push('## Raw Error\n```\n' + error_message + '\n```\n');
        sections.push(
          '## Suggested Tools\n' +
          '- `jerboa_eval` — reproduce and isolate the issue\n' +
          '- `jerboa_check_syntax` — check for syntax errors\n' +
          '- `jerboa_describe` — inspect unexpected return values\n' +
          '- `jerboa_repl_session` — explore interactively\n',
        );
      } else {
        for (const match of matched) {
          sections.push(`## Error Type: ${match.type}\n`);
          sections.push(`**Explanation**: ${match.explanation}\n`);
          sections.push(
            '**Suggested Tools**:\n' +
            match.suggestedTools.map((t) => `- \`${t}\``).join('\n') +
            '\n',
          );
        }
      }

      // 2. Search cookbook for relevant recipes
      const allTags = matched.flatMap((m) => m.cookbookTags);
      const errorWords = error_message
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const searchTags = [...new Set([...allTags, ...errorWords.slice(0, 5)])];

      if (searchTags.length > 0) {
        const recipes = loadCookbookRecipes();
        const relevant = searchCookbook(recipes, searchTags);
        if (relevant.length > 0) {
          sections.push(
            '## Related Cookbook Recipes\n' +
            relevant
              .map(
                (r) =>
                  `- **${r.title}** (\`${r.id}\`): ${r.notes?.slice(0, 100) || r.tags.join(', ')}`,
              )
              .join('\n') +
            '\n\nUse `jerboa_howto_get` with the recipe id to view the full code example.\n',
          );
        }
      }

      // 3. If code was provided, suggest specific checks
      if (code) {
        sections.push(
          '## Code Analysis Suggestions\n' +
          'The code that produced this error was provided. Consider:\n' +
          '- `jerboa_check_syntax` — validate syntax\n' +
          '- `jerboa_check_balance` — verify delimiter balance\n' +
          '- `jerboa_lint` — run static analysis\n' +
          '- `jerboa_eval` — test the code directly\n',
        );
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
