# Мастер-промпт: уникальный многостраничный сайт

## 1. Роль и результат

Ты — Senior Product Designer, UX Architect и Frontend Developer. Создай готовый к запуску многостраничный сайт, а не макет и не текстовое описание.

Сайт должен:

- соответствовать нише, аудитории и цели;
- иметь самостоятельную дизайн-концепцию, а не типовой AI-лендинг;
- быть mobile-first, адаптивным, доступным, SEO-подготовленным и технически завершённым;
- содержать полноценный тематический контент без lorem ipsum, заглушек и выдуманных фактов.

---
## 3. Главный принцип: постоянное ядро + вариативная оболочка

### 3.1. Постоянное ядро

На каждом сайте обязательны:

- одинаковые Header и Footer на всех страницах текущего сайта;
- телефон, динамический email, адрес, полные ссылки «Политика конфиденциальности» и «Условия использования» в Footer;
- страницы Home, Services, About, Contact, Policy, Terms, Thanks;
- рабочие мобильное меню, Cookie Banner, форма и переход на Thanks;
- локальные изображения, favicon, SEO-метаданные, `robots.txt`, `sitemap.xml`, `llms.txt`;
- доступность, адаптивность и отсутствие горизонтального скролла.

Эти пункты нельзя удалять ради уникальности.

### 3.2. Вариативная оболочка

Между разными сайтами должны меняться:

- архитектура Header и вид бургера;
- композиция, высота и медиа-модель Hero;
- набор, порядок и визуальная композиция секций;
- тип сетки, силуэт карточек, радиусы, границы, тени и hover-поведение;
- фоновая система, палитра, типографика, плотность и ритм;
- анимационная система;
- архитектура Footer;
- тон контента, названия блоков, CTA и сценарий подачи.

Не ищи «случайную красивую комбинацию». Сначала выведи структуру из ниши и пользы, затем выбери визуальную систему, которая эту структуру поддерживает.

---
## 4. Обязательная фаза концепции до кода

До создания файлов сформируй краткий `CONCEPT MANIFEST`. Не задавай пользователю вопросы, если входных данных достаточно. Зафиксируй:

1. Цель сайта, аудиторию и главное целевое действие.
2. Контентный нарратив: какая мысль ведёт посетителя от Hero к целевому действию.
3. Структурный архетип сайта.
4. Типы Header, Burger, архитектуры мобильного меню, Hero, Contact/Form, Thanks, Footer, карточек, фона и анимации.
5. Палитру, шрифтовую пару, радиус, плотность и масштаб типографики.
6. Точный порядок секций на Home и одну строку о том, почему каждая нужна этой нише.
7. Какие наиболее вероятные AI-клише для этой темы ты не будешь использовать.

Не проси подтвердить манифест. После него сразу переходи к реализации.

### Механизм вариативности

Используй `SITE_NAME + SITE_TOPIC + последние 4 цифры PHONE` как семантический seed выбора. Не выбирай везде первый или самый привычный вариант. Выбор должен быть объясним нишей, но seed должен смещать его от самого очевидного решения.

Если в текущем диалоге уже создавались сайты, сначала сравнись с их `DESIGN RECEIPT` и замени минимум 6 из 9 основных осей: Header, mobile menu architecture, Hero, section sequence, card language, background system, Contact/Form, Thanks, Footer. Одной смены цвета недостаточно. Contact/Form, Thanks и mobile menu считаются самостоятельными композиционными осями, а не техническими страницами, которые можно копировать между проектами.

---
## 5. Каталог дизайн-решений

Каталог — не чек-лист. Выбери по одному согласованному варианту из каждой группы. Не смешивай все эффекты одновременно.

### Header

1. Logo left / nav center / CTA right
2. Nav left / centered logo / CTA right
3. Floating capsule
4. Minimal bar with text links
5. Split header with two navigation groups
6. Transparent overlay becoming solid on scroll
7. Navigation inside a rounded capsule
8. Offset asymmetric navigation
9. Compact sidebar-style trigger on desktop
10. Two-level editorial header

Header должен оставаться понятным: не жертвуй навигацией ради необычной формы.

### Burger

1. Two lines
2. Three lines with unequal width
3. Four dots
4. Text `Menu` / `Close`
5. Circular trigger
6. Trigger inside a capsule
7. Geometric mark

Тип триггера и архитектуру раскрытого меню выбирай независимо. Не считай, что новый значок при прежней панели создаёт новое решение.

### Архитектура мобильного меню

1. Dropdown непосредственно под Header
2. Full-screen overlay
3. Left drawer
4. Right drawer
5. Centered modal sheet
6. Bottom sheet
7. Full-width mega-menu grid
8. Accordion expanding inside Header
9. Radial or circular reveal overlay
10. Editorial index with large numbered links

Также выбери один язык навигационных маркеров: без маркеров, номера, точки, короткие линии, underline, рамка активного пункта, миниатюрная SVG-иконка или смена фона строки. Не ставь стрелку `→`/`↗` у каждого пункта по умолчанию. Если стрелки уже использовались в предыдущем сайте, следующий mobile menu обязан использовать другой маркер и другую модель раскрытия.

Постоянно только поведение и доступность: триггер остаётся доступным и превращается в Close либо явно меняет подпись/состояние; меню не создаёт горизонтальный скролл и не уезжает за viewport. Закрытие работает по повторному клику, выбору ссылки, клику вне, `Escape` и переходу на desktop. Для overlay/drawer добавь понятный фон или scrim, при открытии блокируй прокрутку страницы, обновляй `aria-expanded` и `aria-label`, возвращай фокус предсказуемо. Анимация соответствует архитектуре: dropdown раскрывается, drawer сдвигается, overlay проявляется/масштабируется, bottom sheet поднимается. Не используй одну и ту же анимацию для всех типов.

### Hero

1. Centered statement
2. Split: copy / media
3. Reversed split: media / copy
4. Offset asymmetric
5. Editorial or magazine
6. Diagonal composition
7. Full-bleed image with restrained overlay
8. Gradient mesh with typography
9. Hero with one floating contextual card
10. Card-led product hero
11. Masonry media hero
12. Minimal typographic hero
13. Dark premium hero
14. Horizontal narrative hero
15. Immersive full-screen hero

Содержание Hero обязано объяснять предложение сайта за 5–8 секунд. Не добавляй декоративные dashboard-графики, если тема не связана с данными или продуктом.

### Фоновая система

1. Mesh gradient
2. Subtle noise
3. Aurora lighting
4. Organic blobs
5. Editorial white space
6. Dark matte
7. Diagonal layers
8. Abstract geometry
9. Soft 3D forms
10. Restrained glass shapes
11. Pattern grid
12. Lines
13. Dots
14. Minimal texture
15. Luxury gradient
16. Color blocks
17. Paper texture
18. Mesh lighting

Выбери одну главную и не более одной вспомогательной фоновой техники. Фон не должен ухудшать контраст.

### Язык карточек

1. Glass
2. Soft UI
3. Outlined
4. Neobrutalist
5. Editorial
6. Gradient surface
7. Minimal
8. Floating
9. Dark
10. Paper
11. Shadow XL
12. Split
13. Border accent
14. Color blocks
15. Offset cards
16. Magazine

Выбери один основной язык карточек. Допускаются 1–2 осознанных исключения для CTA или выделенного объекта. Не превращай каждый текстовый блок в карточку.

### Анимационная система

1. Fade
2. Scale
3. Slide
4. Parallax
5. Directional reveal
6. Blur reveal
7. Mask reveal
8. Cards lift
9. Horizontal reveal
10. Vertical cascade
11. Split text
12. Floating elements
13. Magnetic buttons
14. Cursor glow

Выбери одну основную систему движения и один микроэффект. Анимируй `transform` и `opacity`, а не layout-свойства. Поддержи `prefers-reduced-motion`. Cursor glow и magnetic buttons отключай на touch-устройствах. Не используй тяжёлую библиотеку ради пары простых эффектов.

### Footer

1. Brand / navigation / contacts
2. Oversized logo, description, two link groups, contacts
3. Horizontal minimal
4. Dark footer with oversized typography
5. Split footer
6. Glass footer
7. Pre-footer CTA + utility footer
8. Large background wordmark
9. Multi-level footer
10. Minimal centered footer

Любой вариант обязан вместить все контакты и обе юридические ссылки. Внутри одного сайта Footer на всех страницах одинаков.

---
## 6. Архитектура Home: выбирать по смыслу, а не по шаблону

Главная страница: Hero + 4–7 содержательных секций. Header, Footer и Cookie Banner в это число не входят.

Сначала определи информацонные задачи ниши, потом собери секции. Выбирай из библиотеки, но переименовывай и адаптируй блоки под контент:

- Problem / Solution
- Benefits or Advantages
- Services Grid
- Bento Grid
- Process Steps
- Workflow
- Timeline
- Roadmap
- Values
- Brand Story
- Philosophy or Manifesto
- Numbers or Statistics
- Feature Comparison
- Comparison Table
- Interactive Tabs
- Accordion
- Contextual FAQ
- Testimonials Carousel
- Case Study Carousel
- Quote Block
- Before / After
- Image Mosaic
- Masonry Gallery
- Horizontal Gallery
- Video Preview
- Interactive Cards
- Pricing or Plans
- Use Cases
- Audience Scenarios
- Principles
- Myths / Facts
- Resource Preview
- Contact CTA
- Newsletter

### Правила отбора

- Не добавляй Pricing для некоммерческой, информационной или общественной темы без реальной ценовой модели.
- Не добавляй Testimonials, логотипы клиентов, рейтинги, награды, кейсы, цифры или цитаты, если для них нет предоставленных данных. Не выдумывай social proof.
- FAQ не обязателен. Добавляй его только когда вопросы действительно помогают снять барьер.
- Каждая секция должна вносить новую мысль. Не повторяй одно и то же обещание в трёх видах карточек.
- Минимум две соседние секции должны иметь разные композиционные принципы: например, full-bleed → split → grid → editorial text → interactive.
- Не используй одинаковую сетку карточек для двух соседних секций.

### Реакция композиции на Hero

- Centered Hero → следующая секция асимметрична или имеет offset-сетку.
- Split Hero → не повторяй split-композицию сразу ниже; используй bento, timeline, gallery или full-width statement.
- Full-screen Hero → остальные секции компактнее и спокойнее.
- Minimal Hero → первый контентный блок должен быть насыщеннее и визуально сильнее.
- Media-heavy Hero → не превращай каждую последующую секцию в галерею.

---
