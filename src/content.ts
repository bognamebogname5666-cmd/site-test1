import catalog from '../shared/catalog.json' with { type: 'json' };

export const drinks = catalog;
export const tastes = {
  soft: { drinkId: 'cappuccino', note: 'Мягкий молочный вкус и бархатная пена. Хороший повод начать утро без спешки.' },
  sweet: { drinkId: 'hedgehog-raf', note: 'Сливки, фундук и кленовый сироп. Когда хочется, чтобы чашка была ещё и маленьким десертом.' },
  fresh: { drinkId: 'iced-latte', note: 'Молоко, эспрессо и лёд. Прохлада, которую приятно взять с собой на прогулку.' }
} as const;
export type Taste = keyof typeof tastes;
export const gallery = [
  { src: '/images/cafe-interior.webp', alt: 'Солнечный зал с деревянными столами и мягким диваном', caption: 'Место для тёплых встреч · 1 / 3' },
  { src: '/images/cappuccino.webp', alt: 'Чашка капучино с рисунком сердца на молочной пене', caption: 'С любовью, в каждой чашке · 2 / 3' },
  { src: '/images/iced-latte.webp', alt: 'Холодный латте с кубиками льда', caption: 'Прохлада для вашего дня · 3 / 3' }
];
