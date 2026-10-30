import { required } from './dom';

export function initNavigation() {
  const toggle = required<HTMLButtonElement>('.menu-toggle');
  const nav = required<HTMLElement>('#mobile-nav');
  const close = (restoreFocus = false) => {
    nav.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Открыть меню');
    if (restoreFocus) toggle.focus();
  };
  toggle.addEventListener('click', () => {
    const open = nav.hidden;
    nav.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  });
  nav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => close()));
  document.addEventListener('click', event => {
    if (event.target instanceof Node && !nav.contains(event.target) && !toggle.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !nav.hidden) close(true);
  });
  matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) close(); });
}
