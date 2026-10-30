import { statusLabels, type AdminBooking, type BookingDetail, type BookingList, type BookingStatus } from './types';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
const dateFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
const timestampFormat = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
function formatDate(value: string, timestamp = false) {
  const date = new Date(timestamp ? value : `${value}T12:00:00+03:00`);
  return Number.isNaN(date.getTime()) ? value : (timestamp ? timestampFormat : dateFormat).format(date);
}
function statusBadge(status: BookingStatus) {
  const badge = element('span', 'status-badge', statusLabels[status]);
  badge.dataset.status = status;
  return badge;
}
export function renderOverview(root: HTMLElement, counts: BookingList['counts'], selected: string) {
  root.replaceChildren(...(Object.keys(statusLabels) as BookingStatus[]).map(status => {
    const button = element('button', 'overview-card');
    button.type = 'button';
    button.dataset.filterStatus = status;
    button.setAttribute('aria-pressed', String(status === selected));
    button.append(element('span', '', statusLabels[status]), element('strong', '', String(counts[status])));
    return button;
  }));
}
export function renderBookings(root: HTMLElement, list: BookingList, busy: ReadonlySet<string>, filtered: boolean) {
  if (!list.items.length) {
    const empty = element('div', 'admin-empty');
    const image = element('img'); image.src = '/images/hedgehog.svg'; image.alt = ''; image.width = 80; image.height = 80;
    empty.append(image, element('h2', '', filtered ? 'Ничего не нашлось' : 'Пока тихо'), element('p', 'muted', filtered ? 'Измените условия поиска или сбросьте фильтры.' : 'Новые заявки появятся здесь после отправки формы на сайте.'));
    root.replaceChildren(empty);
    return;
  }
  root.replaceChildren(...list.items.map(row => renderBooking(row, busy.has(row.id))));
}
function renderBooking(row: AdminBooking, busy: boolean) {
  const article = element('article', 'booking-row');
  article.dataset.id = row.id;
  article.setAttribute('aria-labelledby', `guest-${row.id}`);
  const visit = element('div', 'visit-cell');
  visit.append(element('strong', 'visit-time', row.time), element('span', '', formatDate(row.date)), element('small', 'muted', `Гостей: ${row.guests}`));
  const guest = element('div', 'guest-cell');
  const title = element('h2', '', row.name); title.id = `guest-${row.id}`;
  const phone = element('a', 'guest-phone', row.phone); phone.href = `tel:${row.phone.replace(/[^+\d]/g, '')}`;
  guest.append(title, phone, element('small', 'muted booking-number', row.id));
  const note = element('div', 'note-cell');
  note.append(element('p', row.comment ? '' : 'muted', row.comment || 'Без пожеланий'), element('small', 'muted', `Получена ${formatDate(row.createdAt, true)}`));
  const controls = element('div', 'booking-controls');
  controls.append(statusBadge(row.status));
  const actions = element('div', 'booking-actions');
  const button = (label: string, status: BookingStatus, className: string) => {
    const control = element('button', className, label); control.type = 'button';
    control.dataset.adminAction = status; control.dataset.id = row.id; control.disabled = busy;
    return control;
  };
  if (row.status === 'requested') actions.append(button('Подтвердить', 'confirmed', 'action-confirm'));
  if (row.status === 'confirmed') actions.append(button('Завершить визит', 'completed', 'action-confirm'));
  if (row.status === 'requested' || row.status === 'confirmed') actions.append(button('Отменить', 'cancelled', 'action-cancel'));
  const details = element('button', 'detail-button', 'Подробнее и история'); details.type = 'button';
  details.dataset.adminDetail = row.id; details.disabled = busy; details.setAttribute('aria-haspopup', 'dialog');
  controls.append(actions, details);
  article.append(visit, guest, note, controls);
  return article;
}
export function renderDetail(root: HTMLElement, detail: BookingDetail) {
  const { booking: row, history } = detail;
  const definition = element('dl', 'booking-definition');
  for (const [label, value] of [
    ['Гость', row.name], ['Телефон', row.phone], ['Визит', `${formatDate(row.date)}, ${row.time} (Москва)`],
    ['Количество гостей', String(row.guests)], ['Статус', statusLabels[row.status]],
    ['Пожелание', row.comment || 'Без пожеланий'], ['Заявка получена', formatDate(row.createdAt, true)]
  ]) definition.append(element('dt', '', label), element('dd', '', value));
  const log = element('ol', 'status-history');
  history.forEach(item => {
    const entry = element('li');
    entry.append(element('strong', '', `${statusLabels[item.fromStatus]} → ${statusLabels[item.toStatus]}`), element('small', 'muted', `${formatDate(item.at, true)} · ${item.actor}`));
    log.append(entry);
  });
  root.replaceChildren(definition, element('h3', '', 'История статусов'), history.length ? log : element('p', 'muted', 'Статус пока не менялся.'));
}
