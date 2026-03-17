import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Tokenize a Scheme expression into a flat list of tokens.
 * Preserves parens/brackets/braces as individual tokens.
 * Skips line comments.
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
 * Reconstruct an approximate s-expr string from a token list.
 */
function reconstructExpr(tokens: string[]): string {
  const parts: string[] = [];
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '(' || t === '[' || t === '{') {
      parts.push(t);
      depth++;
    } else if (t === ')' || t === ']' || t === '}') {
      // Remove trailing space before closing delimiter
      if (parts.length > 0 && parts[parts.length - 1] === ' ') parts.pop();
      parts.push(t);
      depth--;
      if (depth > 0 && i < tokens.length - 1) parts.push(' ');
    } else {
      parts.push(t);
      if (i < tokens.length - 1) parts.push(' ');
    }
  }

  return parts.join('');
}

export function registerBoilerplateConverterTool(server: McpServer): void {
  server.registerTool(
    'jerboa_boilerplate_converter',
    {
      title: 'Boilerplate Converter',
      description:
        'Convert 2+ similar Scheme expressions into a macro definition automatically. ' +
        'Given a list of similar expressions, extracts the common pattern and generates a ' +
        'defrule macro with appropriate pattern variables. Returns both the macro and replacement invocations.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        expressions: z
          .array(z.string())
          .min(2)
          .describe('2+ similar Scheme expressions (as strings)'),
        macro_name: z
          .string()
          .optional()
          .describe('Name for the generated macro (default: "my-macro")'),
      },
    },
    async ({ expressions, macro_name }) => {
      const name = macro_name ?? 'my-macro';

      // Tokenize all expressions
      const tokenized = expressions.map((e) => tokenize(e));

      // All expressions must have the same token count for this approach to work
      const lengths = tokenized.map((t) => t.length);
      const allSameLength = lengths.every((l) => l === lengths[0]);

      if (!allSameLength) {
        // Fall back to best-effort: use the most common length
        const freq = new Map<number, number>();
        for (const l of lengths) freq.set(l, (freq.get(l) ?? 0) + 1);
        let maxFreq = 0;
        let targetLen = lengths[0];
        for (const [l, f] of freq) {
          if (f > maxFreq) {
            maxFreq = f;
            targetLen = l;
          }
        }
        const filtered = tokenized.filter((t) => t.length === targetLen);
        if (filtered.length < 2) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'Error: Expressions have too different structures to extract a common pattern.\n' +
                  `Token counts: ${lengths.join(', ')}\n` +
                  'Tip: Provide expressions with the same syntactic shape.',
              },
            ],
            isError: true,
          };
        }
        // Continue with filtered subset
        const filteredExpressions = expressions.filter((_, i) => tokenized[i].length === targetLen);
        return runConversion(filteredExpressions, filtered, name);
      }

      return runConversion(expressions, tokenized, name);
    },
  );
}

function runConversion(
  expressions: string[],
  tokenized: string[][],
  macroName: string,
): { content: Array<{ type: 'text'; text: string }> } {
  const len = tokenized[0].length;

  // Find positions where tokens differ across expressions
  const varPositions: number[] = [];
  const fixedTokens = tokenized[0].slice();

  for (let pos = 0; pos < len; pos++) {
    const first = tokenized[0][pos];
    const varies = tokenized.some((t) => t[pos] !== first);
    if (varies) {
      varPositions.push(pos);
    }
  }

  if (varPositions.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            'All expressions are identical — no pattern variables needed.\n' +
            'No macro conversion necessary.',
        },
      ],
    };
  }

  // Assign pattern variable names: var1, var2, ...
  const varNames: string[] = varPositions.map((_, i) => `var${i + 1}`);

  // Build pattern template tokens
  const templateTokens = fixedTokens.slice();
  for (let vi = 0; vi < varPositions.length; vi++) {
    templateTokens[varPositions[vi]] = varNames[vi];
  }

  // Build macro pattern (head + vars): (macro-name var1 var2 ...)
  const patternHead = `(${macroName} ${varNames.join(' ')})`;

  // Build template expression
  const templateExpr = reconstructExpr(templateTokens);

  const macroDef = [`(defrule ${patternHead}`, `  ${templateExpr})`].join('\n');

  // Generate invocations — extract the varying tokens for each expression
  const invocations = tokenized.map((toks) => {
    const varVals = varPositions.map((p) => toks[p]);
    return `(${macroName} ${varVals.join(' ')})`;
  });

  // Code reduction stats
  const exprLines = expressions.reduce((acc, e) => acc + e.split('\n').length, 0);
  const macroLines = macroDef.split('\n').length;
  const invocationLines = invocations.length;
  const afterLines = macroLines + invocationLines;
  const savedLines = exprLines - afterLines;

  // Estimate savings at N=10
  const macroLinesConst = macroLines;
  const invLineEach = 1; // typically one line per invocation
  const beforeN10 = exprLines * (10 / Math.max(expressions.length, 1));
  const afterN10 = macroLinesConst + 10 * invLineEach;
  const pctSaved = Math.round((1 - afterN10 / Math.max(beforeN10, 1)) * 100);

  const output: string[] = [
    'Generated macro:',
    '```scheme',
    macroDef,
    '```',
    '',
    'Invocations:',
    '```scheme',
    ...invocations,
    '```',
    '',
    `Code reduction: ${expressions.length} expressions → 1 macro + ${invocations.length} invocations` +
      (savedLines > 0
        ? ` (net: -${savedLines} line${savedLines !== 1 ? 's' : ''}, ~${pctSaved}% less for N=10)`
        : ` (net: ${savedLines >= 0 ? '+' : ''}${savedLines} lines, ~${pctSaved}% less for N=10)`),
    '',
    `Pattern variables (${varPositions.length}): ${varNames.join(', ')}`,
    `Varying token positions: ${varPositions.join(', ')}`,
  ];

  if (varPositions.length > 5) {
    output.push('');
    output.push(
      'Note: Many varying positions detected. The expressions may differ too much ' +
        'for a simple macro — consider a function instead.',
    );
  }

  return { content: [{ type: 'text' as const, text: output.join('\n') }] };
}
