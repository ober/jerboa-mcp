import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type CommandPattern = 'echo-message' | 'toggle-mode' | 'echo-read-string' | 'simple' | 'region';

interface CommandSpec {
  name: string;
  pattern: CommandPattern;
  message?: string;
  mode_var?: string;
  description?: string;
}

interface ScaffoldOutput {
  function_defs: string;
  register_calls: string;
  doc_table_rows: string;
}

function toSchemeId(name: string): string {
  // Ensure command name is kebab-case
  return name.replace(/_/g, '-').toLowerCase();
}

function scaffoldCommand(cmd: CommandSpec): {
  funcDef: string;
  registerCall: string;
  docRow: string;
} {
  const id = toSchemeId(cmd.name);
  const desc = cmd.description ?? id.replace(/-/g, ' ');

  let funcDef: string;

  switch (cmd.pattern) {
    case 'echo-message': {
      const msg = cmd.message ?? desc;
      funcDef =
        `(def (cmd-${id} buf)\n` +
        `  (echo-message "${msg}"))`;
      break;
    }

    case 'toggle-mode': {
      const modeVar = cmd.mode_var ?? `*${id}-mode*`;
      funcDef =
        `(def (cmd-${id} buf)\n` +
        `  (set! ${modeVar} (not ${modeVar}))\n` +
        `  (echo-message (if ${modeVar} "${desc}: on" "${desc}: off")))`;
      break;
    }

    case 'echo-read-string': {
      const msg = cmd.message ?? `${desc}: `;
      funcDef =
        `(def (cmd-${id} buf)\n` +
        `  (echo-read-string "${msg}"\n` +
        `    (lambda (input)\n` +
        `      (when input\n` +
        `        (echo-message (str "${desc}: " input))))))`;
      break;
    }

    case 'region': {
      funcDef =
        `(def (cmd-${id} buf)\n` +
        `  (let* ([start (region-start buf)]\n` +
        `         [end   (region-end buf)]\n` +
        `         [text  (buffer-substring buf start end)])\n` +
        `    (echo-message (str "${desc}: " (string-length text) " chars"))))`;
      break;
    }

    case 'simple':
    default: {
      funcDef =
        `(def (cmd-${id} buf)\n` +
        `  (void))`;
      break;
    }
  }

  const registerCall = `(register-command! "${id}" cmd-${id})`;
  const docRow = `| \`${id}\` | ${desc} |`;

  return { funcDef, registerCall, docRow };
}

export function registerBatchCommandScaffoldTool(server: McpServer): void {
  server.registerTool(
    'jerboa_batch_command_scaffold',
    {
      title: 'Batch Command Scaffold',
      description:
        'Generate scaffolded editor command definitions, register-command! calls, and ' +
        'markdown doc table rows for a batch of commands in one call. ' +
        'Designed for jerboa-emacs / jemacs editor command development. ' +
        'Patterns: echo-message (display a fixed string), toggle-mode (boolean toggle with on/off echo), ' +
        'echo-read-string (prompt user for input), region (operate on selected region), ' +
        'simple (empty stub).',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        commands: z
          .array(
            z.object({
              name: z.string().describe('Command name in kebab-case, e.g. "foo-bar"'),
              pattern: z
                .enum(['echo-message', 'toggle-mode', 'echo-read-string', 'region', 'simple'])
                .describe('Scaffold pattern to use'),
              message: z
                .string()
                .optional()
                .describe('Message string for echo-message or echo-read-string prompt'),
              mode_var: z
                .string()
                .optional()
                .describe('Mode variable for toggle-mode, e.g. "*my-mode*"'),
              description: z
                .string()
                .optional()
                .describe('Human-readable description for docs (defaults to name)'),
            }),
          )
          .describe('List of commands to scaffold'),
        separate_sections: z
          .boolean()
          .optional()
          .describe(
            'If true, output function defs, register calls, and doc table separately ' +
            '(for pasting into different files). Default: true.',
          ),
      },
    },
    async ({ commands, separate_sections }) => {
      const sep = separate_sections !== false; // default true

      const funcDefs: string[] = [];
      const registerCalls: string[] = [];
      const docRows: string[] = [];

      for (const cmd of commands) {
        const { funcDef, registerCall, docRow } = scaffoldCommand(cmd as CommandSpec);
        funcDefs.push(funcDef);
        registerCalls.push(registerCall);
        docRows.push(docRow);
      }

      let output: string;

      if (sep) {
        output = [
          `;;; Function definitions (${funcDefs.length} commands)`,
          '',
          funcDefs.join('\n\n'),
          '',
          `;;; register-command! calls (paste into regs.ss or equivalent)`,
          '',
          registerCalls.join('\n'),
          '',
          `;;; Markdown doc table rows (paste into docs)`,
          '',
          '| Command | Description |',
          '|---|---|',
          docRows.join('\n'),
        ].join('\n');
      } else {
        // Interleaved: function + register + doc for each command
        const parts: string[] = [];
        for (let i = 0; i < commands.length; i++) {
          parts.push(funcDefs[i]);
          parts.push(registerCalls[i]);
          parts.push(docRows[i]);
          parts.push('');
        }
        output = parts.join('\n');
      }

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    },
  );
}
