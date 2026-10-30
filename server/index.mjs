import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createBookingStore } from './bookings.mjs';
import { createClientAddressResolver } from './client-address.mjs';
import { createBookingHandler, sendJson } from './booking-handler.mjs';
import { createNotificationWorker, notifyTelegram } from './telegram.mjs';
import { createAdminAuthStore } from './admin-auth.mjs';
import { createAdminHandler } from './admin-handler.mjs';
import { createPrivateFiles } from './private-files.mjs';
import { createStaticResponder } from './static-response.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * @typedef {object} AppOptions
 * @property {string} [databasePath] Absolute path or path relative to the project.
 * @property {() => Date} [now] Clock shared by validation, limits and delivery.
 * @property {number} [rateLimit] Successful new bookings per IP per 15 minutes.
 * @property {string | string[]} [trustedProxies] Exact proxy IPs; empty trusts none.
 * @property {import('./telegram.mjs').TelegramOptions | null} [telegram] Null disables new notification delivery.
 * @property {boolean} [dev] Serve through Vite middleware.
 * @property {boolean} [hmr] Enable Vite's live-update websocket in development.
 * @property {boolean} [adminCookieSecure] Require HTTPS Origin and Secure admin cookies behind TLS.
 */
/** @param {AppOptions} [options] */
export async function createApp({ databasePath = process.env.DATABASE_PATH || resolve(projectRoot, 'data/bookings.sqlite'), now = () => new Date(), rateLimit = 5, trustedProxies = process.env.TRUSTED_PROXIES || '', telegram = { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }, dev = false, hmr = true, adminCookieSecure = process.env.ADMIN_COOKIE_SECURE === 'true' } = {}) {
  const clientAddress = createClientAddressResolver(trustedProxies);
  databasePath = resolve(projectRoot, databasePath);
  const store = createBookingStore(databasePath);
  const adminAuth = createAdminAuthStore(databasePath);
  const handleAdmin = createAdminHandler({ auth: adminAuth, store, now, clientAddress, cookieSecure: adminCookieSecure });
  const notifications = telegram?.token && telegram?.chatId ? createNotificationWorker({ store, now, send: (id, value) => notifyTelegram(id, value, telegram) }) : null;
  const handleBooking = createBookingHandler({ store, now, rateLimit, clientAddress, notifications });
  const root = resolve(projectRoot, 'dist');
  const serveStatic = createStaticResponder();
  const notFound = async (request, response) => {
    try {
      const errorPage = resolve(root, '404.html');
      if (await privateFiles.isPrivateFile(errorPage)) throw new Error('Private error template');
      await serveStatic(request, response, errorPage, { status: 404, contentType: 'text/html; charset=utf-8', cacheControl: 'no-store' });
    }
    catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Страница не найдена. Вернуться на главную: /'); }
  };
  const fileRoots = [projectRoot, root];
  const privateFiles = await createPrivateFiles({ projectRoot, databasePath, roots: fileRoots });
  const vite = dev ? await (await import('vite')).createServer({ root: projectRoot, server: {
    middlewareMode: true, hmr, ws: hmr,
    fs: { deny: ['**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/*.{sqlite,db}', '**/*.sqlite-*', '**/*.db-*', '**/data/**', '**/admin-access.txt'] }
  }, plugins: [{
    name: 'private-server-files', enforce: 'pre',
    configureServer(server) {
      // Vite rewrites /folder/ and extensionless HTML URLs after static files.
      // This post-hook checks that final target before indexHtmlMiddleware reads it.
      return () => server.middlewares.use(async (request, response, next) => {
        try {
          const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
          if (!(await privateFiles.isPrivateRequest(path))) { next(); return; }
        } catch { /* Invalid or unverifiable targets remain private. */ }
        response.writeHead(404); response.end('Not found');
      });
    },
    async load(id) {
      if (!id.startsWith('\0') && await privateFiles.isPrivateFile(id.split('?')[0])) throw new Error('Private server file.');
      return null;
    }
  }], appType: 'mpa' }) : null;
  if (vite?.config.publicDir) fileRoots.push(vite.config.publicDir);
  const indexPath = resolve(root, 'index.html');
  let fileEntryHashes = '';
  if (!dev && existsSync(indexPath)) {
    const html = await readFile(indexPath, 'utf8');
    // Only the trusted file-opening guard needs permission to run inline.
    fileEntryHashes = [...html.matchAll(/<script\b[^>]*data-file-entry[^>]*>([\s\S]*?)<\/script>/g)]
      .map(match => ` 'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join('');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!dev) res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${fileEntryHashes}; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https://maps.google.com https://www.google.com; object-src 'none'; base-uri 'none'; form-action 'self'`);
    const json = (status, body) => sendJson(res, status, body);
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { json(400, { message: 'Некорректный адрес.' }); return; }
    if (await privateFiles.isPrivateRequest(path)) { res.writeHead(404); res.end('Not found'); return; }

    if (path.startsWith('/api/')) {
      if (path === '/api/admin' || path.startsWith('/api/admin/')) { await handleAdmin(req, res, path); return; }
      if (path === '/api/health' && req.method === 'GET') {
        if (req.headers.origin === 'null') { res.setHeader('Access-Control-Allow-Origin', 'null'); res.setHeader('Vary', 'Origin'); }
        json(200, { service: 'semeyniy-ezh', ready: dev || existsSync(indexPath) }); return;
      }
      if (path !== '/api/bookings') { json(404, { message: 'Не найдено.' }); return; }
      await handleBooking(req, res);
      return;
    }
    if (vite) { vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const canonicalPath = path === '/index.html' ? '/' : path === '/admin' || path === '/admin/index.html' ? '/admin/' : null;
    if (canonicalPath) {
      res.writeHead(308, { Location: canonicalPath + new URL(req.url, 'http://localhost').search }); res.end(); return;
    }
    if (path === '/404.html') { await notFound(req, res); return; }
    const file = resolve(root, path === '/' ? 'index.html' : path === '/admin' || path === '/admin/' ? 'admin/index.html' : `.${path}`);
    if (!file.startsWith(root + sep)) { res.writeHead(404); res.end('Not found'); return; }
    if (await privateFiles.isPrivateFile(file)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      await serveStatic(req, res, file, { contentType: types[extname(file)] || 'application/octet-stream', cacheControl: file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    } catch { await notFound(req, res); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('listening', () => notifications?.start());
  server.on('close', () => { void notifications?.stop(); adminAuth.close(); });
  return { server, store, vite, notifications };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const envPath = resolve(projectRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const app = await createApp({ dev: process.argv.includes('--dev') });
  const port = Number(process.env.PORT || 5173);
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => console.log(`Семейный Ёж: http://${host}:${port}`));
  const shutdown = () => app.server.close(async () => { await app.notifications?.stop(); await app.vite?.close(); app.store.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
