import { required } from '../dom';
import { AdminApi, ApiError } from './api';

export function initPassword(api: AdminApi, changed: () => void, expired: () => void) {
  const dialog = required<HTMLDialogElement>('#admin-password-dialog');
  const form = required<HTMLFormElement>('#admin-password-form');
  const current = required<HTMLInputElement>('#admin-current-password');
  const password = required<HTMLInputElement>('#admin-new-password');
  const confirm = required<HTMLInputElement>('#admin-confirm-password');
  const status = required<HTMLElement>('#admin-password-status');
  const submit = required<HTMLButtonElement>('button[type=submit]', form);
  let pending = false;
  required('#admin-password-open').addEventListener('click', () => {
    form.reset(); status.textContent = '';
    dialog.showModal(); document.body.classList.add('modal-open');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (pending) return;
    const invalid = !current.value ? current : password.value.length < 12 || password.value.length > 128 ? password : confirm.value !== password.value ? confirm : null;
    if (invalid) {
      status.textContent = invalid === confirm ? 'Новые пароли не совпадают.' : invalid === current ? 'Введите текущий пароль.' : 'Новый пароль должен содержать от 12 до 128 символов.';
      invalid.focus(); return;
    }
    pending = true; submit.disabled = true; form.setAttribute('aria-busy', 'true'); status.textContent = '';
    const generation = api.sessionGeneration;
    try {
      await api.changePassword(current.value, password.value);
      // A successful password change itself advances the API generation once.
      if (api.sessionGeneration !== generation + 1) return;
      form.reset(); dialog.close(); changed();
    } catch (error) {
      if (api.sessionGeneration !== generation) return;
      if (error instanceof ApiError && error.status === 401) { dialog.close(); expired(); }
      else status.textContent = error instanceof ApiError ? error.message : 'Связь прервалась. Если пароль уже изменился, войдите с новым паролем; иначе повторите отправку.';
    } finally { pending = false; submit.disabled = false; form.removeAttribute('aria-busy'); }
  });
  dialog.addEventListener('close', () => { form.reset(); status.textContent = ''; });
  submit.disabled = false;
  return { clear() { form.reset(); status.textContent = ''; if (dialog.open) dialog.close(); } };
}
