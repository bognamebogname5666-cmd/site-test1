import config from '../shared/config.json' with { type: 'json' };
import { initBooking } from './booking';
import { initDialogs } from './dialogs';
import { initMap } from './map';
import { initMenu } from './menu';
import { initNavigation } from './navigation';

document.querySelectorAll<HTMLElement>('[data-location]').forEach(element => {
  element.textContent = `${config.city}, ${config.address}`;
});
document.querySelectorAll<HTMLElement>('[data-hours]').forEach(element => {
  element.textContent = `${String(config.openHour).padStart(2, '0')}:00–${config.closeHour}:00`;
});
document.querySelectorAll<HTMLAnchorElement>('[data-phone]').forEach(element => {
  element.textContent = config.phone;
  element.href = `tel:${config.phoneHref}`;
});
document.querySelectorAll<HTMLAnchorElement>('[data-directions]').forEach(element => { element.href = config.directionsUrl; });
if (!config.fictionalBusiness) document.querySelectorAll('.demo-note').forEach(element => element.remove());
const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

initNavigation();
initDialogs();
initMenu();
initMap();
initBooking();
document.documentElement.classList.remove('no-js');
