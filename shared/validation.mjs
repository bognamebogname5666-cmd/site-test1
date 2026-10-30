// @ts-check
import config from './config.json' with { type: 'json' };

/**
 * @typedef {object} BookingInput
 * @property {string} name
 * @property {string} phone
 * @property {string} date
 * @property {string} time
 * @property {number} guests
 * @property {boolean} consent
 * @property {string} website
 * @property {string} comment
 */
/** @typedef {Partial<Record<keyof BookingInput, string>>} BookingErrors */
/** @typedef {{ errors: BookingErrors, value: Omit<BookingInput, 'website'> }} BookingResult */

/** @param {Date} [now] */
export function moscowDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/** @param {unknown} input @param {Date} [now] @returns {BookingResult} */
export function validateBooking(input, now = new Date()) {
  const data = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  /** @type {BookingErrors} */
  const errors = {};
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const rawPhone = typeof data.phone === 'string' ? data.phone : '';
  const digits = rawPhone.replace(/\D/g, '');
  const phone = digits.length === 11 && /^[78]/.test(digits) ? `+7${digits.slice(1)}` : '';
  const date = typeof data.date === 'string' ? data.date : '';
  const time = typeof data.time === 'string' ? data.time : '';
  const comment = typeof data.comment === 'string' ? data.comment.trim() : '';
  const guests = typeof data.guests === 'number' ? data.guests : NaN;

  if (name.length < 2 || name.length > 80 || /[<>\x00-\x1f]/.test(name)) {
    errors.name = 'Укажите имя от 2 до 80 символов.';
  }
  if (!phone || !/^[+\d()\s-]+$/.test(rawPhone)) {
    errors.phone = 'Введите российский номер: +7 и ещё 10 цифр.';
  }
  if ((data.comment !== undefined && typeof data.comment !== 'string') || comment.length > 300 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(comment)) {
    errors.comment = 'Пожелание должно быть не длиннее 300 символов, без HTML-разметки.';
  }

  const today = moscowDate(now);
  const max = new Date(`${today}T12:00:00+03:00`);
  max.setUTCDate(max.getUTCDate() + config.maxDaysAhead);
  const dateValue = new Date(`${date}T12:00:00+03:00`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
    && !Number.isNaN(dateValue.getTime()) && moscowDate(dateValue) === date;
  if (!validDate || date < today || date > moscowDate(max)) {
    errors.date = `Выберите дату от сегодня до ${config.maxDaysAhead} дней вперёд.`;
  }

  const [hour, minute] = time.split(':').map(Number);
  if (!/^\d{2}:(00|30)$/.test(time) || hour < config.openHour || hour >= config.closeHour || !Number.isFinite(minute)) {
    const firstSlot = `${String(config.openHour).padStart(2, '0')}:00`;
    const lastSlot = `${String(config.closeHour - 1).padStart(2, '0')}:30`;
    errors.time = `Выберите время с ${firstSlot} до ${lastSlot} с шагом 30 минут.`;
  } else if (!errors.date && new Date(`${date}T${time}:00+03:00`).getTime() <= now.getTime() + 30 * 60_000) {
    errors.time = 'Пожалуйста, выберите время хотя бы через 30 минут.';
  }

  if (!Number.isInteger(guests) || guests < 1 || guests > config.maxGuests) {
    errors.guests = `Можно забронировать столик для 1–${config.maxGuests} гостей.`;
  }
  if (data.consent !== true) {
    errors.consent = 'Нужно согласие на обработку данных для связи по заявке.';
  }
  if (data.website) errors.website = 'Не удалось отправить заявку.';
  return { errors, value: { name, phone, date, time, guests, comment, consent: true } };
}
