import { validateBooking } from '../shared/validation.mjs';

export function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * HTTP boundary for booking creation. The persisted normalized payload is also
 * the idempotency fingerprint. Replay precedes current-time eligibility and rate
 * checks so a saved receipt remains recoverable after a timeout or cutoff.
 */
export function createBookingHandler({ store, now, rateLimit, clientAddress, notifications }) {
  const limits = new Map();
  const windowMs = 15 * 60_000;
  return async (request, response) => {
    const json = (status, body) => sendJson(response, status, body);
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      json(405, { message: 'Используйте форму бронирования.' });
      return;
    }
    if (request.headers.origin) {
      let originHost;
      try { originHost = new URL(request.headers.origin).host; } catch { originHost = ''; }
      if (originHost !== request.headers.host) { json(403, { message: 'Отправьте заявку с сайта кофейни.' }); return; }
    }
    if (!request.headers['content-type']?.startsWith('application/json')) { json(415, { message: 'Ожидается JSON.' }); return; }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key)) { json(400, { message: 'Обновите страницу и попробуйте ещё раз.' }); return; }
    const chunks = [];
    let byteLength = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > 8192) { json(413, { message: 'Слишком большой запрос.' }); return; }
        chunks.push(buffer);
      }
      const result = validateBooking(JSON.parse(Buffer.concat(chunks).toString('utf8')), now());
      const existing = store.find(key);
      if (existing) {
        if (existing.payload_hash !== store.hash(result.value)) { json(409, { message: 'Заявка с этим номером уже существует. Позвоните нам, чтобы уточнить её детали и не создать дубликат.' }); return; }
        json(200, { id: existing.id, status: 'requested' });
        return;
      }
      if (Object.keys(result.errors).length) { json(422, { message: 'Проверьте поля формы.', errors: result.errors }); return; }
      const timestamp = now().getTime();
      for (const [address, limit] of limits) if (limit.reset <= timestamp) limits.delete(address);
      const address = clientAddress(request);
      const limit = limits.get(address) || { count: 0, reset: timestamp + windowMs };
      if (limit.count >= rateLimit || limits.size >= 10000) {
        response.setHeader('Retry-After', '900');
        json(429, { message: 'Слишком много заявок. Попробуйте через 15 минут или позвоните нам.' });
        return;
      }
      const id = store.save(result.value, key, now(), { notify: Boolean(notifications) });
      limit.count++;
      limits.set(address, limit);
      json(201, { id, status: 'requested' });
      void notifications?.flush();
    } catch (error) {
      if (error instanceof SyntaxError) json(400, { message: 'Некорректный формат заявки.' });
      else {
        console.error('Booking request failed:', error.code || 'internal');
        json(503, { message: 'Сейчас не получилось сохранить заявку. Данные остались в форме — попробуйте ещё раз.' });
      }
    }
  };
}
