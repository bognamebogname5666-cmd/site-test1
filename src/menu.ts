import { drinks, tastes, type Taste } from './content';
import { required } from './dom';

export function initMenu() {
  const filters = [...document.querySelectorAll<HTMLButtonElement>('[data-category]')];
  const items = [...document.querySelectorAll<HTMLElement>('[data-menu-category]')];
  const count = required<HTMLElement>('#menu-count');
  filters.forEach(button => button.addEventListener('click', () => {
    const category = button.dataset.category;
    filters.forEach(filter => filter.setAttribute('aria-pressed', String(filter === button)));
    items.forEach(item => { item.hidden = category !== 'all' && item.dataset.menuCategory !== category; });
    count.textContent = `Количество напитков: ${items.filter(item => !item.hidden).length}.`;
  }));
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-mood]')];
  const result = required<HTMLElement>('#taste-result');
  const recommend = (taste: Taste) => {
    const choice = tastes[taste];
    const index = drinks.findIndex(drink => drink.id === choice.drinkId);
    const drink = drinks[index];
    if (!drink) return;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mood === taste)));
    const text = document.createElement('div');
    const title = document.createElement('h4');
    const note = document.createElement('p');
    const details = document.createElement('button');
    title.textContent = drink.name;
    title.id = 'recommended-drink-title';
    note.textContent = choice.note;
    details.type = 'button';
    details.className = 'taste-details';
    details.dataset.drink = String(index);
    details.setAttribute('aria-haspopup', 'dialog');
    details.setAttribute('aria-describedby', title.id);
    details.textContent = `${drink.price} ₽ · ${drink.volume} ↗`;
    text.append(title, note);
    result.replaceChildren(text, details);
  };
  buttons.forEach(button => button.addEventListener('click', () => {
    const taste = button.dataset.mood;
    if (taste && Object.hasOwn(tastes, taste)) recommend(taste as Taste);
  }));
  recommend('soft');
}
