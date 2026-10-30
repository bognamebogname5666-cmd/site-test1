import { required } from '../dom';
import { AdminApi, ApiError } from './api';
import { initDashboard } from './dashboard';
import { initPassword } from './password';
import type { AdminSession } from './types';

const api = new AdminApi();
const auth = required<HTMLElement>('#admin-auth');
const dashboardRoot = required<HTMLElement>('#admin-dashboard');
const boot = required<HTMLElement>('#admin-boot');
const form = required<HTMLFormElement>('#admin-login-form');
const username = required<HTMLInputElement>('#admin-username');
const password = required<HTMLInputElement>('#admin-password');
const loginStatus = required<HTMLElement>('#admin-login-status');
const submit = required<HTMLButtonElement>('button[type=submit]', form);
let loginPending = false;
const dashboard = initDashboard(api, () => showLogin('Сеанс завершён. Войдите ещё раз.'));

function showLogin(message = '', kind = 'error') {
  api.clearSession(); passwordPanel.clear();
  dashboard.clear(); dashboardRoot.hidden = true; auth.hidden = false; boot.hidden = true;
  required('#admin-account').textContent = '';
  password.value = ''; loginStatus.textContent = message; loginStatus.dataset.kind = kind;
  if (message) username.focus();
}
async function signedIn(session: AdminSession) {
  password.value = ''; loginStatus.textContent = '';
  boot.hidden = true; auth.hidden = true; dashboardRoot.hidden = false;
  required('#admin-account').textContent = `Сотрудник: ${session.username}`;
  await dashboard.start();
}
document.querySelectorAll<HTMLDialogElement>('.admin-dialog').forEach(dialog => {
  dialog.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    if (![...document.querySelectorAll<HTMLDialogElement>('.admin-dialog')].some(item => item.open)) document.body.classList.remove('modal-open');
  });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
  });
});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (loginPending) return;
  if (!username.value.trim() || !password.value) {
    loginStatus.textContent = 'Введите логин и пароль.';
    (!username.value.trim() ? username : password).focus(); return;
  }
  loginPending = true; submit.disabled = true; form.setAttribute('aria-busy', 'true'); loginStatus.textContent = '';
  try { await signedIn(await api.login(username.value.trim(), password.value)); }
  catch (error) {
    loginStatus.textContent = error instanceof ApiError ? error.message : 'Не удалось связаться с сервером. Проверьте соединение и повторите вход.';
    loginStatus.dataset.kind = 'error'; password.focus();
  } finally { loginPending = false; submit.disabled = false; form.removeAttribute('aria-busy'); }
});
required<HTMLButtonElement>('#admin-show-password').addEventListener('click', event => {
  const button = event.currentTarget as HTMLButtonElement;
  const visible = password.type === 'password'; password.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible)); button.textContent = visible ? 'Скрыть пароль' : 'Показать пароль';
});
required<HTMLButtonElement>('#admin-logout').addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
  const generation = api.sessionGeneration;
  try {
    await api.logout();
    if (api.sessionGeneration === generation + 1) showLogin('Вы вышли из панели.', 'success');
  }
  catch (error) {
    if (api.sessionGeneration !== generation) return;
    if (error instanceof ApiError && error.status === 401) showLogin('Сеанс уже завершён.');
    else required('#admin-status-message').textContent = 'Не удалось подтвердить выход на сервере. Проверьте соединение и повторите выход.';
  } finally { button.disabled = false; }
});
const passwordPanel = initPassword(api, () => showLogin('Пароль изменён. Войдите с новым паролем.', 'success'), () => showLogin('Сеанс завершён. Войдите ещё раз.'));
submit.disabled = false;
const initialSession = api.session();
const initialGeneration = api.sessionGeneration;
try {
  const session = await initialSession;
  if (api.sessionGeneration === initialGeneration) await signedIn(session);
} catch (error) {
  if (api.sessionGeneration === initialGeneration) showLogin(error instanceof ApiError && error.status === 401 ? '' : 'Не удалось проверить вход. Попробуйте войти снова.');
}
