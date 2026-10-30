const widthsBySource = {
  '/images/coffee-hero.webp': [320, 480, 640, 800],
  '/images/cappuccino.webp': [192, 320, 480, 640],
  '/images/glace.webp': [192, 320, 480, 640],
  '/images/iced-latte.webp': [192, 320, 480, 640],
  '/images/cafe-interior.webp': [480, 960, 1440]
};

/** Unknown catalog images keep their original URL without invented variants.
 * @param {string} source
 * @param {string} sizes The image's rendered CSS width at each breakpoint.
 */
export function responsiveImage(source, sizes) {
  const widths = Object.hasOwn(widthsBySource, source) ? widthsBySource[source] : undefined;
  if (!widths) return { src: source, srcset: '', sizes: '' };
  const originalWidth = widths.at(-1);
  const srcset = widths.map(width => `${width === originalWidth ? source : source.replace(/\.webp$/, `-${width}.webp`)} ${width}w`).join(', ');
  return { src: source, srcset, sizes };
}
