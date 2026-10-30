import { readFile, stat } from 'node:fs/promises';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

function negotiate(header, compressible) {
  const values = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const parameter = parameters.find(value => /^\s*q\s*=/.test(value));
    const quality = parameter === undefined ? 1 : Number(parameter.split('=')[1]);
    values.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const identity = values.get('identity') ?? (values.get('*') === 0 ? 0 : 1);
  const choices = [
    ['br', compressible || identity === 0 ? values.get('br') ?? values.get('*') ?? 0 : 0],
    ['gzip', compressible || identity === 0 ? values.get('gzip') ?? values.get('*') ?? 0 : 0],
    ['identity', identity]
  ];
  choices.sort((left, right) => right[1] - left[1]);
  return choices[0][1] > 0 ? choices[0][0] : null;
}

function notModified(request, etag, modified) {
  const match = request.headers['if-none-match'];
  if (match !== undefined) return String(match).split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
  const since = Date.parse(request.headers['if-modified-since']);
  return Number.isFinite(since) && modified <= since;
}

/** Static representations only. Personal JSON responses never use this cache. */
export function createStaticResponder({ maxCacheBytes = 8 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let cachedBytes = 0;
  return async function serve(request, response, file, { contentType, cacheControl = 'no-cache', status = 200 } = {}) {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    const compressible = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/i.test(contentType || '');
    const encoding = negotiate(request.headers['accept-encoding'], compressible && info.size >= 256);
    response.setHeader('Vary', 'Accept-Encoding');
    response.setHeader('Cache-Control', cacheControl);
    if (!encoding) { response.writeHead(406); response.end(); return; }
    const modified = Math.floor(info.mtimeMs / 1000) * 1000;
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${encoding}"`;
    response.setHeader('Content-Type', contentType || 'application/octet-stream');
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', new Date(modified).toUTCString());
    if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding);
    if (status === 200 && notModified(request, etag, modified)) { response.writeHead(304); response.end(); return; }
    const cacheKey = `${file}\0${etag}`;
    let content = cache.get(cacheKey);
    if (content) { cache.delete(cacheKey); cache.set(cacheKey, content); }
    else {
      content = await readFile(file);
      if (encoding === 'br') content = await compressBrotli(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
      else if (encoding === 'gzip') content = await compressGzip(content, { level: 6 });
      if (content.length <= maxCacheBytes) {
        while (cachedBytes + content.length > maxCacheBytes && cache.size) {
          const oldest = cache.keys().next().value;
          cachedBytes -= cache.get(oldest).length; cache.delete(oldest);
        }
        // Concurrent cold requests can finish compression of the same file.
        const existing = cache.get(cacheKey);
        if (!existing) { cache.set(cacheKey, content); cachedBytes += content.length; }
      }
    }
    if (response.destroyed) return;
    response.setHeader('Content-Length', content.length);
    response.writeHead(status);
    response.end(request.method === 'HEAD' ? undefined : content);
  };
}
