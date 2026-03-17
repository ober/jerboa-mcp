import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const TOPIC_CHANNELS = `## Channels (std misc channel)

Channels provide synchronous message passing between threads.

### Basic Channel
\`\`\`scheme
(import (std misc channel))

; Create a channel
(define ch (make-channel))

; Send (blocks until receiver ready)
(channel-send ch value)

; Receive (blocks until sender ready)
(define val (channel-receive ch))

; Non-blocking try
(channel-try-receive ch)  ; returns #f if no message
\`\`\`

### Producer/Consumer Pattern
\`\`\`scheme
(import (std misc channel) (std misc threads))

(define work-ch (make-channel))

(define producer
  (thread-start!
    (make-thread
      (lambda ()
        (let loop ([i 0])
          (channel-send work-ch i)
          (loop (+ i 1)))))))

(define result (channel-receive work-ch))
\`\`\`
`;

const TOPIC_THREADS = `## Threads (std misc threads)

\`\`\`scheme
(import (std misc threads))

; Create and start a thread
(define t (make-thread (lambda () (display "hello\\n"))))
(thread-start! t)
(thread-join! t)

; Thread with return value
(define t (make-thread (lambda () 42)))
(thread-start! t)
(define result (thread-join! t))  ; returns 42

; Sleep
(thread-sleep! 0.5)  ; sleep 500ms
\`\`\`
`;

const TOPIC_MUTEX = `## Mutex and Condition Variables (std misc threads)

\`\`\`scheme
(import (std misc threads))

; Mutex
(define mu (make-mutex))
(mutex-acquire! mu)
(mutex-release! mu)

; Dynamic-wind for cleanup
(dynamic-wind
  (lambda () (mutex-acquire! mu))
  (lambda () ... critical section ...)
  (lambda () (mutex-release! mu)))

; Condition variable
(define cond-var (make-condition-variable))
(mutex-acquire! mu)
(condition-variable-wait! cond-var mu)
(mutex-release! mu)
; from another thread:
(condition-variable-signal! cond-var)
(condition-variable-broadcast! cond-var)
\`\`\`
`;

const TOPIC_PROMISES = `## Promises and Lazy Evaluation

\`\`\`scheme
; R6RS promises (built-in to Chez)
(define p (delay (expensive-computation)))
(define result (force p))  ; computed once, memoized

; make-promise
(define p (make-promise (lambda () 42)))
(force p)  ; => 42
\`\`\`
`;

const TOPIC_TIMERS = `## Timers

\`\`\`scheme
; Chez Scheme timer via thread + sleep
(define (after ms thunk)
  (thread-start!
    (make-thread
      (lambda ()
        (thread-sleep! (/ ms 1000.0))
        (thunk)))))

; Periodic timer
(define (every ms thunk)
  (thread-start!
    (make-thread
      (lambda ()
        (let loop ()
          (thread-sleep! (/ ms 1000.0))
          (thunk)
          (loop))))))
\`\`\`
`;

const TOPIC_PROCESSES = `## Process Spawning (std misc process)

\`\`\`scheme
(import (std misc process))

; Run a command and capture output
(define result (process-run "ls" '("-la")))
(display (process-output result))

; Check exit code
(process-exit-code result)  ; 0 = success
\`\`\`
`;

type Topic = 'channels' | 'threads' | 'mutex' | 'promises' | 'timers' | 'processes' | 'all';

const TOPIC_MAP: Record<Exclude<Topic, 'all'>, string> = {
  channels: TOPIC_CHANNELS,
  threads: TOPIC_THREADS,
  mutex: TOPIC_MUTEX,
  promises: TOPIC_PROMISES,
  timers: TOPIC_TIMERS,
  processes: TOPIC_PROCESSES,
};

export function registerEventSystemGuideTool(server: McpServer): void {
  server.registerTool(
    'jerboa_event_system_guide',
    {
      title: 'Jerboa/Chez Event and Concurrency Guide',
      description:
        'Interactive guide for Jerboa/Chez event and concurrency patterns. ' +
        'Covers channel-based communication, thread creation, mutex/condition variables, ' +
        'and process-based concurrency from (std misc channel), (std misc threads), ' +
        'and related modules.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        topic: z
          .enum(['channels', 'threads', 'mutex', 'promises', 'timers', 'processes', 'all'])
          .optional()
          .describe(
            'Topic to show: "channels", "threads", "mutex", "promises", "timers", "processes", or "all" (default: "all")',
          ),
      },
    },
    ({ topic }) => {
      const selected: Topic = topic ?? 'all';

      let content: string;

      if (selected === 'all') {
        const header =
          '# Jerboa/Chez Concurrency Guide\n\n' +
          'Topics: channels, threads, mutex, promises, timers, processes\n\n' +
          '---\n\n';
        content =
          header +
          TOPIC_CHANNELS +
          '\n---\n\n' +
          TOPIC_THREADS +
          '\n---\n\n' +
          TOPIC_MUTEX +
          '\n---\n\n' +
          TOPIC_PROMISES +
          '\n---\n\n' +
          TOPIC_TIMERS +
          '\n---\n\n' +
          TOPIC_PROCESSES;
      } else {
        content = TOPIC_MAP[selected];
      }

      return {
        content: [{ type: 'text' as const, text: content }],
      };
    },
  );
}
