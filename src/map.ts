import config from '../shared/config.json' with { type: 'json' };
import { required } from './dom';

export function initMap() {
  const frame = required<HTMLIFrameElement>('#cafe-map');
  const button = required<HTMLButtonElement>('[data-load-map]');
  const status = required<HTMLElement>('#map-status');
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    clearTimeout(timer);
    frame.hidden = false;
    frame.src = config.mapEmbed;
    button.textContent = 'Загрузить ещё раз';
    status.textContent = 'Загружаем карту. Если она не появится, откройте маршрут по ссылке ниже.';
    // Cross-origin iframe load events cannot prove the map rendered successfully.
    timer = setTimeout(() => {
      status.textContent = 'Не видите карту? Повторите загрузку или откройте маршрут по ссылке ниже.';
    }, 8000);
  });
}
