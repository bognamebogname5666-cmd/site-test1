import { timingSafeEqual } from 'node:crypto';
import { sendJson } from './booking-handler.mjs';
import { hashPassword, verifyPassword, validPassword, validUsername } from './admin-auth.mjs';

const statuses = new Set(['requested', 'confirmed', 'cancelled', 'completed']);
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const tokenFrom = request => {
  const values = (request.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('ezh_admin='));
  return values.length === 1 ? values[0].slice('ezh_admin='.length) : '';
};
const equalToken = (actual, expected) => typeof actual === 'string' && actual.length <= 128 && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

async function readJson(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) throw failure('Ожидается JSON.', 415);
  if (Number(request.headers['content-length']) > 8192) { request.resume(); throw failure('Слишком большой запрос.', 413); }
  const buffer = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = () => { cleanup(); reject(failure('Не удалось прочитать запрос.', 400)); };
    const aborted = () => error();
    const data = chunk => {
      size += chunk.length;
      if (size > 8192) { cleanup(); request.resume(); reject(failure('Слишком большой запрос.', 413)); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.on('end', end); request.on('error', error); request.on('aborted', aborted);
  });
  let result;
  try { result = JSON.parse(buffer.toString('utf8') || '{}'); } catch { throw failure('Некорректный JSON.', 400); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('Ожидается объект JSON.', 400);
  return result;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function filters(search) {
  const status = search.get('status') ?? 'all';
  const q = (search.get('q') ?? '').trim();
  const dateFrom = search.get('dateFrom') ?? ''; const dateTo = search.get('dateTo') ?? '';
  const pageText = search.get('page') ?? '1'; const pageSizeText = search.get('pageSize') ?? '20';
  const page = Number(pageText); const pageSize = Number(pageSizeText);
  if ((status !== 'all' && !statuses.has(status)) || q.length > 100 ||
      (dateFrom && !validDate(dateFrom)) || (dateTo && !validDate(dateTo)) ||
      (dateFrom && dateTo && dateFrom > dateTo) || !/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000 ||
      !/^\d+$/.test(pageSizeText) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw failure('Проверьте фильтры списка заявок.', 400);
  }
  return { status, q, dateFrom, dateTo, page, pageSize };
}

export function createAdminHandler({ auth, store, now, clientAddress, cookieSecure = false }) {
  const limits = new Map(); const windowMs = 15 * 60_000;
  const cookie = (token, clear = false) => `ezh_admin=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${cookieSecure ? '; Secure' : ''}`;
  // Reserve the attempt synchronously before scrypt yields. Parallel attempts
  // count against the same budget, including unknown usernames.
  const reserveAttempt = request => {
    const timestamp = now().getTime();
    for (const [address, limit] of limits) if (limit.reset <= timestamp) limits.delete(address);
    const address = clientAddress(request);
    let limit = limits.get(address);
    if (!limit && limits.size < 10000) { limit = { count: 0, reset: timestamp + windowMs }; limits.set(address, limit); }
    if (!limit || limit.count >= 5) throw failure('Слишком много попыток. Повторите через 15 минут.', 429);
    limit.count++; return limit;
  };
  return async (request, response, path) => {
    response.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => sendJson(response, status, body);
    try {
      const endpoint = path.slice('/api/admin'.length);
      const token = tokenFrom(request);
      const session = auth.session(token, now());
      const write = request.method === 'POST' || request.method === 'PATCH';
      const login = endpoint === '/login' && request.method === 'POST';
      if (!login && !session) { json(401, { message: 'Войдите в панель администратора.' }); return; }
      let body;
      if (write) {
        const scheme = cookieSecure || request.socket.encrypted ? 'https' : 'http';
        let expectedOrigin;
        try { expectedOrigin = new URL(`${scheme}://${request.headers.host}`).origin; } catch { throw failure('Недопустимый адрес сайта.', 403); }
        if (!request.headers.origin || request.headers.origin !== expectedOrigin) throw failure('Запрос разрешён только с сайта кофейни.', 403);
        if (!login && !equalToken(request.headers['x-csrf-token'], session.csrfToken)) throw failure('Сессия формы устарела. Обновите страницу.', 403);
        body = await readJson(request);
      }
      if (login) {
        if (!validUsername(body.username) || typeof body.password !== 'string' || body.password.length > 128) throw failure('Проверьте имя и пароль.', 400);
        const attempt = reserveAttempt(request);
        const user = auth.user(body.username);
        const verified = await verifyPassword(body.password, user?.password_hash);
        if (!verified || !user) { json(401, { message: 'Неверное имя или пароль.' }); return; }
        const fresh = auth.createSession(user.username, user.password_hash, now());
        if (!fresh) { json(401, { message: 'Пароль изменился. Войдите ещё раз.' }); return; }
        attempt.count--;
        response.setHeader('Set-Cookie', cookie(fresh.token));
        json(200, { username: fresh.username, csrfToken: fresh.csrfToken }); return;
      }
      if (endpoint === '/session' && request.method === 'GET') { json(200, session); return; }
      if (endpoint === '/logout' && request.method === 'POST') {
        auth.logout(token); response.setHeader('Set-Cookie', cookie('', true));
        json(200, { message: 'Вы вышли из панели.' }); return;
      }
      if (endpoint === '/password' && request.method === 'POST') {
        if (!validPassword(body.newPassword) || typeof body.currentPassword !== 'string' || body.currentPassword.length > 128) throw failure('Новый пароль должен содержать от 12 до 128 символов.', 400);
        const attempt = reserveAttempt(request);
        const user = auth.user(session.username);
        if (!user) { json(401, { message: 'Войдите в панель администратора.' }); return; }
        if (!(await verifyPassword(body.currentPassword, user.password_hash))) { json(400, { message: 'Текущий пароль неверный.' }); return; }
        const nextHash = await hashPassword(body.newPassword);
        if (!auth.changePassword(user.username, user.password_hash, nextHash, now())) { json(409, { message: 'Пароль изменился. Войдите ещё раз.' }); return; }
        attempt.count--;
        response.setHeader('Set-Cookie', cookie('', true));
        json(200, { message: 'Пароль изменён. Войдите с новым паролем.' }); return;
      }
      if (endpoint === '/bookings' && request.method === 'GET') {
        json(200, store.listBookings(filters(new URL(request.url, 'http://localhost').searchParams))); return;
      }
      const match = /^\/bookings\/(EZH-[A-Fa-f0-9]{8})$/.exec(endpoint);
      if (match && (request.method === 'GET' || request.method === 'PATCH')) {
        const id = match[1];
        if (request.method === 'PATCH') {
          if (!statuses.has(body.status) || !statuses.has(body.expectedStatus)) throw failure('Укажите корректный текущий и новый статус.', 400);
          store.updateStatus(id, body.status, now(), { expectedStatus: body.expectedStatus, actor: session.username });
        }
        const booking = store.getBooking(id);
        if (!booking) throw failure('Заявка не найдена.', 404);
        json(200, request.method === 'GET' ? { booking, history: store.bookingHistory(id) } : { booking }); return;
      }
      json(404, { message: 'Не найдено.' });
    } catch (error) {
      if (error.statusCode === 429) response.setHeader('Retry-After', '900');
      if (!error.statusCode) console.error('Admin request failed:', error.code || 'internal');
      json(error.statusCode || 503, { message: error.statusCode ? error.message : 'Не удалось выполнить запрос. Повторите позже.' });
    }
  };
}
