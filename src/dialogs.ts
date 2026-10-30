import { drinks, gallery } from './content';
import { required } from './dom';
import { responsiveImage } from '../shared/responsive-images.mjs';

export function initDialogs() {
  const open = (dialog: HTMLDialogElement) => {
    dialog.showModal();
    document.body.classList.add('modal-open');
  };
  document.querySelectorAll<HTMLDialogElement>('dialog').forEach(dialog => {
    dialog.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => document.body.classList.remove('modal-open'));
    dialog.addEventListener('click', event => {
      const box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
    });
  });
  const drinkDialog = required<HTMLDialogElement>('#drink-dialog');
  const image = required<HTMLImageElement>('#drink-image');
  const title = required<HTMLElement>('#drink-title');
  const price = required<HTMLElement>('#drink-price');
  const description = required<HTMLElement>('#drink-description');
  const allergens = required<HTMLElement>('#drink-allergens');
  const openDrink = (index: number) => {
    const drink = drinks[index];
    if (!drink) return;
    title.textContent = drink.name;
    price.textContent = `${drink.price} ₽ · ${drink.volume}`;
    description.textContent = drink.description;
    allergens.textContent = drink.allergens;
    // Only the featured drinks have dedicated product photography.
    image.hidden = !drink.featured;
    const responsive = responsiveImage(drink.image, '(max-width: 760px) calc(100vw - 24px), 430px');
    image.sizes = responsive.sizes;
    image.srcset = responsive.srcset;
    image.src = responsive.src;
    image.alt = drink.name;
    drinkDialog.classList.toggle('drink-dialog-text', !drink.featured);
    open(drinkDialog);
  };
  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-drink]') : null;
    if (button) openDrink(Number(button.dataset.drink));
  });
  required('#drink-booking').addEventListener('click', () => drinkDialog.close());

  const lightbox = required<HTMLDialogElement>('#lightbox');
  const photoImage = required<HTMLImageElement>('#lightbox-image');
  const caption = required<HTMLElement>('#lightbox-caption');
  let index = 0;
  const showPhoto = (next: number) => {
    index = (next + gallery.length) % gallery.length;
    const photo = gallery[index];
    const responsive = responsiveImage(photo.src, '(max-width: 760px) calc(100vw - 16px), (max-width: 1140px) calc(100vw - 40px), 1100px');
    photoImage.sizes = responsive.sizes;
    photoImage.srcset = responsive.srcset;
    photoImage.src = responsive.src;
    photoImage.alt = photo.alt;
    caption.textContent = photo.caption;
  };
  document.querySelectorAll<HTMLButtonElement>('[data-gallery]').forEach(button => button.addEventListener('click', () => {
    showPhoto(Number(button.dataset.gallery));
    open(lightbox);
  }));
  required('.gallery-prev').addEventListener('click', () => showPhoto(index - 1));
  required('.gallery-next').addEventListener('click', () => showPhoto(index + 1));
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showPhoto(index + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  const privacy = required<HTMLDialogElement>('#privacy-dialog');
  document.querySelectorAll<HTMLButtonElement>('[data-privacy]').forEach(button => button.addEventListener('click', () => open(privacy)));
}
