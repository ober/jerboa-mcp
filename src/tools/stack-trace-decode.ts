import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface ParsedError {
  exceptionType: string;
  procedure?: string;
  message?: string;
  irritants?: string;
  sourcePosition?: string;
  conditionType?: string;
  context: string[];
}

function parseChezTrace(trace: string): ParsedError {
  const lines = trace.split('\n');
  const result: ParsedError = {
    exceptionType: 'Exception',
    context: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Exception in <proc>: <message>
    const exceptionIn = line.match(/^Exception in ([^:]+):\s*(.+)$/);
    if (exceptionIn) {
      result.exceptionType = 'Exception';
      result.procedure = exceptionIn[1].trim();
      result.message = exceptionIn[2].trim();
      continue;
    }

    // Exception: <message>
    const exceptionSimple = line.match(/^Exception:\s*(.+)$/);
    if (exceptionSimple) {
      result.exceptionType = 'Exception';
      result.message = exceptionSimple[1].trim();
      continue;
    }

    // Assertion violation / contract violation
    const assertionIn = line.match(/^(Assertion violation|Contract violation) in ([^:]+):\s*(.+)$/);
    if (assertionIn) {
      result.exceptionType = assertionIn[1];
      result.procedure = assertionIn[2].trim();
      result.message = assertionIn[3].trim();
      continue;
    }

    const assertionSimple = line.match(/^(Assertion violation|Contract violation):\s*(.+)$/);
    if (assertionSimple) {
      result.exceptionType = assertionSimple[1];
      result.message = assertionSimple[2].trim();
      continue;
    }

    // Type: <condition-type>
    const condType = line.match(/^Type:\s*(.+)$/);
    if (condType) {
      result.conditionType = condType[1].trim();
      continue;
    }

    // Irritants: <values>
    const irritants = line.match(/^Irritants?:\s*(.+)$/i);
    if (irritants) {
      result.irritants = irritants[1].trim();
      continue;
    }

    // Source position: "at line X column Y of ..." or "in file ..."
    const srcPos = line.match(/\bat\s+line\s+(\d+)\s+column\s+(\d+)\s+of\s+(.+)$/i);
    if (srcPos) {
      result.sourcePosition = `line ${srcPos[1]}, column ${srcPos[2]} of ${srcPos[3].trim()}`;
      continue;
    }

    const srcFile = line.match(/\bin\s+file\s+"([^"]+)"/i);
    if (srcFile) {
      result.sourcePosition = `in file "${srcFile[1]}"`;
      continue;
    }

    // Continuation marks / backtrace context lines — indent-prefixed or plain
    if (line.startsWith('  ') || line.startsWith('\t') || /^\s+\d+\.\s/.test(line)) {
      result.context.push(line);
      continue;
    }

    // Collect any other non-empty lines as context
    if (line.trim() && !result.message) {
      result.context.push(line);
    } else if (line.trim()) {
      result.context.push(line);
    }
  }

  return result;
}

function buildHints(parsed: ParsedError): string[] {
  const hints: string[] = [];
  const msg = (parsed.message ?? '').toLowerCase();

  if (msg.includes('not bound') || msg.includes('unbound') || msg.includes('is not defined')) {
    hints.push(
      'Tip: use `jerboa_suggest_imports` to find which module exports the missing binding.',
    );
  }

  if (
    msg.includes('incorrect argument count') ||
    msg.includes('wrong number of arguments') ||
    msg.includes('arity mismatch')
  ) {
    hints.push(
      'Tip: use `jerboa_function_signature` to check the expected arity of the procedure.',
    );
  }

  if (
    msg.includes('non-procedure') ||
    msg.includes('not a procedure') ||
    msg.includes('apply non-procedure')
  ) {
    hints.push(
      'Tip: use `jerboa_describe` to inspect the value that was called as a procedure.',
    );
  }

  return hints;
}

export function registerStackTraceDecodeTool(server: McpServer): void {
  server.registerTool(
    'jerboa_stack_trace_decode',
    {
      title: 'Stack Trace Decode',
      description:
        'Parse Chez Scheme error output and condition traces into a readable form. ' +
        'Extracts condition types, messages, irritants, continuation info, and source positions ' +
        'from Chez error output.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        trace: z.string().describe('Raw error output or stack trace from Chez'),
      },
    },
    ({ trace }) => {
      const parsed = parseChezTrace(trace);
      const hints = buildHints(parsed);

      const parts: string[] = [];

      parts.push('## Error Analysis');
      parts.push('');
      parts.push(`**Exception type:** ${parsed.conditionType ?? parsed.exceptionType}`);

      if (parsed.procedure) {
        parts.push(`**Procedure:** ${parsed.procedure}`);
      }

      if (parsed.message) {
        parts.push(`**Message:** ${parsed.message}`);
      }

      if (parsed.irritants) {
        parts.push(`**Irritants:** ${parsed.irritants}`);
      }

      if (parsed.sourcePosition) {
        parts.push(`**Source position:** ${parsed.sourcePosition}`);
      }

      if (parsed.context.length > 0) {
        parts.push('');
        parts.push('## Stack Context');
        parts.push('');
        parts.push(parsed.context.join('\n'));
      }

      if (hints.length > 0) {
        parts.push('');
        parts.push('## Suggestions');
        parts.push('');
        for (const h of hints) {
          parts.push(`- ${h}`);
        }
      }

      parts.push('');
      parts.push('## Raw Input');
      parts.push('');
      parts.push('```');
      parts.push(trace.trim());
      parts.push('```');

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );
}
