import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, RESULT_MARKER, ERROR_MARKER } from '../chez.js';
import { execFile } from 'node:child_process';
import { writeFile, mkdtemp, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCommand(
  cmd: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: options?.timeout ?? 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 1 });
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
        }
      },
    );
  });
}

export function registerMtlsCertGenerateTool(server: McpServer): void {
  server.registerTool(
    'jerboa_mtls_cert_generate',
    {
      title: 'mTLS Cert Generate',
      description:
        'Generates a self-signed Ed25519 certificate and private key suitable for mTLS testing. ' +
        'Creates cert.pem and key.pem files that work as both server cert and client CA ' +
        '(self-signed mTLS pattern). Uses openssl for generation. Returns file paths and ' +
        'example Jerboa code for rustls-server-ctx-new-mtls and rustls-connect-mtls.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        output_dir: z.string().optional().describe('Directory to write cert.pem and key.pem (default: creates temp dir)'),
        common_name: z.string().optional().describe('CN for the certificate (default: "localhost")'),
        days: z.coerce.number().optional().describe('Certificate validity in days (default: 365)'),
        key_type: z.enum(['ed25519', 'rsa2048', 'rsa4096', 'ec256', 'ec384']).optional().describe('Key algorithm (default: ed25519)'),
        san: z.array(z.string()).optional().describe('Subject Alternative Names (default: ["DNS:localhost", "IP:127.0.0.1"])'),
      },
    },
    async ({ output_dir, common_name, days, key_type, san }) => {
      const cn = common_name ?? 'localhost';
      const validDays = days ?? 365;
      const keyAlgo = key_type ?? 'ed25519';
      const sans = san ?? ['DNS:localhost', 'IP:127.0.0.1'];

      // Create output directory
      let outDir: string;
      if (output_dir) {
        outDir = output_dir;
      } else {
        outDir = await mkdtemp(join(tmpdir(), 'jerboa-mtls-'));
      }

      const certPath = join(outDir, 'cert.pem');
      const keyPath = join(outDir, 'key.pem');

      // Check for openssl
      const opensslCheck = await runCommand('which', ['openssl']);
      if (opensslCheck.exitCode !== 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: openssl not found. Install openssl to generate certificates.' }],
          isError: true,
        };
      }

      // Build openssl command based on key type
      let keyArgs: string[];
      switch (keyAlgo) {
        case 'ed25519':
          keyArgs = ['-newkey', 'ed25519'];
          break;
        case 'rsa2048':
          keyArgs = ['-newkey', 'rsa:2048'];
          break;
        case 'rsa4096':
          keyArgs = ['-newkey', 'rsa:4096'];
          break;
        case 'ec256':
          keyArgs = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
          break;
        case 'ec384':
          keyArgs = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:secp384r1'];
          break;
      }

      const sanStr = sans.join(',');
      const subj = `/CN=${cn}`;

      const args = [
        'req', '-x509',
        ...keyArgs,
        '-keyout', keyPath,
        '-out', certPath,
        '-days', String(validDays),
        '-nodes',
        '-subj', subj,
        '-addext', `subjectAltName=${sanStr}`,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment',
        '-addext', 'extendedKeyUsage=serverAuth,clientAuth',
      ];

      const result = await runCommand('openssl', args, { timeout: 30_000 });

      if (result.exitCode !== 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Certificate generation failed:\n${result.stderr}\n${result.stdout}`,
          }],
          isError: true,
        };
      }

      // Verify the cert was created
      try {
        await access(certPath, constants.R_OK);
        await access(keyPath, constants.R_OK);
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Certificate files not found after generation.' }],
          isError: true,
        };
      }

      // Get cert details
      const certInfo = await runCommand('openssl', ['x509', '-in', certPath, '-noout', '-text', '-fingerprint']);

      const sections: string[] = [];
      sections.push('mTLS Certificate Generated');
      sections.push('');
      sections.push(`Certificate: ${certPath}`);
      sections.push(`Private Key: ${keyPath}`);
      sections.push(`Common Name: ${cn}`);
      sections.push(`Key Type: ${keyAlgo}`);
      sections.push(`Valid: ${validDays} days`);
      sections.push(`SANs: ${sans.join(', ')}`);
      sections.push('');

      // Extract fingerprint
      if (certInfo.exitCode === 0) {
        const fpMatch = certInfo.stdout.match(/Fingerprint=(.+)/);
        if (fpMatch) {
          sections.push(`Fingerprint: ${fpMatch[1]}`);
          sections.push('');
        }
      }

      sections.push('Usage — mTLS Server (Jerboa):');
      sections.push('');
      sections.push('  (import (jerboa prelude))');
      sections.push('  ;; If using rustls bindings:');
      sections.push(`  (def server-ctx (rustls-server-ctx-new-mtls "${certPath}" "${keyPath}" "${certPath}"))`);
      sections.push('  ;; cert.pem is used as both server cert AND client CA (self-signed pattern)');
      sections.push('');
      sections.push('Usage — mTLS Client (Jerboa):');
      sections.push('');
      sections.push(`  (def client-ctx (rustls-connect-mtls "localhost" 8443 "${certPath}" "${certPath}" "${keyPath}"))`);
      sections.push('  ;; Args: host, port, ca-cert, client-cert, client-key');
      sections.push('');
      sections.push('Usage — curl test:');
      sections.push('');
      sections.push(`  curl --cacert ${certPath} --cert ${certPath} --key ${keyPath} https://localhost:8443/`);

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
