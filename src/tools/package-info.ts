import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, stat, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { getJerboaHome } from '../chez.js';

interface KnownPackage {
  name: string;
  description: string;
  soNames: string[];
  slsCheck?: string; // optional: check if this .sls exists in JERBOA_HOME/lib/
}

const KNOWN_PACKAGES: KnownPackage[] = [
  {
    name: 'chez-json',
    description: 'JSON parsing/generation',
    soNames: [],
    slsCheck: 'std/text/json.sls',
  },
  {
    name: 'chez-csv',
    description: 'CSV parsing',
    soNames: [],
    slsCheck: 'std/text/csv.sls',
  },
  {
    name: 'chez-https',
    description: 'HTTPS client',
    soNames: ['libchez-https.so', 'libchez-https.dylib'],
  },
  {
    name: 'chez-sqlite',
    description: 'SQLite bindings',
    soNames: [
      'libchez-sqlite.so',
      'libchez-sqlite.dylib',
      'libsqlite3.so',
      'libsqlite3.so.0',
    ],
  },
  {
    name: 'chez-ssl',
    description: 'SSL/TLS bindings',
    soNames: [
      'libssl.so.1.1',
      'libssl.so.3',
      'libssl.so',
      'libssl.dylib',
    ],
  },
  {
    name: 'chez-zlib',
    description: 'Compression (zlib)',
    soNames: [
      'libz.so.1',
      'libz.so',
      'libz.dylib',
      'libzlib.so',
    ],
  },
];

const SHARED_LIB_SEARCH_DIRS = [
  '/usr/lib',
  '/usr/local/lib',
  '/usr/lib/x86_64-linux-gnu',
  '/usr/lib/aarch64-linux-gnu',
  '/usr/lib/arm-linux-gnueabihf',
  '/lib',
  '/lib/x86_64-linux-gnu',
];

/**
 * Check if a file is accessible (exists and is readable).
 */
async function fileAccessible(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a shared library by searching standard directories.
 * Returns the path where found, or null.
 */
async function findSharedLib(soName: string, extraDirs: string[]): Promise<string | null> {
  const dirs = [...extraDirs, ...SHARED_LIB_SEARCH_DIRS];
  for (const dir of dirs) {
    const fullPath = join(dir, soName);
    if (await fileAccessible(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Count .sls files in a directory recursively.
 */
async function countSlsFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countSlsFiles(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.sls')) {
        count++;
      }
    }
  } catch {
    // skip
  }
  return count;
}

export function registerPackageInfoTool(server: McpServer): void {
  server.registerTool(
    'jerboa_package_info',
    {
      title: 'Jerboa Package Status',
      description:
        'List available Jerboa/Chez extension packages and their installation status. ' +
        'Shows chez-https, chez-ssl, chez-sqlite, chez-zlib, and other common extensions, ' +
        'checking if shared objects are available in standard library paths.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (overrides JERBOA_HOME env var)'),
        query: z
          .string()
          .optional()
          .describe('Optional filter: show only packages matching this name substring'),
      },
    },
    async ({ jerboa_home, query }) => {
      const jerboaHomeResolved = getJerboaHome(jerboa_home);
      const jerboaLib = join(jerboaHomeResolved, 'lib');

      // Check how many .sls modules are in JERBOA_HOME/lib/
      let stdModuleCount = 0;
      let libDirExists = false;
      try {
        const s = await stat(jerboaLib);
        if (s.isDirectory()) {
          libDirExists = true;
          stdModuleCount = await countSlsFiles(jerboaLib);
        }
      } catch {
        // lib dir not found
      }

      const lines: string[] = [];
      lines.push('Jerboa Package Status');
      lines.push('=====================');
      lines.push('');

      if (libDirExists) {
        lines.push(`Standard Library: ${jerboaLib} (${stdModuleCount} modules)`);
      } else {
        lines.push(`Standard Library: ${jerboaLib} (not found)`);
      }
      lines.push('');
      lines.push('Extensions:');

      const filtered = query
        ? KNOWN_PACKAGES.filter((p) => p.name.includes(query) || p.description.toLowerCase().includes(query.toLowerCase()))
        : KNOWN_PACKAGES;

      for (const pkg of filtered) {
        let found = false;
        let foundPath = '';
        let statusNote = '';

        if (pkg.slsCheck) {
          // Check for .sls in JERBOA_HOME/lib/
          const slsPath = join(jerboaLib, pkg.slsCheck);
          if (await fileAccessible(slsPath)) {
            found = true;
            foundPath = pkg.slsCheck;
          }
        }

        if (!found && pkg.soNames.length > 0) {
          // Search for .so in standard locations
          for (const soName of pkg.soNames) {
            const soPath = await findSharedLib(soName, [jerboaLib, join(jerboaHomeResolved, 'native')]);
            if (soPath) {
              found = true;
              foundPath = soPath;
              break;
            }
          }
          if (!found) {
            statusNote = `not found: ${pkg.soNames[0]}`;
          }
        } else if (!found && pkg.slsCheck) {
          statusNote = `not found: ${pkg.slsCheck}`;
        }

        const icon = found ? '✓' : '✗';
        const detail = found ? foundPath : statusNote;
        const padded = pkg.name.padEnd(15);
        lines.push(`  ${icon} ${padded} - ${pkg.description}${detail ? ` (${detail})` : ''}`);
      }

      lines.push('');
      lines.push(`JERBOA_HOME: ${jerboaHomeResolved}`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
