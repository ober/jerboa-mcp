import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ChezResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ChezOptions {
  timeout?: number;
  schemePath?: string;
  jerboaHome?: string;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

// ── JERBOA_HOME resolution ─────────────────────────────────────────

export function getJerboaHome(override?: string): string {
  if (override) return override;
  return process.env.JERBOA_HOME ?? join(process.env.HOME ?? '/home/user', 'mine', 'jerboa');
}

export function getLibdirs(jerboaHome?: string): string {
  return join(getJerboaHome(jerboaHome), 'lib');
}

// ── Scheme binary resolution ───────────────────────────────────────

let resolvedSchemePath: string | null = null;

export async function findScheme(override?: string): Promise<string> {
  if (override) return override;
  if (resolvedSchemePath) return resolvedSchemePath;

  const home = process.env.HOME ?? '';
  const candidates = [
    process.env.JERBOA_MCP_SCHEME_PATH,
    home ? join(home, '.local', 'bin', 'scheme') : null,
    // ChezScheme local build (ta6le = typical 64-bit Linux)
    home ? join(home, 'mine', 'ChezScheme', 'ta6le', 'bin', 'ta6le', 'scheme') : null,
    home ? join(home, 'mine', 'ChezScheme', 'pb', 'bin', 'pb', 'scheme') : null,
    '/usr/bin/scheme',
    '/usr/local/bin/scheme',
    'scheme',
    'chez',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      resolvedSchemePath = candidate;
      return candidate;
    } catch {
      // not found or not executable, try next
    }
  }

  resolvedSchemePath = 'scheme';
  return 'scheme';
}

// ── Run Chez Scheme script ─────────────────────────────────────────

/**
 * Write code to a temp file and run it with scheme --libdirs ... --script.
 * This is the primary way to run Chez/Jerboa code.
 */
export async function runChez(
  code: string,
  options?: ChezOptions,
): Promise<ChezResult> {
  const schemePath = await findScheme(options?.schemePath);
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const libdirs = getLibdirs(options?.jerboaHome);

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'jerboa-mcp-'));
    tmpFile = join(tmpDir, 'eval.ss');
    await writeFile(tmpFile, code, 'utf-8');

    return await new Promise((resolve) => {
      execFile(
        schemePath,
        ['--libdirs', libdirs, '--script', tmpFile!],
        {
          timeout,
          maxBuffer: MAX_BUFFER,
          env: { ...process.env, ...options?.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            const timedOut = error.killed === true;
            const code = (error as NodeJS.ErrnoException).code;
            const exitCode =
              typeof error.code === 'number'
                ? error.code
                : code === 'ENOENT'
                  ? 127
                  : 1;
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode, timedOut });
          } else {
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, timedOut: false });
          }
        },
      );
    });
  } finally {
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  }
}

// ── Run make in a directory ────────────────────────────────────────

export async function runMake(
  target: string,
  cwd: string,
  options?: { timeout?: number; env?: Record<string, string> },
): Promise<ChezResult> {
  const timeout = options?.timeout ?? 120_000;

  return new Promise((resolve) => {
    execFile(
      'make',
      target ? [target] : [],
      {
        timeout,
        maxBuffer: MAX_BUFFER * 4,
        env: { ...process.env, ...options?.env },
        cwd,
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true;
          const code = (error as NodeJS.ErrnoException).code;
          const exitCode =
            typeof error.code === 'number'
              ? error.code
              : code === 'ENOENT'
                ? 127
                : 1;
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode, timedOut });
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, timedOut: false });
        }
      },
    );
  });
}

// ── String escaping ────────────────────────────────────────────────

/**
 * Escape a string for embedding inside a Scheme string literal.
 */
export function escapeSchemeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ── Build standard preamble ────────────────────────────────────────

/**
 * Build the standard preamble for a Jerboa script.
 * Imports (jerboa prelude) plus any additional user imports.
 */
export function buildPreamble(imports?: string[]): string {
  const lines: string[] = ['(import (jerboa prelude))'];
  if (imports && imports.length > 0) {
    for (const imp of imports) {
      // Normalize: ":std/sort" -> "(std sort)", "(std sort)" -> "(std sort)"
      const normalized = normalizeImport(imp);
      lines.push(`(import ${normalized})`);
    }
  }
  return lines.join('\n');
}

/**
 * Normalize a module path to Chez (std ...) form.
 * ":std/sort" -> "(std sort)"
 * "std/sort" -> "(std sort)"
 * "(std sort)" -> "(std sort)" (already normalized)
 */
export function normalizeImport(imp: string): string {
  if (imp.startsWith('(')) return imp; // already a list form
  const stripped = imp.startsWith(':') ? imp.slice(1) : imp;
  // "std/text/json" -> "(std text json)"
  const parts = stripped.split('/');
  return `(${parts.join(' ')})`;
}

// ── Markers ────────────────────────────────────────────────────────

export const RESULT_MARKER = 'JERBOA-MCP-RESULT:';
export const ERROR_MARKER = 'JERBOA-MCP-ERROR:';
export const VALID_MARKER = 'JERBOA-MCP-VALID';
export const STDOUT_MARKER = 'JERBOA-MCP-STDOUT:';

// ── Build eval wrapper ─────────────────────────────────────────────

/**
 * Build a complete eval script that:
 * 1. Imports (jerboa prelude) + (jerboa reader) + user imports
 * 2. Parses the expression using jerboa-read (handles [...] {} keyword: syntax)
 * 3. Builds an environment for eval including all imports
 * 4. Captures stdout and result separately
 *
 * This is the correct way to eval user Jerboa code that may use
 * extended syntax like [1 2 3], {method obj}, or keyword: args.
 */
export function buildEvalScript(expression: string, imports?: string[]): string {
  const escaped = escapeSchemeString(expression);

  // Build environment specs: always include chezscheme + jerboa prelude + reader
  const envSpecs = ["'(chezscheme)", "'(jerboa prelude)", "'(jerboa reader)"];
  if (imports && imports.length > 0) {
    for (const imp of imports) {
      const normalized = normalizeImport(imp);
      envSpecs.push(`'${normalized}`);
    }
  }

  const importLines = ["(import (jerboa prelude))", "(import (jerboa reader))"];
  if (imports && imports.length > 0) {
    for (const imp of imports) {
      importLines.push(`(import ${normalizeImport(imp)})`);
    }
  }

  return `${importLines.join('\n')}

(define eval-env
  (environment ${envSpecs.join(' ')}))

(define-values (capture-port get-captured) (open-string-output-port))

(define result
  (guard (e [else
             (display "${ERROR_MARKER}\\n")
             (display-condition e (current-output-port))
             (quote JERBOA-MCP-NO-VALUE)])
    (let ([expr (jerboa-read (open-string-input-port "${escaped}"))])
      (if (eof-object? expr)
          (void)
          (parameterize ([current-output-port capture-port])
            (eval expr eval-env))))))

(let ([captured (get-captured)])
  (when (> (string-length captured) 0)
    (display "${STDOUT_MARKER}")
    (display captured)
    (newline)))

(unless (eq? result (quote JERBOA-MCP-NO-VALUE))
  (unless (equal? result (void))
    (display "${RESULT_MARKER}")
    (write result)
    (newline)))
`;
}

/**
 * Build a Jerboa syntax-check script that reads all top-level forms
 * using the Jerboa reader (handles [...], {...}, keyword: syntax).
 */
export function buildSyntaxCheckScript(code: string, imports?: string[]): string {
  const escaped = escapeSchemeString(code);

  const importLines = ["(import (jerboa prelude))", "(import (jerboa reader))"];
  if (imports && imports.length > 0) {
    for (const imp of imports) {
      importLines.push(`(import ${normalizeImport(imp)})`);
    }
  }

  return `${importLines.join('\n')}

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ([port (open-string-input-port "${escaped}")])
    (let loop ()
      (let ([expr (jerboa-read port)])
        (unless (eof-object? expr)
          (expand expr)
          (loop)))))
  (display "${VALID_MARKER}\\n"))
`;
}

/**
 * Build a compile-check script for .sls library files that use #!chezscheme.
 * Uses the standard Chez reader (not jerboa-read) so brackets in syntax-case
 * patterns are handled correctly. Does NOT import (jerboa prelude), so the
 * check succeeds even if the prelude is broken.
 */
export function buildChezCompileCheckScript(code: string): string {
  const escaped = escapeSchemeString(code);

  return `(import (chezscheme))

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ([port (open-string-input-port "${escaped}")])
    (let loop ()
      (let ([expr (read port)])
        (unless (eof-object? expr)
          (expand expr)
          (loop)))))
  (display "${VALID_MARKER}\\n"))
`;
}

/**
 * Build a compile-check script for a library file using only its own imports.
 * Reads the file content, extracts its library form, and compiles it in
 * isolation without importing the prelude. This ensures compile-check works
 * even when the prelude itself has errors.
 */
export function buildIsolatedCompileCheckScript(code: string, useChezReader: boolean): string {
  const escaped = escapeSchemeString(code);

  if (useChezReader) {
    // For #!chezscheme files: use standard Chez reader
    return `(import (chezscheme))

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ([port (open-string-input-port "${escaped}")])
    (let loop ()
      (let ([expr (read port)])
        (unless (eof-object? expr)
          (expand expr)
          (loop)))))
  (display "${VALID_MARKER}\\n"))
`;
  } else {
    // For Jerboa .ss files: use jerboa-read but only import what's needed
    return `(import (jerboa reader))

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ([port (open-string-input-port "${escaped}")])
    (let loop ()
      (let ([expr (jerboa-read port)])
        (unless (eof-object? expr)
          (expand expr)
          (loop)))))
  (display "${VALID_MARKER}\\n"))
`;
  }
}

/**
 * Build the standard preamble for a non-eval Jerboa script.
 * For scripts that embed code directly (not via eval), use this
 * plus write the code in standard Chez syntax (no [...] etc.).
 */
export function buildEvalWrapper(expression: string): string {
  return `
(define-values (capture-port get-captured) (open-string-output-port))

(define result
  (guard (e [else
             (display "${ERROR_MARKER}\\n")
             (display-condition e (current-output-port))
             (quote JERBOA-MCP-NO-VALUE)])
    (parameterize ([current-output-port capture-port])
      ${expression})))

(let ([captured (get-captured)])
  (when (> (string-length captured) 0)
    (display "${STDOUT_MARKER}")
    (display captured)
    (newline)))

(unless (eq? result (quote JERBOA-MCP-NO-VALUE))
  (unless (equal? result (void))
    (display "${RESULT_MARKER}")
    (write result)
    (newline)))
`;
}

// ── REPL Session Management ────────────────────────────────────────

const REPL_SENTINEL = 'JERBOA-MCP-REPL-DONE';
const MAX_SESSIONS = 5;
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const EVAL_TIMEOUT = 30_000; // 30 seconds
const MAX_REPL_BUFFER = 512 * 1024; // 512KB

export interface ReplSessionInfo {
  id: string;
  createdAt: number;
  lastUsedAt: number;
}

interface ReplSession {
  id: string;
  process: ChildProcess;
  createdAt: number;
  lastUsedAt: number;
  stdoutBuffer: string;
  stderrBuffer: string;
}

const sessions = new Map<string, ReplSession>();

function cleanupIdleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT) {
      session.process.kill();
      sessions.delete(id);
    }
  }
}

export async function createReplSession(options?: {
  jerboaHome?: string;
  env?: Record<string, string>;
  preload?: string; // initial expression to evaluate
}): Promise<{ id: string; error?: string }> {
  cleanupIdleSessions();

  if (sessions.size >= MAX_SESSIONS) {
    return {
      id: '',
      error: `Maximum ${MAX_SESSIONS} concurrent sessions reached. Destroy an existing session first.`,
    };
  }

  const schemePath = await findScheme();
  const libdirs = getLibdirs(options?.jerboaHome);
  const id = randomUUID().slice(0, 8);

  const proc = spawn(schemePath, ['--libdirs', libdirs, '--quiet'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options?.env },
  });

  const session: ReplSession = {
    id,
    process: proc,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    stdoutBuffer: '',
    stderrBuffer: '',
  };

  proc.stdout!.on('data', (chunk: Buffer) => {
    session.stdoutBuffer += chunk.toString();
    if (session.stdoutBuffer.length > MAX_REPL_BUFFER) {
      session.stdoutBuffer = session.stdoutBuffer.slice(-MAX_REPL_BUFFER);
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    session.stderrBuffer += chunk.toString();
    if (session.stderrBuffer.length > MAX_REPL_BUFFER) {
      session.stderrBuffer = session.stderrBuffer.slice(-MAX_REPL_BUFFER);
    }
  });

  proc.on('exit', () => {
    sessions.delete(id);
  });

  sessions.set(id, session);

  // Load the jerboa prelude and reader
  proc.stdin!.write('(import (jerboa prelude))\n');
  proc.stdin!.write('(import (jerboa reader))\n');
  proc.stdin!.write(`(display "${REPL_SENTINEL}\\n")\n`);

  const ready = await waitForSentinel(session, 10_000);
  if (!ready.ok) {
    session.process.kill();
    sessions.delete(id);
    return { id: '', error: 'Failed to start Chez/Jerboa REPL session.' };
  }

  // Optionally run a preload expression
  if (options?.preload) {
    proc.stdin!.write(options.preload + '\n');
    proc.stdin!.write(`(display "${REPL_SENTINEL}\\n")\n`);
    const preloaded = await waitForSentinel(session, 10_000);
    if (!preloaded.ok) {
      session.process.kill();
      sessions.delete(id);
      return { id: '', error: 'Preload expression timed out.' };
    }
  }

  return { id };
}

export async function evalInSession(
  sessionId: string,
  expression: string,
): Promise<{ output: string; error?: string }> {
  cleanupIdleSessions();

  const session = sessions.get(sessionId);
  if (!session) {
    return { output: '', error: `Session "${sessionId}" not found.` };
  }

  if (!session.process.stdin!.writable) {
    sessions.delete(sessionId);
    return { output: '', error: `Session "${sessionId}" process has exited.` };
  }

  session.lastUsedAt = Date.now();
  session.stdoutBuffer = '';
  session.stderrBuffer = '';

  session.process.stdin!.write(expression + '\n');
  session.process.stdin!.write(`(display "${REPL_SENTINEL}\\n")\n`);

  const result = await waitForSentinel(session, EVAL_TIMEOUT);

  if (!result.ok) {
    return { output: '', error: 'Expression evaluation timed out after 30 seconds.' };
  }

  let output = result.text;
  // Strip Chez REPL prompts ("> " at line starts)
  output = output.replace(/^>\s*/gm, '');
  output = output.trim();

  const stderrOutput = session.stderrBuffer.trim();
  if (stderrOutput) {
    return { output: output || '(void)', error: stderrOutput };
  }

  return { output: output || '(void)' };
}

export function destroyReplSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.process.kill();
  sessions.delete(sessionId);
  return true;
}

export function listReplSessions(): ReplSessionInfo[] {
  cleanupIdleSessions();
  const result: ReplSessionInfo[] = [];
  for (const session of sessions.values()) {
    result.push({ id: session.id, createdAt: session.createdAt, lastUsedAt: session.lastUsedAt });
  }
  return result;
}

function waitForSentinel(
  session: ReplSession,
  timeout: number,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ ok: false, text: '' });
    }, timeout);

    const tryResolve = (): boolean => {
      const idx = session.stdoutBuffer.indexOf(REPL_SENTINEL);
      if (idx !== -1) {
        if (resolved) return true;
        resolved = true;
        cleanup();
        const text = session.stdoutBuffer.slice(0, idx);
        session.stdoutBuffer = session.stdoutBuffer.slice(idx + REPL_SENTINEL.length + 1);
        resolve({ ok: true, text });
        return true;
      }
      return false;
    };

    const onData = (): void => { tryResolve(); };
    const onExit = (): void => {
      if (resolved) return;
      if (tryResolve()) return;
      resolved = true;
      cleanup();
      resolve({ ok: false, text: session.stdoutBuffer });
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      session.process.stdout?.removeListener('data', onData);
      session.process.removeListener('exit', onExit);
    };

    session.process.stdout?.on('data', onData);
    session.process.on('exit', onExit);
    tryResolve();
  });
}
