import { realpath, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';

const key = path => {
  const normalized = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const canonical = async path => {
  try { return await realpath(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
};

/** One policy for HTTP aliases, Vite transforms and actual static file targets. */
export async function createPrivateFiles({ projectRoot, databasePath, roots }) {
  const credentialPath = resolve(dirname(databasePath), 'admin-access.txt');
  const databaseKeys = new Set([key(databasePath)]);
  const credentialKeys = new Set([key(credentialPath)]);
  const dataKeys = new Set([key(resolve(projectRoot, 'data'))]);
  for (const [path, identities] of [[databasePath, databaseKeys], [credentialPath, credentialKeys], [resolve(projectRoot, 'data'), dataKeys]]) {
    const actual = await canonical(path);
    if (actual) identities.add(key(actual));
  }
  function protectedIdentity(path) {
    const candidate = key(path);
    return /(?:^|\/)(?:admin-access\.txt|\.env(?:\.[^/]*)?)$/i.test(candidate) ||
      /(?:^|\/)\.git(?:\/|$)/i.test(candidate) || /\.(?:sqlite|db)(?:-.*)?$/i.test(candidate) ||
      credentialKeys.has(candidate) ||
      [...databaseKeys].some(database => candidate === database || candidate.startsWith(database + '-')) ||
      [...dataKeys].some(data => candidate === data || candidate.startsWith(data + '/'));
  }
  async function isPrivateFile(path) {
    if (!isAbsolute(path)) return false;
    if (protectedIdentity(path)) return true;
    try {
      const actual = await canonical(path);
      if (actual === null) return false;
      if (protectedIdentity(actual)) return true;
      const candidate = await stat(actual, { bigint: true });
      if (!candidate.isFile() || candidate.ino === 0n) return false;
      // realpath resolves symlinks, while a hardlink retains its own pathname.
      // Refresh sensitive identities: credentials/sidecars can appear after boot.
      const sensitive = [...credentialKeys, ...[...databaseKeys].flatMap(database => [database, database + '-wal', database + '-shm', database + '-journal'])];
      for (const protectedPath of sensitive) {
        try {
          const identity = await stat(protectedPath, { bigint: true });
          if (candidate.dev === identity.dev && candidate.ino === identity.ino) return true;
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
      return false;
    } catch { return true; }
  }
  async function isPrivateRequest(path) {
    // Do not pass ambiguous spellings to another parser that may decode or
    // normalize them differently, especially Windows separators and ADS names.
    if (/[\\\0]/.test(path) || /%[\da-f]{2}/i.test(path)) return true;
    if (process.platform === 'win32') {
      const withoutDrive = path.replace(/^\/@(?:fs|id)\/[a-z]:\//i, '/');
      if (withoutDrive.includes(':') || path.split('/').some(part => /[. ]$/.test(part))) return true;
    }
    if (/(?:^|\/)admin-access\.txt$/i.test(path)) return true;
    const paths = roots.filter(Boolean).map(root => resolve(root, `.${path}`));
    if (path.startsWith('/@fs/')) paths.push(path.slice(5));
    if (path.startsWith('/@id/')) paths.push(path.slice(5));
    for (const candidate of paths) if (await isPrivateFile(candidate)) return true;
    return false;
  }
  return { isPrivateFile, isPrivateRequest };
}
