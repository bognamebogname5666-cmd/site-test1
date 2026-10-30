import { required } from '../dom';
import { AdminApi, ApiError } from './api';
import { isStatus, type BookingFilters, type BookingList } from './types';
import { renderBookings, renderDetail, renderOverview } from './view';

export function initDashboard(api: AdminApi, expired: () => void) {
  const form = required<HTMLFormElement>('#admin-filter-form');
  const search = required<HTMLInputElement>('#admin-search');
  const status = required<HTMLSelectElement>('#admin-status');
  const dateFrom = required<HTMLInputElement>('#admin-date-from');
  const dateTo = required<HTMLInputElement>('#admin-date-to');
  const results = required<HTMLElement>('#admin-results');
  const overview = required<HTMLElement>('#admin-overview');
  const feedback = required<HTMLElement>('#admin-status-message');
  const refresh = required<HTMLButtonElement>('#admin-refresh');
  const previous = required<HTMLButtonElement>('#admin-prev');
  const next = required<HTMLButtonElement>('#admin-next');
  const detail = required<HTMLDialogElement>('#admin-detail-dialog');
  const busy = new Set<string>();
  let page = 1;
  let list: BookingList | null = null;
  let sequence = 0;
  let request: AbortController | null = null;
  let enabled = false;
  let generation = 0;
  const filters = (): BookingFilters => ({
    status: isStatus(status.value) ? status.value : 'all', q: search.value.trim(),
    dateFrom: dateFrom.value, dateTo: dateTo.value, page
  });
  const showMessage = (text: string, kind = 'error') => { feedback.textContent = text; feedback.dataset.kind = kind; };
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { expired(); return; }
    showMessage(error instanceof ApiError ? error.message : 'Связь с сервером прервалась. Проверьте соединение и обновите список.');
  }
  const render = () => {
    if (!list || !enabled) return;
    const current = filters();
    renderOverview(overview, list.counts, current.status);
    renderBookings(results, list, busy, !!(current.q || current.dateFrom || current.dateTo || current.status !== 'all'));
    required('#admin-result-count').textContent = `Найдено заявок: ${list.total}`;
    const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
    required('#admin-page-label').textContent = `Страница ${list.page} из ${pages}`;
    previous.disabled = list.page <= 1;
    next.disabled = list.page >= pages;
  };
  async function load() {
    if (!enabled) return;
    request?.abort(); request = new AbortController();
    const current = ++sequence;
    results.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    previous.disabled = true; next.disabled = true;
    try {
      const data = await api.list(filters(), request.signal);
      if (current !== sequence || !enabled) return;
      if (data.items.length === 0 && page > 1 && data.total > 0) {
        page = Math.ceil(data.total / data.pageSize);
        await load(); return;
      }
      list = data;
      render();
    } catch (error) {
      if (current !== sequence || !enabled || (error instanceof Error && error.name === 'AbortError')) return;
      fail(error);
    } finally {
      if (current === sequence && enabled) { results.setAttribute('aria-busy', 'false'); refresh.disabled = false; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); page = 1; showMessage(''); void load(); });
  required('#admin-filter-reset').addEventListener('click', () => { form.reset(); page = 1; showMessage(''); void load(); });
  refresh.addEventListener('click', () => { showMessage(''); void load(); });
  previous.addEventListener('click', () => { if (page > 1) { page--; void load(); } });
  next.addEventListener('click', () => { page++; void load(); });
  overview.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-filter-status]') : null;
    if (!button || !isStatus(button.dataset.filterStatus)) return;
    status.value = button.dataset.filterStatus; page = 1; showMessage(''); void load();
  });
  results.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled) return;
    const currentGeneration = generation;
    const isCurrent = () => enabled && generation === currentGeneration;
    const detailId = button.dataset.adminDetail;
    if (detailId) {
      button.disabled = true;
      try {
        const data = await api.detail(detailId);
        if (!isCurrent()) return;
        required('#admin-detail-title').textContent = `Заявка ${data.booking.id}`;
        renderDetail(required('#admin-detail-body'), data);
        detail.showModal(); document.body.classList.add('modal-open');
      } catch (error) { if (isCurrent()) fail(error); }
      finally { if (isCurrent()) button.disabled = false; }
      return;
    }
    const id = button.dataset.id;
    const action = button.dataset.adminAction;
    const row = list?.items.find(item => item.id === id);
    if (!id || !row || !isStatus(action) || busy.has(id)) return;
    busy.add(id); render(); showMessage('');
    try {
      await api.changeStatus(id, action, row.status);
      if (!isCurrent()) return;
      const messages = { confirmed: 'Заявка подтверждена.', cancelled: 'Заявка отменена.', completed: 'Визит завершён.', requested: 'Статус обновлён.' };
      showMessage(`${row.id}: ${messages[action]}`, 'success');
      await load();
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.status === 409) {
        showMessage('Заявка уже изменилась. Список обновлён — проверьте её текущий статус.');
        await load();
      } else {
        fail(error);
        // The server may have committed before a response was lost; refresh first.
        if (!(error instanceof ApiError) || error.status === 504) await load();
      }
    } finally {
      if (isCurrent()) { busy.delete(id); render(); }
      if (isCurrent() && document.activeElement === document.body) {
        const target = results.querySelector<HTMLButtonElement>(`article[data-id="${CSS.escape(id)}"] button:enabled`) || results.querySelector<HTMLButtonElement>('button:enabled') || refresh;
        target.focus();
      }
    }
  });
  return {
    async start() { ++generation; enabled = true; page = 1; form.reset(); showMessage(''); await load(); },
    clear() {
      ++generation; enabled = false; ++sequence; request?.abort(); list = null; busy.clear();
      results.replaceChildren(); overview.replaceChildren(); feedback.textContent = '';
      required('#admin-detail-body').replaceChildren();
      if (detail.open) detail.close();
      required('#admin-result-count').textContent = '';
      required('#admin-page-label').textContent = '';
    }
  };
}
