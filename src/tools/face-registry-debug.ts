import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez } from '../chez.js';

/**
 * Build a Chez/Jerboa script that connects to the running editor via IPC REPL
 * and dumps the face registry state, then compares against expected faces.
 */
function buildFaceRegistryDumpScript(
  replSocketPath: string,
  expectedFaces: string[],
): string {
  const facesList = expectedFaces.map((f) => `"${f}"`).join(' ');

  return `(import (jerboa prelude))
(import (std net tcp))

;; Connect to IPC REPL socket and query face registry
(define (query-repl socket-path expr)
  (guard (e [else (str "ERROR: " (condition/report-string e))])
    (let* ([port (tcp-connect socket-path 0)]
           [_ (display expr port)]
           [_ (display "\\n" port)]
           [_ (flush-output-port port)]
           [result (read port)])
      (close-port port)
      (format "~a" result))))

;; Try to dump face registry state
(define face-report
  (guard (e [else (str "Could not connect to IPC REPL: " (condition/report-string e))])
    (query-repl "${replSocketPath}"
      "(list
         (list 'registry-size (if (hash-key? *faces* 'dummy) 'nonempty (length (hash-keys *faces*))))
         (list 'faces-hash-content (map (lambda (k) (list k (hash-get *faces* k))) (take (hash-keys *faces*) 5))))")))

(displayln "=== Face Registry Diagnostic ===")
(displayln face-report)

;; Check specific expected faces
(define expected-faces (list ${facesList}))
(displayln "")
(displayln "=== Expected face checks ===")
(for-each
  (lambda (face-name)
    (let ([result
      (guard (e [else (str "ERROR: " (condition/report-string e))])
        (query-repl "${replSocketPath}"
          (str "(list 'face '" face-name " (face-get '" face-name ")")))])
      (displayln face-name ": " result)))
  expected-faces)
`;
}

/**
 * Build a script that inspects face registry state in-process (for eval-based tools).
 */
function buildInProcessFaceCheckScript(faces: string[]): string {
  const faceChecks = faces.map((f) =>
    `(list "${f}" (guard (e [else #f]) (face-get '${f})))`,
  ).join('\n  ');

  return `(import (jerboa prelude))

;; Check if face-get and *faces* are available
(define faces-available?
  (guard (e [else #f])
    (eval '(and (procedure? face-get) (hash-table? *faces*))
          (interaction-environment))))

(if faces-available?
    (begin
      (displayln "Face registry accessible")
      (displayln "Registry size: " (length (hash-keys *faces*)))
      (displayln "")
      (displayln "Face lookups:")
      (for-each
        (lambda (pair)
          (displayln "  " (car pair) ": " (if (cadr pair) "FOUND" "MISSING (#f)")))
        (list
          ${faceChecks})))
    (displayln "face-get or *faces* not accessible in this environment — may be a static binary WPO isolation issue"))
`;
}

export function registerFaceRegistryDebugTool(server: McpServer): void {
  server.registerTool(
    'jerboa_face_registry_debug',
    {
      title: 'Diagnose Face Registry in Static Binary',
      description:
        'Diagnose face registry binding failures in static Chez/Jerboa binaries. ' +
        'In WPO static builds, module-level bindings (like *faces* populated by load-theme!) ' +
        'can fail silently — face-get returns #f for all faces even after load-theme! was called. ' +
        'Dumps the *faces* hash table contents, checks a list of expected font-lock faces, ' +
        'and reports which are FOUND vs MISSING. ' +
        'Works via direct eval (in-process mode) or via IPC REPL socket if the editor is running.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        mode: z
          .enum(['eval', 'ipc'])
          .optional()
          .describe(
            '"eval" — run checks via jerboa_eval in a fresh Jerboa process (default). ' +
            '"ipc" — connect to a running editor via IPC REPL socket.',
          ),
        ipc_socket: z
          .string()
          .optional()
          .describe('Path to the IPC REPL Unix socket (required for mode=ipc)'),
        faces: z
          .array(z.string())
          .optional()
          .describe(
            'Face names to check (default: common font-lock faces). ' +
            'E.g. ["font-lock-keyword-face", "font-lock-string-face"]',
          ),
        jerboa_home: z.string().optional().describe('Override JERBOA_HOME'),
      },
    },
    async ({ mode, ipc_socket, faces, jerboa_home }) => {
      const checkMode = mode ?? 'eval';
      const facesToCheck = faces ?? [
        'font-lock-keyword-face',
        'font-lock-string-face',
        'font-lock-comment-face',
        'font-lock-type-face',
        'font-lock-function-name-face',
        'font-lock-variable-name-face',
        'font-lock-constant-face',
        'font-lock-builtin-face',
        'default',
      ];

      if (checkMode === 'ipc') {
        if (!ipc_socket) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'mode=ipc requires ipc_socket parameter (path to the IPC REPL socket).',
              },
            ],
            isError: true,
          };
        }

        const script = buildFaceRegistryDumpScript(ipc_socket, facesToCheck);
        const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 15_000 });
        const out = (result.stdout + result.stderr).trim();

        return {
          content: [{ type: 'text' as const, text: out || 'No output from IPC face registry check.' }],
          isError: result.exitCode !== 0,
        };
      }

      // eval mode: in-process check
      const script = buildInProcessFaceCheckScript(facesToCheck);
      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 20_000 });
      const out = (result.stdout + result.stderr).trim();

      const advice = [
        '',
        '--- Diagnosis ---',
        'If face-get returns #f in the static binary but works interpreted:',
        '1. load-theme! may run before the face registry is initialized (init order bug)',
        '2. The *faces* hash table may be re-initialized after theme load (WPO module re-init)',
        '3. Workaround: read colors directly from theme alist via (theme-get face-name)',
        '   instead of (face-get face-name), bypassing the registry.',
        '4. Fix: ensure load-theme! is called after all module initializations complete,',
        '   or use a lazy face lookup that defers until first render.',
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: (out || 'No output.') + advice }],
        isError: result.exitCode !== 0,
      };
    },
  );
}
