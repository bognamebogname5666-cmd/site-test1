# Графические материалы

Все изображения подготовлены встроенным ImageGen. Стакан и фотографии — отдельные ресурсы; заголовки, навигация, кнопки, карточки и формы реализованы в HTML/CSS. Скриншот сайта не используется как фон интерфейса. Изображения иллюстрируют вымышленный бренд и не являются фотографиями действующего заведения.

## Результаты

- `public/images/coffee-hero.webp`: изолированный стакан с кофейным всплеском, прозрачный фон; исходник `source-assets/coffee-hero.png`.
- `public/images/cafe-interior.webp`: интерьер; исходник `source-assets/cafe-interior.png`.
- `public/images/cappuccino.webp`, `glace.webp`, `iced-latte.webp`: три равные панели из исходного `source-assets/drinks-source.png`, нарезанные и оптимизированные в WebP.
- `design-concept.png`: вспомогательное направление для остальных секций; при отличиях первого экрана приоритет у пользовательского референса `reference.png`.

Техническая обработка: Sharp, изменение размеров, выделение равных панелей контактного листа и WebP-сжатие. Alpha стакана сохранена.

## Финальные промпты

### Стакан

Use case: product-mockup. Create a premium photorealistic isolated cutout image asset for a Russian coffee shop website inspired by the user reference. One large tall cream kraft takeaway coffee cup, without lid, tilted 12 degrees clockwise, perspective showing rim. Dark espresso and caramel coffee dramatically splashing upwards out of cup in an elegant sculptural arc, several scattered glossy roasted coffee beans around it. Central cup occupies bottom 70%, splash occupies top 30%. Cup has dark brown printed Cyrillic branding exactly "СЕМЕЙНЫЙ ЁЖ" in two lines and a charming tiny hand-illustrated hedgehog beneath the branding. Natural paper texture, exquisite studio product photography, warm lighting, rich brown coffee, realistic fluid simulation. Isolated on genuinely transparent background, no background, no ground plane, no rectangular shadow, no UI, no website text, no frame. Asset needs to layer over a huge HTML heading. Entire cup and all splash must fit in frame with margins. 1024x1536 portrait.

### Интерьер

Use case: photorealistic-natural. Website image asset. A premium editorial photograph of a cozy small modern Moscow neighborhood coffee shop interior. Warm walnut wood tables, caramel cognac leather bench seating, cream limewashed walls, dark espresso machine counter on left, arched window pouring warm morning sun from right, a small green plant, two simple wooden chairs, fresh coffee cups on tables. No people, no signs, no text, no logos. Beautiful magazine photography, authentic cozy intimate atmosphere, rich warm brown palette, natural material texture, soft contrast, analog film feeling, restrained elegance, 3:2 wide landscape composition. The space should look welcoming and lived in, not a luxury hotel or massive restaurant.

### Напитки

Use case: product-mockup. A clean photographic contact sheet of THREE equal square panels laid out horizontally, 3:1 wide aspect ratio, each panel fills exactly one third of the whole image and is an independent premium coffee photograph. No borders, no gaps, no text. LEFT third: a ceramic speckled cream cup and saucer of cappuccino with beautiful heart latte art, sitting on a warm walnut cafe table, soft morning sunlight. CENTER third: a tall faceted transparent glass with dark espresso and scoop of vanilla ice cream, glistening chocolate drizzle, warm dark brown cafe background. RIGHT third: tall transparent iced latte glass, lots of ice, beautiful swirls of coffee and milk, espresso and cream colors, on warm wooden table with brown blurred background. Luxurious editorial food photography, natural realistic materials, all three subjects entirely inside their own thirds, central framing within each panel. Keep backgrounds warm and harmonious with caramel beige website. No words, no logos, no UI, no people. 3 equal square photographs, triptych 3:1.

### Концепт страницы

Use case: ui-mockup. Design concept screenshot for a Russian coffee shop landing page "СЕМЕЙНЫЙ ЁЖ". Create one complete vertically arranged desktop webpage at 1440px wide proportions, about 2200px tall: 1) hero 750px tall in warm caramel beige with giant dark brown "КОФЕ" spanning width behind centrally tilted cream takeaway coffee cup branded with a hedgehog and espresso splash, small pretitle "зайдите за", small right side text "Уютная кофейня для медленного утра и вкусного кофе", compact cream navigation bar with logo left, "Меню", "Атмосфера", "В гости", and dark booking button right. Bottom hero three compact horizontal coffee drink cards with photos and names "Капучино", "Кофе гляссе", "Айс-латте". 2) Cream atmosphere section with editorial serif headline "Место, где можно не спешить" and a wide warm photo of cozy cafe interior and a second photo of latte on a table. 3) Dark chocolate brown booking section with left headline "Оставим для вас уютное место" and cream reservation form right, fields name phone date time guests consent. 4) Cream location and footer section "Заглядывайте в гости", address Moscow Pokrovka 27 and map right. Elegant premium restraint, high contrast, Cyrillic typography, no pills, no random badges, no fake testimonials or stats. Reference direction: big bold geometric coffee letters, beige caramel warmth, chocolate accents, sophisticated coffee editorial. Practical HTML/CSS layout. All UI to be implemented code native, isolated cup image asset. Entire page visible, generous whitespace, readable UI controls.

## Доработка 21 октября 2026

`public/images/hedgehog.svg` — новая иллюстрация в SVG, нарисованная средствами кода для логотипа и блока «Ёж советует». Тёплая бумажная палитра, чашка и округлый характер согласованы с персонажем на стакане. В этой доработке новые растровые изображения не генерировались. Основной стакан и фотографии повторно использованы из существующих материалов выше; у дополнительных рецептов нет подменяющих фотографий.

## Адаптивные размеры 28 октября 2026

Добавлены механически уменьшенные WebP-копии существующих изображений без кадрирования и изменения композиции:

- `coffee-hero-320.webp`, `coffee-hero-480.webp`, `coffee-hero-640.webp` — ширина 320/480/640 px; прозрачность стакана сохранена.
- `cappuccino-192.webp`, `cappuccino-320.webp`, `cappuccino-480.webp` и такие же варианты `glace`/`iced-latte` — ширина 192/320/480 px.
- `cafe-interior-480.webp`, `cafe-interior-960.webp` — ширина 480/960 px.

Оригинальные WebP сохранены как самые крупные кандидаты и fallback. Обработка: Sharp, пропорциональный resize без увеличения, WebP quality 84, alphaQuality 100. Ни повторная генерация изображений, ни новые продуктовые зависимости не использовались. Набор доступных размеров описан в `shared/responsive-images.mjs`; неизвестные новые изображения каталога используют свой исходный URL без вымышленных вариантов. Для новых исходников варианты нужно сначала создать, затем добавить в этот список.
