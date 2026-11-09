/**
 * shared — единые контракты UI ⇄ сайдкар ⇄ оркестратор.
 * Всё, что пишет/читает диск и ходит по SSE, типизировано здесь.
 */

// ─── Подключения моделей ────────────────────────────────────────────────
export type ModelKind = "llm" | "image";
/**
 * Протоколы картинки/текста. "imagening" — свой: POST /api/v1/generations,
 * поллинг /api/v1/generations/{id}, файл по outputs[].file с тем же Bearer.
 */
export type Protocol = "openai-chat" | "task-poll" | "imagening" | "custom";

export interface ConnectionAuth {
  mode: "env" | "local";
  /** env: имя переменной (BUILDER_*); local: значение хранится локально в settings */
  ref: string;
}

export type LimitMode =
  | { mode: "api"; endpoint?: string; unit?: "credits" | "units" }
  | { mode: "manual"; unlimited?: boolean }
  | { mode: "unknown" };

export interface ModelEntry {
  id: string;
  label?: string;
  /** цена за 1M токенов [prompt, completion] — для llm */
  pricePerMTokens?: [number, number];
  /** цена за картинку — для image */
  pricePerImage?: number;
  contextWindow?: number;
}

export interface Connection {
  id: string;
  name: string;
  /** провайдер определился по факту подключения (хост + ответы API), а не вписан руками */
  provider?: string;
  kind: ModelKind;
  baseUrl: string;
  protocol: Protocol;
  auth: ConnectionAuth;
  models: ModelEntry[];
  /** определение vision делается проверкой, не галочкой юзера (SPEC §4) */
  vision?: boolean;
  limit: LimitMode;
  enabled: boolean;
  priority: number;
}

export interface LimitBadge {
  connectionId: string;
  state: "ok" | "low" | "empty" | "unlimited" | "unknown";
  /** проценты 0..100, если известны */
  percent?: number;
  /** человекочитаемый остаток: "62% · ≈$3.10", "3 200 / 10 000" */
  display: string;
  updatedAt: string; // ISO
  /** локальная оценка расхода из run.jsonl */
  spentEstimate?: string;
  /** баланс таков, что платные модели не работают (бесплатные — работают):
      OpenRouter при total_credits = 0 отвечает 402 на платные и 200 на :free */
  paidBlocked?: boolean;
}

// ─── Selection (два селекта UI) ─────────────────────────────────────────
export interface Selection {
  codeCopy: { connection: string; model: string | null };
  image: { connection: string; model: string | null };
  /** дефолтные подключения назначений — те, с которых юзер ушёл на другое
      (наш qwen). Хранятся, чтобы в окно возвращаться одной пилюлей, а не
      вставлять ключ заново; ставятся один раз при первом запуске */
  defaults?: { codeCopy: { connection: string; model: string | null }; image: { connection: string; model: string | null } };
  /** api — генерация; none — чистый CSS/SVG; manual — свои фото по slug из плана */
  imageMode: "api" | "none" | "manual";
}

// ─── Brief ──────────────────────────────────────────────────────────────
export type Mode = "white" | "black";

export interface BriefCommon {
  mode: Mode;
  language: string; // "ru" | "en" | ...
  brand: string;
  audience: string;
  ctaPrimary: string;
  tone: string;
  sections: SectionSpec[];
  /**
   * Свободное пожелание юзера («кнопки круглые»): попадает в hardRules ПЕРЕД
   * константами серии и прямо в промпт плана — модель обязана выполнить его,
   * если оно не противоречит контрактам. Это способ не перегенерировать проект.
   */
  wishes: string;
  /**
   * Куда выложить готовый проект после генерации. Без поля — настройка
   * settings.delivery (по умолчанию «в генераторе»). `path` — для "folder"/
   * "custom": любая папка этой машины, принимает и Windows-путь (C:\...), и путь
   * любой другой ОС; рядом кладётся zip, дальше юзер сам переносит результат
   * на свой сервер.
   */
  delivery?: { kind: "here" | "desktop" | "folder" | "custom"; path?: string; zip?: boolean };
}

export interface SectionSpec {
  type: string; // hero|benefits|how|gallery|proof|pricing|faq|cta|footer|...
  enabled: boolean;
  order: number;
  title?: string;
}

/** Тематика white-лендинга — подсказка плану и арт-дирекции. */
export type WhiteTheme =
  | "realty"
  | "restaurant"
  | "events"
  | "model-agency"
  | "services"
  | "medical"
  | "education"
  | "other";

/** Анимаация hero-секции лендинга. */
export type HeroMotion = "video" | "static";

/**
 * Геометрия hero: `full` — на всю ширину окна, текст и картинка у краёв;
 * `container` — содержимое в общем контейнере страницы (`--maxw`), как у
 * остальных секций. Поле выбора, а не украшение: full меняет ритм первого
 * экрана, поэтому усадку в контейнер нужно просить явно.
 */
export type HeroWidth = "full" | "container";

/** Пара цветов по цветовому кругу — юзер тыкает пару, а не подбирает hex вслепую. */
export interface ColorPair {
  /** схема гармонии: complement | analogous | triad | split */
  scheme: "complement" | "analogous" | "triad" | "split";
  bg: string;
  accent: string;
  label?: string;
}

export interface WhiteBrief extends BriefCommon {
  mode: "white";
  city: string;
  niche: string;
  /** заголовок/подзаголовок придумывает модель (plan/copy) по тематике и офферу;
   * поле юзера осталось опциональным — только чтобы задавить заглушку */
  headline?: string;
  subheadline?: string;
  palette: { bg: string; accent: string };
  /** пара из цветового круга, из которой взята palette (для UI-подсказки) */
  colorPair?: ColorPair;
  avatarType?: string;
  phone?: string;
  address?: string;
  email?: string;
  php: boolean; // отдавать index.php + site.config.json
  /** сколько страниц: 1 — одностраничник; 4–6 — структура whites (SPEC §5) */
  pageCount?: 1 | 2 | 3 | 4 | 5 | 6;
  /** гео/язык: "ru-RU", "ru-KZ", "en-US"… */
  locale?: string;
  theme?: WhiteTheme;
  heroMotion?: HeroMotion;
  /** геометрия первого экрана: на всю ширину или в контейнере страницы */
  heroWidth?: HeroWidth;
}

export interface BlackBrief extends BriefCommon {
  mode: "black";
  /** красный оттенок — валидируется на несовпадение с последним рядом реестра */
  redHex: string;
  typeAvatar: string;
  offer: string;
  captions: string[];
  hasVideo: boolean;
  /** series-константы (black_NNN, assets-black, трек-клик…) — не поля юзера */
  folderNumber?: number;
}

export type Brief = WhiteBrief | BlackBrief;

// ─── SitePlan: контракт имён и секций (создаётся до кода и картинок) ───
export interface PlanImage {
  slug: string; // = имя файла в assets/img (контракт!)
  description: string; // промпт-описание для image-подключения
  aspect: "16:9" | "3:4" | "1:1" | "9:16" | "4:3";
  role: "hero" | "content" | "avatar" | "background";
  /** для многостраничника: slug вложенной страницы-владельца; пусто = главная */
  page?: string;
}

export interface PlanSection {
  type: string;
  heading: string; // будущий H2
  slug: string;
  notes?: string;
}

/** Вложенная страница многостраничника (pageCount > 1): index здесь не хранится. */
export interface PlanPage {
  slug: string; // = имя файла <slug>.html (контракт, как у картинок)
  heading: string; // будущий H1 страницы
  sections: PlanSection[];
}

export interface SitePlan {
  version: number;
  briefHash: string;
  /** хэш пересчитывается при любой правке в gate (SPEC §10) */
  planHash: string;
  /** секции главной страницы (index.html) */
  sections: PlanSection[];
  palette: Record<string, string>; // { bg, accent, red?, text? }
  fonts: { heading: string; body: string };
  /** картинки главной страницы */
  images: PlanImage[];
  /** вложенные страницы; пусто/отсутствует = одностраничник */
  pages?: PlanPage[];
  copyFormula?: string;
  hardRules: string[]; // constraints из brief + константы серии
}

// ─── Артефакты и манифест прогона ──────────────────────────────────────
export interface ImageArtifact {
  slug: string;
  file?: string; // rel path, если получена
  status: "pending" | "done" | "placeholder" | "failed" | "manual";
  connectionId?: string;
  error?: string;
}

export interface RunManifest {
  projectId: string;
  mode: Mode;
  status: RunStatus;
  /** картинка недоступна (нет модели/ключа) — прогон идёт с плейсхолдерами */
  imagesDegraded?: boolean;
  /** почему графика деградировала — человекочитаемо, для плашки в UI */
  notes?: string;
  createdAt: string;
  finishedAt?: string;
  images: ImageArtifact[];
  /** смета из gate, для сверки с фактом */
  estimate?: { images: number; tokens: number; usd: number; minutes?: number };
  defects: Defect[];
}

export type RunStatus =
  | "draft"
  | "planning"
  | "awaiting-gate"
  | "running"
  | "paused"
  | "needs_human"
  /** сборка готова: человек смотрит сайт на локальном сервере и решает —
   * править (human-fix), принимать без выгрузки (accept) или выгружать (deliver) */
  | "review"
  | "done"
  | "cancelled"
  | "failed";

export interface Defect {
  id: string;
  task: string; // task id из DAG
  severity: "critical" | "major" | "minor" | "info";
  message: string;
  selector?: string;
  fixed?: boolean;
}

/** Вердикт vision-проверки (preview/verdict-rN.json). */
export interface Verdict {
  critical: number;
  defects: Defect[];
  summary?: string;
}

/** Машинные проверки браузера (preview/checks-rN.json) — без них judge слепой. */
export interface ChecksResult {
  round: number;
  /** console.error/warning, собранные при загрузке */
  consoleErrors: string[];
  /** горизонтальный переполнение на брейкпоинте */
  overflow: string[];
  /** пустые/схлопнувшиеся блоки */
  emptyBlocks: string[];
  /** отсутствующие контент-анкоры: cta|price|phone|… */
  missingAnchors: string[];
  /** битые внутренние ссылки */
  brokenHrefs: string[];
  /** <img src="...">, которого нет на диске */
  brokenImgs: string[];
  /** текст, залитый в фон: тёмное на тёмном / светлое на светлом (включая фото-фоны) */
  lowContrast: string[];
  screenshots: Array<{ breakpoint: number; file: string }>;
  /** vision недоступен → detector-only, честно в отчёте */
  visionUsed: boolean;
  /** что проверялось и что сознательно не проверялось (нет цены в Brief и т.п.) */
  note?: string;
}

// ─── События оркестратора (SSE + журнал run.jsonl) ─────────────────────
export type OrchEvent =
  | { t: "run.state"; state: RunStatus; at: string }
  | { t: "task.start"; task: string; at: string }
  | { t: "task.done"; task: string; at: string; cached?: boolean; usage?: TokenUsage }
  | { t: "task.error"; task: string; at: string; klass: ErrorClass; message: string }
  | { t: "task.skip"; task: string; at: string; reason: string }
  | { t: "image.slot"; slug: string; at: string; result: ImageArtifact["status"] }
  | { t: "gate.open"; gate: "plan"; plan: SitePlan; estimate: RunManifest["estimate"] }
  | { t: "gate.close"; gate: "plan"; edited: boolean; at: string }
  | { t: "fix.round"; round: number; at: string; defectsFixed: number }
  | { t: "limit.hit"; connectionId: string; at: string; fellBackTo?: string }
  /** сеть машины: false → транспортные ретраи и шторм объясняются сами собой */
  | { t: "net.state"; online: boolean; at: string; detail?: string }
  /** проект выложен за пределы мастерской: путь + zip (если собирался) */
  | { t: "export.place"; at: string; path: string; zip?: string | null; error?: string }
  /** ревью перерисовать: вход в review, итог human-раунда или ошибка раунда */
  | { t: "review.update"; at: string; note?: string; error?: string }
  /** раунд правки человека с разбивкой по пунктам: сколько заказано, сколько
   * реально сделано — «список сделан весь» должно быть видно, а не угадываться */
  | {
      t: "review.fix";
      at: string;
      requested: number;
      applied: number;
      items: Array<{ text: string; done: boolean; note?: string }>;
    }
  | { t: "command"; cmd: RunCommand; at: string; detail?: string };

export interface TokenUsage {
  prompt: number;
  completion: number;
  usdEstimate?: number;
}

export type ErrorClass = "transport" | "contract" | "quota" | "fatal";

export type RunCommand =
  | "start"
  | "pause"
  | "resume"
  | "cancel"
  /** выход из шлюза в бриф: прогон сворачивается, папка проекта удаляется */
  | "back"
  | "skip-gate"
  | "regen-plan"
  | "retry-task"
  | "regen-images"
  /** ревью: принять сборку без выгрузки (done) */
  | "accept"
  /** ревью: выгрузить в выбранную папку (export.place) и завершить (done) */
  | "deliver"
  /** ревью: текстовая правка человека → фикс-патч → пересборка → съёмка */
  | "human-fix"
  | "fork";
