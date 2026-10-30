import catalog from '../shared/catalog.json' with { type: 'json' };
import config from '../shared/config.json' with { type: 'json' };
import { responsiveImage } from '../shared/responsive-images.mjs';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const price = item => `${item.price} ₽`;

export function renderFeatured() {
  return catalog.flatMap((item, index) => {
    if (!item.featured) return [];
    const image = responsiveImage(item.image, '(max-width: 760px) 86px, (max-width: 1100px) 9vw, 124px');
    const responsive = image.srcset ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"` : '';
    return [`
    <button class="drink-card" type="button" data-drink="${index}" aria-haspopup="dialog">
      <img src="${escapeHtml(image.src)}"${responsive} width="240" height="200" alt="" />
      <span class="drink-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.teaser)}</span><b>${price(item)} <small>· ${escapeHtml(item.volume)}</small></b></span>
      <span class="round-arrow" aria-hidden="true">↗</span>
    </button>`];
  }).join('');
}

export function renderMenu() {
  return catalog.map((item, index) => `
    <li class="menu-item" data-menu-category="${escapeHtml(item.category)}">
      <button type="button" data-drink="${index}" aria-haspopup="dialog">
        <span class="menu-item-name">${escapeHtml(item.name)}${item.category === 'signature' ? '<small class="menu-badge">Ёж советует</small>' : ''}</span>
        <span class="menu-item-price">${price(item)}</span>
        <span class="menu-item-notes">${escapeHtml(item.teaser)}</span>
        <span class="menu-item-volume">${escapeHtml(item.volume)} <span aria-hidden="true">↗</span></span>
      </button>
    </li>`).join('');
}

export function catalogHtml() {
  return {
    name: 'cafe-content',
    transformIndexHtml(html) {
      return html.replace('<!-- @featured -->', renderFeatured())
        .replace('<!-- @menu -->', renderMenu())
        .replaceAll('<!-- @location -->', escapeHtml(`${config.city}, ${config.address}`))
        .replaceAll('<!-- @hours -->', `${String(config.openHour).padStart(2, '0')}:00–${config.closeHour}:00`)
        .replaceAll('<!-- @phone -->', escapeHtml(config.phone))
        .replaceAll('__PHONE_HREF__', escapeHtml(config.phoneHref))
        .replaceAll('__DIRECTIONS_URL__', escapeHtml(config.directionsUrl));
    }
  };
}
