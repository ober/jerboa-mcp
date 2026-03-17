import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'dist', 'index.js');

let serverProcess: ChildProcess;
let messageId = 0;

function getNextId(): number {
  return ++messageId;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: ToolCallResult;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function sendMessage(msg: object): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(msg) + '\n';

    let accumulated = '';
    const handler = (data: Buffer) => {
      accumulated += data.toString();
      const lines = accumulated.split('\n');
      // Try to find a complete JSON-RPC response line
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          // Only resolve if this has an id (is a response, not a notification)
          if ('id' in parsed && parsed.id !== undefined) {
            serverProcess.stdout?.removeListener('data', handler);
            // Keep remaining data in buffer
            accumulated = lines.slice(i + 1).join('\n');
            resolve(parsed);
            return;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
      // Keep the last incomplete line
      accumulated = lines[lines.length - 1];
    };
    serverProcess.stdout?.on('data', handler);
    serverProcess.stdin?.write(json);
    setTimeout(() => {
      serverProcess.stdout?.removeListener('data', handler);
      reject(new Error('Timeout waiting for response'));
    }, 55000);
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await sendMessage({
    jsonrpc: '2.0',
    id: getNextId(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (!response.result) {
    throw new Error(`No result in response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function schemeNotAvailable(text: string): boolean {
  return (
    text.includes('scheme not found') ||
    text.includes('not found') ||
    text.includes('ENOENT') ||
    text.includes('command not found') ||
    text.includes('No such file')
  );
}

beforeAll(async () => {
  serverProcess = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (_data: Buffer) => {
    // Suppress stderr noise during tests
  });

  await sendMessage({
    jsonrpc: '2.0',
    id: getNextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  });

  const notif = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  serverProcess.stdin?.write(notif + '\n');

  await new Promise<void>((r) => setTimeout(r, 500));
}, 30000);

afterAll(() => {
  serverProcess?.kill();
});

// ---------------------------------------------------------------------------

describe('jerboa_version', () => {
  it('returns version info', async () => {
    const result = await callTool('jerboa_version', {});
    const text = result.content[0].text;
    expect(
      /chez|scheme|version/i.test(text),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_check_syntax', () => {
  it('accepts valid syntax', async () => {
    const result = await callTool('jerboa_check_syntax', { code: '(+ 1 2)' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text.toLowerCase()).toContain('valid');
  });

  it('rejects invalid syntax', async () => {
    const result = await callTool('jerboa_check_syntax', { code: '(((' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(result.isError === true || text.toLowerCase().includes('error')).toBe(
      true,
    );
  });

  it('accepts jerboa reader syntax', async () => {
    const result = await callTool('jerboa_check_syntax', {
      code: '[1 2 3]',
    });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text.toLowerCase()).toContain('valid');
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_check_balance', () => {
  it('detects balanced code', async () => {
    const result = await callTool('jerboa_check_balance', { code: '(+ 1 2)' });
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain('balance');
  });

  it('detects unbalanced code', async () => {
    const result = await callTool('jerboa_check_balance', { code: '(((' });
    const text = result.content[0].text;
    expect(
      result.isError === true || text.toLowerCase().includes('unbalanced'),
    ).toBe(true);
  });

  it('passes on a complex balanced form', async () => {
    const result = await callTool('jerboa_check_balance', {
      code: '(define x (lambda (a b) (+ a b)))',
    });
    expect(result.isError).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_eval', () => {
  it('evaluates simple expression', async () => {
    const result = await callTool('jerboa_eval', { expression: '(+ 1 2)' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text).toContain('3');
  });

  it('handles errors gracefully', async () => {
    const result = await callTool('jerboa_eval', { expression: '(/ 1 0)' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(result.isError).toBe(true);
  });

  it('captures output', async () => {
    const result = await callTool('jerboa_eval', {
      expression: '(begin (display "hello") 42)',
    });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text).toContain('hello');
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_preflight_check', () => {
  it('runs preflight check and returns non-empty output', async () => {
    const result = await callTool('jerboa_preflight_check', {});
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_howto', () => {
  it('finds hash table recipes', async () => {
    const result = await callTool('jerboa_howto', { query: 'hash table' });
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain('hash');
  });

  it('returns compact results', async () => {
    const result = await callTool('jerboa_howto', {
      query: 'sort',
      compact: true,
    });
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_list_modules', () => {
  it('lists available modules', async () => {
    const result = await callTool('jerboa_list_modules', {});
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(/std|jerboa/i.test(text)).toBe(true);
  });

  it('filters by prefix', async () => {
    const result = await callTool('jerboa_list_modules', { prefix: 'std' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text.toLowerCase()).toContain('std');
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_module_exports', () => {
  it('lists exports from a std module', async () => {
    const result = await callTool('jerboa_module_exports', {
      module_path: '(std sort)',
    });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text.toLowerCase()).toContain('sort');
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_error_hierarchy', () => {
  it('returns condition hierarchy', async () => {
    const result = await callTool('jerboa_error_hierarchy', {});
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(/&condition|&error/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_format', () => {
  it('formats scheme code', async () => {
    const result = await callTool('jerboa_format', { code: '(+ 1 2)' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text.includes('(+ 1 2)') || text.includes('+')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_explain_error', () => {
  it('explains unbound variable error', async () => {
    const result = await callTool('jerboa_explain_error', {
      error_message: 'variable foo is not bound',
    });
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain('import');
  });

  it('explains arity error', async () => {
    const result = await callTool('jerboa_explain_error', {
      error_message: 'wrong number of arguments',
    });
    const text = result.content[0].text;
    expect(/argument|arity/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_error_fix_lookup', () => {
  it('finds fix for known error', async () => {
    const result = await callTool('jerboa_error_fix_lookup', {
      error_message: 'variable foo is not bound',
    });
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(10);
  });

  it('handles unknown error gracefully', async () => {
    const result = await callTool('jerboa_error_fix_lookup', {
      error_message: 'completely unknown error xyzzy',
    });
    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_event_system_guide', () => {
  it('returns channels guide', async () => {
    const result = await callTool('jerboa_event_system_guide', {
      topic: 'channels',
    });
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain('channel');
  });

  it('returns general guide when no topic given', async () => {
    const result = await callTool('jerboa_event_system_guide', {});
    const text = result.content[0].text;
    expect(/thread|Thread/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_compile_check', () => {
  it('accepts valid code', async () => {
    const result = await callTool('jerboa_compile_check', {
      code: '(import (chezscheme)) (+ 1 2)',
    });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(result.isError).not.toBe(true);
  });

  it('rejects code with unbound identifier', async () => {
    const result = await callTool('jerboa_compile_check', {
      code: 'not-a-valid-form-3838',
    });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(result.isError === true || text.toLowerCase().includes('error')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------

describe('jerboa_verify', () => {
  it('verifies valid code', async () => {
    const result = await callTool('jerboa_verify', { code: '(+ 1 2)' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(text.includes('✓') || text.includes('No issues')).toBe(true);
  });

  it('reports errors on invalid code', async () => {
    const result = await callTool('jerboa_verify', { code: '(((bad' });
    const text = result.content[0].text;
    if (schemeNotAvailable(text)) {
      console.log('Skipping: scheme not available');
      return;
    }
    expect(result.isError === true || text.includes('✗')).toBe(true);
  });
});
