import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface SignalInfo {
  name: string;
  number: number;
}

const KNOWN_SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
};

function resolveSignals(names: string[]): SignalInfo[] {
  return names.map((name) => {
    const upper = name.toUpperCase();
    const num = KNOWN_SIGNALS[upper] ?? -1;
    return { name: upper, number: num };
  });
}

function generateSchemeCode(signals: SignalInfo[], logFile: string): string {
  const lines: string[] = [];

  lines.push('; Generated signal trace instrumentation');
  lines.push('; Usage: (import (signal-trace)) then call (start-signal-trace!)');
  lines.push('');
  lines.push('(library (signal-trace)');
  lines.push('  (export start-signal-trace! stop-signal-trace!)');
  lines.push('  (import (chezscheme))');
  lines.push('');
  lines.push(`  (define trace-path "${logFile}")`);
  lines.push('  (define trace-port #f)');
  lines.push('');
  lines.push('  ;;; Write a timestamped line to the trace log');
  lines.push('  (define (trace-log! msg)');
  lines.push('    (when trace-port');
  lines.push('      (let* ((t (current-time))');
  lines.push('             (s (time-second t))');
  lines.push('             (ns (time-nanosecond t))');
  lines.push('             (line (string-append');
  lines.push('                     (number->string s)');
  lines.push('                     "."');
  lines.push('                     (number->string (quotient ns 1000000))');
  lines.push('                     " "');
  lines.push('                     msg');
  lines.push('                     "\\n")))');
  lines.push('        (display line trace-port)');
  lines.push('        (flush-output-port trace-port))))');
  lines.push('');
  lines.push('  ;;; Install signal handlers and start logging');
  lines.push('  (define (start-signal-trace!)');
  lines.push('    (set! trace-port');
  lines.push('      (open-file-output-port trace-path');
  lines.push('        (file-options no-fail)');
  lines.push('        (buffer-mode line)');
  lines.push('        (native-transcoder)))');
  lines.push('    (trace-log! "Signal tracing started")');
  lines.push('');

  for (const sig of signals) {
    if (sig.number < 0) {
      lines.push(`    ; NOTE: Unknown signal number for ${sig.name} — handler skipped`);
      lines.push(`    ; Replace -1 with the correct number for your platform if needed`);
    }
    lines.push(`    ; Install handler for ${sig.name} (signal ${sig.number})`);
    const sigName = sig.name;
    const sigNum = sig.number;
    lines.push('    (guard (e [else (trace-log! (string-append "WARN: Could not install ' + sigName + ' handler: "');
    lines.push('                              (condition/report-string e)))])');
    lines.push('      (signal-handler-set! ' + sigNum);
    lines.push('        (lambda (n)');
    lines.push(
      `          (trace-log! (string-append "SIGNAL received: ${sig.name} (sig=" (number->string n) ")"))))`,
    );
    lines.push('');
  }

  lines.push('    ; Wrap with-exception-handler to log uncaught conditions');
  lines.push('    (let ((prev (condition-handler)))');
  lines.push('      (condition-handler');
  lines.push('        (lambda (e)');
  lines.push('          (guard (inner [else #f])');
  lines.push('            (trace-log! (string-append "EXCEPTION: " (condition/report-string e))))');
  lines.push('          (prev e))))');
  lines.push('');
  lines.push('    (trace-log! "Signal handlers installed"))');
  lines.push('');
  lines.push('  ;;; Stop tracing and close the log file');
  lines.push('  (define (stop-signal-trace!)');
  lines.push('    (when trace-port');
  lines.push('      (trace-log! "Signal tracing stopped")');
  lines.push('      (close-port trace-port)');
  lines.push('      (set! trace-port #f))))');

  return lines.join('\n');
}

export function registerSignalTraceTool(server: McpServer): void {
  server.registerTool(
    'jerboa_signal_trace',
    {
      title: 'Signal Trace',
      description:
        'Generate Chez Scheme instrumentation code for tracing signal delivery and condition ' +
        'handler execution. Creates a library module that logs when signals are received, ' +
        'when handlers execute, and when exceptions occur. ' +
        'Useful for debugging unresponsive CTRL-C or hang issues.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        signals: z
          .array(z.string())
          .optional()
          .describe('Signal names to trace (default: ["SIGINT", "SIGTERM", "SIGHUP"])'),
        log_file: z
          .string()
          .optional()
          .describe('Log file path (default: "/tmp/jerboa-signal-trace.log")'),
      },
    },
    async ({ signals, log_file }) => {
      const signalNames = signals ?? ['SIGINT', 'SIGTERM', 'SIGHUP'];
      const logFile = log_file ?? '/tmp/jerboa-signal-trace.log';

      const resolved = resolveSignals(signalNames);
      const unknownSignals = resolved.filter((s) => s.number < 0);

      const code = generateSchemeCode(resolved, logFile);

      const output: string[] = [
        '## Signal Trace Instrumentation',
        '',
        `Signals traced: ${resolved.map((s) => `${s.name} (${s.number})`).join(', ')}`,
        `Log file: ${logFile}`,
        '',
      ];

      if (unknownSignals.length > 0) {
        output.push(
          `**Warning**: Unknown signal numbers for: ${unknownSignals.map((s) => s.name).join(', ')}. ` +
            'These handlers are omitted. Check your platform signal table.',
        );
        output.push('');
      }

      output.push('```scheme');
      output.push(code);
      output.push('```');
      output.push('');
      output.push('### Usage');
      output.push('');
      output.push('1. Save the above as `lib/signal-trace.ss`');
      output.push('2. In your main module:');
      output.push('```scheme');
      output.push('(import (signal-trace))');
      output.push('(start-signal-trace!)');
      output.push('; ... your code here ...');
      output.push('(stop-signal-trace!)');
      output.push('```');
      output.push(`3. Monitor the log: \`tail -f ${logFile}\``);
      output.push('');
      output.push('### Signal numbers used');
      output.push('');
      for (const sig of resolved) {
        output.push(`- \`${sig.name}\` = ${sig.number >= 0 ? sig.number : 'UNKNOWN'}`);
      }
      output.push('');
      output.push(
        '**Note**: Signal numbers are Linux/POSIX values. ' +
          'Verify with `kill -l` on your system. ' +
          'Use `jerboa_module_exports` to check available signal APIs in your Jerboa version.',
      );

      return { content: [{ type: 'text' as const, text: output.join('\n') }] };
    },
  );
}
