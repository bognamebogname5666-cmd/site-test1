import config from '../shared/config.json' with { type: 'json' };
import { moscowDate, type BookingInput, type BookingErrors } from '../shared/validation.mjs';
import { BookingSubmission } from './booking-state';

export function initBooking() {
  const form = document.querySelector<HTMLFormElement>('#booking-form');
  if (!form) return;
  const date = form.querySelector<HTMLInputElement>('#date')!;
  const time = form.querySelector<HTMLSelectElement>('#time')!;
  const guests = form.querySelector<HTMLSelectElement>('#guests')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const status = form.querySelector<HTMLParagraphElement>('#form-status')!;
  const success = form.querySelector<HTMLDivElement>('#booking-success')!;
  const fields = form.querySelector<HTMLDivElement>('#booking-fields')!;
  const submission = new BookingSubmission();
  const submitLabel = submit.querySelector('span')!;
  const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')];
  const recoveryMessage = 'Статус предыдущей заявки пока неизвестен. Проверьте исходную заявку повторной отправкой — дубликат не появится. Изменения в форме пока не отправлены.';
  const conflictMessage = `Заявка с этим номером уже существует. Чтобы уточнить её детали и не создать дубликат, позвоните нам: ${config.phone}.`;

  function updateSubmitLabel() {
    submitLabel.textContent = submission.needsRecovery ? 'Проверить исходную заявку' : 'Отправить заявку';
    submit.disabled = submission.conflicted;
  }

  function updateDateLimits() {
    date.min = moscowDate();
    const maxDate = new Date(`${date.min}T12:00:00+03:00`);
    maxDate.setUTCDate(maxDate.getUTCDate() + config.maxDaysAhead);
    date.max = moscowDate(maxDate);
  }
  updateDateLimits();
  date.addEventListener('focus', updateDateLimits);
  const guestNames = new Intl.PluralRules('ru');
  guests.replaceChildren();
  for (let count = 1; count <= config.maxGuests; count++) {
    const category = guestNames.select(count);
    const noun = category === 'one' ? 'гость' : category === 'few' ? 'гостя' : 'гостей';
    guests.add(new Option(`${count} ${noun}`, String(count), count === Math.min(2, config.maxGuests), count === Math.min(2, config.maxGuests)));
  }
  document.querySelectorAll<HTMLElement>('[data-guest-limit]').forEach(element => {
    element.textContent = `Бронирование для 1–${config.maxGuests} гостей`;
  });
  for (let hour = config.openHour; hour < config.closeHour; hour++) {
    for (const minute of ['00', '30']) {
      const value = `${String(hour).padStart(2, '0')}:${minute}`;
      time.add(new Option(value, value));
    }
  }
  function payload(): BookingInput {
    const data = new FormData(form!);
    return {
      name: String(data.get('name') || ''), phone: String(data.get('phone') || ''),
      date: String(data.get('date') || ''), time: String(data.get('time') || ''),
      guests: Number(data.get('guests')), consent: data.get('consent') === 'on',
      website: String(data.get('website') || ''), comment: String(data.get('comment') || '')
    };
  }
  function displayErrors(errors: BookingErrors) {
    controls.forEach(input => {
      const message = errors?.[input.name as keyof BookingInput];
      const output = document.getElementById(`${input.name}-error`);
      if (output) output.textContent = message || '';
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
  }
  function focusFirstError() {
    const invalid = form!.querySelector<HTMLElement>('[aria-invalid=true]');
    const details = invalid?.closest('details');
    if (details) details.open = true;
    invalid?.focus();
  }
  form.addEventListener('input', event => {
    const input = event.target;
    if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement) {
      input.removeAttribute('aria-invalid');
      const output = document.getElementById(`${input.name}-error`);
      if (output) output.textContent = '';
      status.textContent = submission.conflicted ? conflictMessage : submission.needsRecovery ? recoveryMessage : '';
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const attempt = submission.prepare(payload());
    if (attempt.type === 'pending' || attempt.type === 'complete') return;
    if (attempt.type === 'conflict') {
      status.textContent = conflictMessage;
      return;
    }
    if (attempt.type === 'invalid') {
      displayErrors(attempt.errors);
      status.textContent = 'Проверьте отмеченные поля.';
      focusFirstError();
      return;
    }
    displayErrors({});
    submit.disabled = true;
    submitLabel.textContent = 'Отправляем заявку…';
    form.setAttribute('aria-busy', 'true');
    status.textContent = '';
    // Only freeze fields while sending; recovery keeps its own immutable snapshot.
    controls.forEach(control => { control.disabled = true; });
    try {
      const response = await fetch('/api/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: attempt.payload, signal: AbortSignal.timeout(12000)
      });
      const result = submission.receive(response.status, await response.json());
      if (result.type === 'rejected') {
        displayErrors(result.errors);
        status.textContent = result.message || 'Проверьте отмеченные поля.';
        return;
      }
      if (result.type === 'conflict') {
        status.textContent = conflictMessage;
        return;
      }
      if (result.type === 'retry') {
        status.textContent = result.message ? `${result.message} ${recoveryMessage}` : recoveryMessage;
        return;
      }
      document.getElementById('booking-receipt')!.textContent = `Номер заявки: ${result.id}`;
      fields.hidden = true;
      success.hidden = false;
      success.focus();
    } catch {
      submission.fail();
      status.textContent = `Связь прервалась. ${recoveryMessage}`;
    } finally {
      updateSubmitLabel();
      controls.forEach(control => { control.disabled = false; });
      focusFirstError();
      form.removeAttribute('aria-busy');
    }
  });
  document.getElementById('another-booking')?.addEventListener('click', () => {
    form.reset();
    displayErrors({});
    status.textContent = '';
    submission.reset();
    updateSubmitLabel();
    success.hidden = true;
    fields.hidden = false;
    updateDateLimits();
    form.querySelector<HTMLInputElement>('#name')?.focus();
  });
  // HTML keeps submission disabled until the real handler is attached.
  updateSubmitLabel();
}
