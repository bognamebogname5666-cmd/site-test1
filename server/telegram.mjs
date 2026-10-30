/**
 * @typedef {object} TelegramOptions
 * @property {string} [token] Server-side Telegram bot token.
 * @property {string} [chatId] Staff chat that receives personal booking details.
 * @property {typeof globalThis.fetch} [fetch] HTTP transport; defaults to fetch.
 */
/**
 * Telegram transport throws on failure so the outbox retains the delivery.
 * @param {string} id
 * @param {Omit<import('./bookings.mjs').BookingValue, 'consent'>} value
 * @param {TelegramOptions} options
 */
export async function notifyTelegram(id, value, { token, chatId, fetch: request = globalThis.fetch }) {
  const response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `Заявка ${id}\n${value.name}\n${value.phone}\n${value.date}, ${value.time}\nГостей: ${value.guests}\nПожелание: ${value.comment || 'нет'}\nСвяжитесь с гостем для подтверждения.` }),
    signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error('Telegram delivery failed.');
}

/**
 * Durable at-least-once delivery: a crash after Telegram accepts a message can
 * produce a duplicate. The booking ID lets staff recognize the same request.
 * Retries back off from 30 seconds to six hours; a 60-second lease recovers
 * interrupted sends and prevents two active workers claiming the same row.
 */
export function createNotificationWorker({ store, send, now = () => new Date() }) {
  let timer;
  let running;
  let stopped = false;
  const flush = () => {
    if (running) return running;
    if (stopped) return Promise.resolve();
    running = (async () => {
      for (let batch = 0; batch < 20 && !stopped; batch++) {
        const claim = store.claimNotification(now());
        if (!claim) break;
        let delivered = false;
        try { await send(claim.id, claim.value); delivered = true; }
        catch { console.error(`Telegram delivery pending for ${claim.id}; will retry.`); }
        store.settleNotification(claim, now(), delivered);
      }
    })().catch(error => {
      // No payloads, tokens, phone numbers, or external exception text in logs.
      console.error('Notification queue unavailable:', error.code || 'internal');
    }).finally(() => { running = undefined; });
    return running;
  };
  return {
    flush,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => { void flush(); }, 30_000);
      timer.unref();
      void flush();
    },
    async stop() { stopped = true; clearInterval(timer); await running; }
  };
}
