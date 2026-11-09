/**
 * Панель брифа: набор полей под выбранный режим (white | black).
 * Оба брифа живут в одном state — переключение таба не теряет введённое.
 * Типы берём из @builder/shared: то, что отправляем, и то, что ждёт сайдкар, — одно.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Brief,
  HeroWidth,
  Mode,
  RunManifest,
  SectionSpec,
  SitePlan,
  WhiteTheme,
} from "@builder/shared";
import { api, type DestInfo } from "./api";
import GateCard from "./gate-card";
import ReviewCard from "./review-card";
import Hint from "./hint";

const THEMES: Array<{ v: WhiteTheme; t: string }> = [
  { v: "realty", t: "недвижимость" },
  { v: "restaurant", t: "ресторан" },
  { v: "events", t: "ивенты" },
  { v: "model-agency", t: "модельное агентство" },
  { v: "services", t: "услуги" },
  { v: "medical", t: "медицина" },
  { v: "education", t: "образование" },
  { v: "other", t: "другое" },
];

/**
 * Язык — три варианта, не список регионов: модель пишет текст по языку, а
 * регион в лендинге не меняет ни пунктуации, ни лексики (город и так отдельное
 * поле). Третий — турецкий: частый рынок наших сборок и без RTL, в отличие от
 * арабского. Подпись — на языке самой локали: юзер узнаёт свой.
 */
const LOCALES: Array<{ v: string; t: string }> = [
  { v: "en", t: "English" },
  { v: "ru", t: "Русский" },
  { v: "tr", t: "Türkçe" },
];

/**
 * Геометрия hero — выбор юзера, а не вкусовщина модели. `container` значение
 * по умолчанию: так собраны текущие white (контент hero в том же .container,
 * что и остальные секции), поэтому дефолт ничего в серии не меняет.
 */
const HERO_WIDTHS: Array<{ v: HeroWidth; t: string; hint: string }> = [
  { v: "full", t: "на всю ширину", hint: "Текст и картинка идут у краёв окна — первый экран крупнее" },
  { v: "container", t: "в контейнере", hint: "Hero в той же колонке, что и остальные секции" },
];

const SECTION_CATALOG = [
  "hero",
  "benefits",
  "how",
  "gallery",
  "proof",
  "pricing",
  "faq",
  "cta",
  "footer",
];

/**
 * Разделение каталога для многостраничника (pageCount > 1): каркас главной
 * (hero/footer зафиксированы — без них страница не страница), остальное юзер
 * выбирает. pricing/faq — «тонкие» блоки: на главной они лишь намёк, а при
 * многостраничнике модель делает из них отдельные страницы (правило в seriesRules).
 */
const SPINE = ["hero", "cta", "footer"];
const MAIN_ONLY = ["benefits", "how", "gallery", "proof"];
const PAGE_WORTHY = ["pricing", "faq"];

/**
 * Пары с цветового круга: юзер тыкает пару, а не подбирает hex вслепую (SPEC §5).
 * Светлые — для white, тёмные — для black; `-` в конце имени none для custom.
 */
const COLOR_PAIRS: Array<{ scheme: string; label: string; bg: string; accent: string }> = [
  { scheme: "complement", label: "айвори + индиго", bg: "#F7F4EE", accent: "#2F49D6" },
  { scheme: "analogous", label: "тёплая терракота", bg: "#FBF6F1", accent: "#C6613A" },
  { scheme: "complement", label: "слоновая кость + хвоя", bg: "#F2EFE9", accent: "#1F4B39" },
  { scheme: "triad", label: "пергамент + бордо", bg: "#FAF6EC", accent: "#7C2230" },
  { scheme: "split", label: "песок + ультрамарин", bg: "#FAF6EC", accent: "#2653C9" },
  { scheme: "analogous", label: "морская волна", bg: "#F1F7F6", accent: "#0E7C6B" },
  { scheme: "triad", label: "мята + коралл", bg: "#F2F7F4", accent: "#E4665C" },
  { scheme: "split", label: "лимон + графит", bg: "#FBF9F2", accent: "#2B2B2F" },
  { scheme: "complement", label: "бумага + шалфей", bg: "#F6F6F3", accent: "#6B8F71" },
  { scheme: "complement", label: "облако + алый", bg: "#F5F2F4", accent: "#E23648" },
  { scheme: "analogous", label: "лёд + бирюза", bg: "#EFF6F6", accent: "#0F8B7E" },
  { scheme: "triad", label: "ваниль + слива", bg: "#FBF6E9", accent: "#8A6A1F" },
  { scheme: "split", label: "туман + фиолет", bg: "#F3F1F8", accent: "#6A4BC7" },
  { scheme: "triad", label: "крем + роза", bg: "#F8F3F4", accent: "#C94F7C" },
  { scheme: "analogous", label: "тоффи + корица", bg: "#F8F2EA", accent: "#8C5A32" },
  { scheme: "split", label: "снег + аквамарин", bg: "#EFF6F9", accent: "#0A7EA4" },
  { scheme: "complement", label: "лён + олива", bg: "#F6F4E8", accent: "#77863B" },
];

/** индекс пары-заглушки: юзер сам тыкает два цвета (custom) */
const CUSTOM = -1;

/**
 * Выбор цвета как у всех: пипетка + поле кода. Ползунок точного номера не даёт,
 * поэтому код вводится руками: терпит #RGB и без #, применяет только валидный
 * hex, при выходе из поля недописанное откатывает к текущему цвету.
 */
/** Подпись над полем цвета в поповере своей пары («фон» / «акцент»). */
function HexField({
  label,
  caption,
  value,
  onCommit,
}: {
  label: string;
  caption?: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toUpperCase();
  // live=true (набор) — только полные 6digit: «#C66» на halfway — это не цвет.
  // live=false (Enter/blur) — принимаем и короткую форму #RGB, как в DevTools
  function commit(text: string, live: boolean) {
    const full = /^#?([\da-f]{6})$/i.exec(text.trim());
    const short = live ? null : /^#?([\da-f]{3})$/i.exec(text.trim());
    if (full) {
      onCommit("#" + full[1].toUpperCase());
      return true;
    }
    if (short) {
      onCommit("#" + short[1].split("").map((c) => c + c).join("").toUpperCase());
      return true;
    }
    return false;
  }
  return (
    <span className="hex-field">
      {caption && <i className="hex-cap">{caption}</i>}
      <span className="hex-row">
      <input
        type="color"
        aria-label={label + " — пипетка"}
        value={/^#[\da-f]{6}$/i.test(value) ? value : "#000000"}
        onChange={(e) => {
          setDraft(null);
          onCommit(e.target.value.toUpperCase());
        }}
      />
      <input
        className="mono"
        aria-label={label + " — код цвета"}
        spellCheck={false}
        maxLength={7}
        placeholder="#000000"
        value={shown}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          if (commit(t, true)) setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && commit((e.target as HTMLInputElement).value, false)) setDraft(null);
        }}
        onBlur={(e) => {
          commit(e.target.value, false);
          setDraft(null);
        }}
      />
      </span>
    </span>
  );
}

/**
 * Светлые тона палитры (#F7F4EE «айвори») на светлом фоне селектов выглядят
 * просто белыми: дельта до белого ~7%. Для квадратика-маркера поднимаем
 * насыщенность и чуть опускаем светлоту, тон (hue) остаётся честным —
 * «слоновая кость» читается слоновой костью, тёмные стороны не трогаем.
 */
function swatchTint(hex: string): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  // Подкручиваем ТОЛЬКО околобелые (l ≥ 0.86): «айвори» на светлом фоне без
  // этого = белый. Всё остальное — священный оригинал: тёмные тона любая
  // подкрутка сдвигает (чёрный с синькой становился коричневым/индиго),
  // а юзер выбирает цвет пипеткой и ожидает в квадратике ровно его
  if (l < 0.86) return hex;
  const d = max - min;
  if (d === 0) return hex; // чистый белый: подкручивать нечем (нет тона)
  let h = 0;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const [M, m2] = [max, min];
  if (M === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60;
  else if (M === G) h = ((B - R) / d + 2) * 60;
  else h = ((R - G) / d + 4) * 60;
  void m2;
  // светлые различаем пропорционально их исходной «цветности»: кто насыщеннее
  // по паспорту — тот в маркере насыщеннее и чуть темнее, порядок не теряется
  const s0 = d / (1 - Math.abs(2 * l - 1));
  const s1 = Math.min(0.55, 0.16 + s0 * 0.9);
  const l1 = 0.9 - s1 * 0.12;
  const c = (1 - Math.abs(2 * l1 - 1)) * s1;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = l1 - c / 2;
  const seg: [number, number, number] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, "0");
  return `#${to255(seg[0])}${to255(seg[1])}${to255(seg[2])}`.toUpperCase();
}

interface Draft {
  sections: string[];
  /** свободное пожелание («кнопки круглые»): идёт в промпт до вкуса модели */
  wishes: string;
  /** только black: надпись на кнопке клика; в white её пишет модель */
  ctaPrimary: string;
  // white
  theme: WhiteTheme;
  /** своя тематика, когда theme === "other" («рыбалка», «крафтовое пиво») */
  customTheme: string;
  locale: string;
  pairIndex: number;
  customBg: string;
  customAccent: string;
  city: string;
  pageCount: 1 | 2 | 3 | 4 | 5 | 6;
  heroMotion: "video" | "static";
  /** геометрия первого экрана: hero на всю ширину окна или в контейнере страницы */
  heroWidth: HeroWidth;
  php: boolean;
  /** куда выложить готовый проект (server /api/delivery сверяет доступность) */
  deliveryKind: DestInfo["kind"];
  deliveryPath: string;
  // black
  redHex: string;
  typeAvatar: string;
  offer: string;
  captions: string;
  hasVideo: boolean;
}

/**
 * Оба режима делят один объект Draft: часть полей white, часть black.
 * CTA, телефон и номер вайта полями юзера больше не являются: надпись на кнопке
 * и контакты берёт из тематики модель, а номер — сервер по счётчику папок,
 * поэтому запуск ничего не считает руками (SPEC §5).
 */
const BASE: Draft = {
  ctaPrimary: "",
  sections: [],
  wishes: "",
  theme: "services",
  customTheme: "",
  locale: "ru",
  pairIndex: 0,
  customBg: "#F5F2EC",
  customAccent: "#2F49D6",
  city: "",
  pageCount: 1,
  heroMotion: "static",
  heroWidth: "container",
  php: true,
  deliveryKind: "here",
  deliveryPath: "",
  redHex: "#E1122A",
  typeAvatar: "девушка 25+",
  offer: "",
  captions: "",
  hasVideo: true,
};

/**
 * Стартовый прототип конструктора = реальный собранный white (Dubai white_24,
 * Atelier Mirage). Прогон стартует не с пустых полей, а с настоящих параметров
 * собранного сайта: англ. локаль, 6 страниц структуры whites, палитра слоновой
 * кости с латунным акцентом, DIFC и телефон — то, что уже стоит в проде.
 * Тема — `realty`, а не `other`: первое, что видит юзер в первой строке
 * брифа, обязано называть конкретную тему, «другое» ничего не объясняет
 * (плюс при `other` без текста сервер подставляет «услуги» — постороный
 * текст в дефолтном прогоне).
 */
export const WHITE_PRESET: Draft = {
  ...BASE,
  sections: ["hero", "benefits", "how", "gallery", "proof", "pricing", "cta", "footer"],
  theme: "realty",
  locale: "en",
  pairIndex: 2,
  city: "Dubai",
  pageCount: 6,
  heroMotion: "static",
  php: true,
};

const DRAFTS: Record<Mode, Draft> = {
  white: { ...WHITE_PRESET },
  black: {
    ...BASE,
    ctaPrimary: "Смотреть далее",
    sections: ["hero", "gallery", "cta"],
    theme: "other",
    heroMotion: "video",
  },
};

/** Имя папки проекта: сайдкар принимает только [\w.-], поэтому транслит. */
function slug(input: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
    э: "e", ю: "yu", я: "ya",
  };
  const s = input
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return s || new Date().toISOString().slice(2, 10).replace(/-/g, "");
}

function toBrief(mode: Mode, d: Draft): Brief {
  const sections: SectionSpec[] = SECTION_CATALOG.map((type) => ({
    type,
    enabled: d.sections.includes(type),
    order: SECTION_CATALOG.indexOf(type),
  }));
  const common = {
    // язык = локаль: регионы упразднены, модель пишет по языку
    language: d.locale,
    brand: d.city.trim() || "Без бренда",
    audience: "",
    // ctaPrimary и phone пустые: надпись на кнопке и контакты модель берёт из
    // тематики/города (правится в шлюзе плана, а не в брифе)
    ctaPrimary: mode === "black" ? d.ctaPrimary.trim() : "",
    tone: "",
    sections,
    wishes: d.wishes.trim(),
  };
  if (mode === "white") {
    const preset = COLOR_PAIRS[d.pairIndex];
    const pair =
      d.pairIndex === CUSTOM
        ? { scheme: "complement", label: "своя пара", bg: d.customBg, accent: d.customAccent }
        : preset;
    return {
      ...common,
      mode: "white",
      city: d.city.trim(),
      niche:
        d.theme === "other" && d.customTheme.trim()
          ? d.customTheme.trim()
          : THEMES.find((t) => t.v === d.theme)?.t ?? d.theme,
      // заголовок и подзаголовок придумывает модель: в брифе их больше нет
      palette: { bg: pair.bg, accent: pair.accent },
      colorPair: { scheme: pair.scheme as never, bg: pair.bg, accent: pair.accent, label: pair.label },
      php: d.php,
      pageCount: d.pageCount,
      locale: d.locale,
      theme: d.theme,
      heroMotion: d.heroMotion,
      heroWidth: d.heroWidth,
      delivery: { kind: d.deliveryKind, path: d.deliveryPath.trim() || undefined },
    };
  }
  return {
    ...common,
    mode: "black",
    redHex: d.redHex.trim(),
    typeAvatar: d.typeAvatar.trim(),
    offer: d.offer.trim(),
    captions: d.captions
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    hasVideo: d.hasVideo,
  };
}

/** Что обязаны заполнить, чтобы прогон имел смысл (SPEC §2.2 — «обязательных полей 4»). */
function missing(mode: Mode, d: Draft): string[] {
  return Object.values(missingKeys(mode, d));
}

/** Те же требования ключами полей — чтобы подпись и ошибка поля красились точечно. */
function missingKeys(mode: Mode, d: Draft): Record<string, string> {
  const need: Record<string, string> = {};
  if (!d.sections.includes("hero")) need.sections = "секция hero";
  if (mode === "white") {
    if (!d.city.trim()) need.city = "город";
  } else {
    if (!d.ctaPrimary.trim()) need.ctaPrimary = "текст CTA";
    if (!/^#[0-9a-f]{6}$/i.test(d.redHex.trim())) need.redHex = "красный hex (#RRGGBB)";
    if (!d.offer.trim()) need.offer = "оффер";
  }
  return need;
}

type LogTone = "ok" | "info" | "bad";
/** строка журнала: текст + тон (ok = шаг пройден, рисуем тёмно-зелёным) */
type LogLine = { text: string; tone: LogTone };

type Opt = { v: string; t: string; swatch?: { bg: string; accent: string } };

/**
 * Кастомный селект: браузерный <select> в закрытом списке рисует системную
 * подсветку и свой шрифт — на тёмной витрине это чужая синяя стилистика.
 * Закрыт по клику вне и по Escape; выбор — кнопка, поэтому работает с клавиатуры.
 * `swatch` у опции — два квадратика цвета: цвет пары видно не только в подписи.
 */
function Select({
  value,
  options,
  onChange,
  ariaLabel,
  custom,
}: {
  value: string;
  options: Opt[];
  onChange: (v: string) => void;
  ariaLabel: string;
  /** строка «Другое» внизу списка: свой вариант вписывается прямо в селект */
  custom?: { value: string; onChange: (v: string) => void; placeholder: string };
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.v === value) ?? options[0];
  // вписанная своя тема перекрывает подпись: в закрытом селекте видно её
  const shown = custom?.value.trim() || current?.t;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`sel ${open ? "open" : ""}`} ref={box}>
      <button
        type="button"
        className="sel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sel-val">
          {current?.swatch && (
            <span className="sel-sw">
              <i style={{ background: current.swatch.bg }} />
              <b style={{ background: current.swatch.accent }} />
            </span>
          )}
          <span className={custom?.value.trim() ? "sel-val-custom" : ""}>{shown}</span>
        </span>
        <svg className="chev" width="11" height="7" viewBox="0 0 11 7" aria-hidden>
          <path d="M1 1l4.5 4.5L10 1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <ul className="sel-list" role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <li key={o.v} role="option" aria-selected={o.v === value}>
              <button
                type="button"
                className={o.v === value ? "on" : ""}
                onClick={() => {
                  onChange(o.v);
                  setOpen(false);
                }}
                title={o.t}
              >
                {o.swatch && (
                  <span className="sel-sw">
                    <i style={{ background: o.swatch.bg }} />
                    <b style={{ background: o.swatch.accent }} />
                  </span>
                )}
                {o.t}
              </button>
            </li>
          ))}
          {custom && (
            <li className="sel-custom">
              <input
                className="sel-custom-input"
                value={custom.value}
                placeholder={custom.placeholder}
                maxLength={60}
                autoFocus={open && !custom.value}
                onChange={(e) => custom.onChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function BriefForm({ mode }: { mode: Mode }) {
  const [drafts, setDrafts] = useState(DRAFTS);
  const [status, setStatus] = useState<LogLine[]>([]);
  // сырой журнал событий: по умолчанию скрыт, открывается ссылкой «подробности»
  const [showLog, setShowLog] = useState(false);
  /**
   * Прокрутка журнала. Буфер держит все строки прогона, а панель — 320 px со
   * скроллом: без довора на новый конец сделанный шаг появлялся за нижним
   * краем, и это выглядело ровно как «таска пропущена». Держим ref на
   * отрисованном списке и докручиваем при каждой строке.
   */
  const logBoxRef = useRef<HTMLUListElement | null>(null);
  /** человек мог открутить журнал читать начало — не тянем его обратно на каждое событие */
  const logPinnedRef = useRef(true);
  // прогон дошёл до «done»: кнопка генерации становится зелёной «Готово»
  const [finished, setFinished] = useState(false);
  // сборка готова и ждёт человека: карточка ревью (смотреть/допилить/выгрузить)
  const [review, setReview] = useState<string | null>(null);
  // dist/index.html есть — кнопка «Смотреть» у кнопки генерации активна.
  // Ставится по событию review/done и снимается при новом запуске
  const [built, setBuilt] = useState(false);
  // плашка ручной пары: открывается выбором «своя пара», закрывается крестиком
  // (или сменой пары) — пара остаётся в селекте, плашка не обязана висеть
  const [hexOpen, setHexOpen] = useState(false);
  /**
   * Поп-карточка своей пары: автопереворот и закрытие по клику вне.
   * Вниз по умолчанию; если до низа окна не влезает (на 1280 плитка «своя
   * пара» заканчивает последний ряд — замер: popBottom 838 при vh 800),
   * карточка разворачивается вверх, стрелка едет на её нижний край.
   */
  const hexPopRef = useRef<HTMLDivElement | null>(null);
  /** плитка «своя пара»: на неё возвращаем фокус после Escape/крестика */
  const hexTileRef = useRef<HTMLButtonElement | null>(null);
  const [hexUp, setHexUp] = useState(false);
  // layout-эффект, а не обычный: обычный рисует кадр с карточкой за нижним
  // краем окна, и переворот заметен глазом как «мелькнула и вернулась»
  useLayoutEffect(() => {
    if (!hexOpen) return;
    const el = hexPopRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setHexUp(r.bottom > innerHeight - 12);
      // карточка шире плитки (min-width 150 px при плитке 100 px): у правого
      // края поля она вылезала за окно (замер: right 1289 при vw 1280).
      // Сдвиг считаем по факту, а не «прижимаем последнюю колонку»: число
      // колонок меняется с шириной окна, прижатая CSS-ом стрелка уезжала бы
      // с плиткой вразнобой на любой другой ширине
      const over = r.right - (document.documentElement.clientWidth - 12);
      el.style.setProperty("--hex-dx", over > 0 ? `-${Math.ceil(over)}px` : "0px");
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // закрытие из поля убирает из DOM активный элемент, и фокус проваливается
      // в <body>: возвращаем его на плитку, откуда карточка и была вызвана
      const wasInside = hexPopRef.current?.contains(document.activeElement);
      setHexOpen(false);
      if (wasInside) hexTileRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      // плитка («своя пара») сама решает, открывать или закрывать;
      // всё остальное — клик мимо карточки
      if (!t.closest?.(".pal-custom") && !hexPopRef.current?.contains(t)) setHexOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [hexOpen]);
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // куда лёг проект после генерации (событие export.place с сервера)
  const [placed, setPlaced] = useState<string | null>(null);
  // шлюз: план + смета из события gate.open; карточка живёт, пока прогон в awaiting-gate
  const [gate, setGate] = useState<{ plan: SitePlan; estimate?: RunManifest["estimate"] } | null>(null);
  /** смета доживает до конца прогона: gate закрывается, а «≈N мин» в трекере
      нужно юзеру как раз потом, когда он стоит у стены */
  const [runEstimate, setRunEstimate] = useState<RunManifest["estimate"] | null>(null);
  // фаза прогона для анимированного трекера (plan→gate→copy→images→code→checks→export)
  const [phase, setPhase] = useState<string>("");
  // почему прогон встал/упал/отменён — последняя task.error; без неё «cancelled»
  // или «needs_human» висит без объяснения причины
  const [stopNote, setStopNote] = useState<{ state: string; reason: string } | null>(null);
  const startedAtRef = useRef<number>(0);
  /** защита от двойного submit одного клика (`busy` на это не успевал) */
  const startingRef = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  /** dist уже собран: нужно внутри обработчика SSE, где свежий state недоступен
   * из-за замыкания (ревью при needs_human открывает именно оно) */
  const builtRef = useRef(false);

  const d = drafts[mode];
  const set = (patch: Partial<Draft>) => setDrafts((p) => ({ ...p, [mode]: { ...p[mode], ...patch } }));
  const pair =
    d.pairIndex === CUSTOM
      ? { label: "своя пара", bg: d.customBg, accent: d.customAccent }
      : COLOR_PAIRS[d.pairIndex];
  const gaps = useMemo(() => missing(mode, d), [mode, d]);
  /** те же пробелы ключами полей — для `missing`/aria у конкретного поля */
  const gapKeys = useMemo(() => missingKeys(mode, d), [mode, d]);

  // Имя папки юзер не пишет: сервер нумерует проекты сам (`white_001`, `white_002`),
  // здесь только показываем его заранее.
  const [nextId, setNextId] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "white") return;
    let live = true;
    api
      .nextWhite()
      .then((r) => live && setNextId(r.projectId))
      .catch(() => live && setNextId(null));
    return () => {
      live = false;
    };
  }, [mode]);
  // Куда ляжет проект после генерации: список даёт сервер — «в генераторе»,
  // «на рабочий стол» (если он есть на этой машине), избранные папки. Про чужие
  // серверы генератор ничего не знает: результат = папка + zip, дальше сам.
  const [destOpts, setDestOpts] = useState<DestInfo[]>([]);
  const [quick, setQuick] = useState<{ label: string; dir: string }[]>([]);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    if (mode !== "white") return;
    let live = true;
    api
      .delivery("")
      .then((r) => {
        if (!live) return;
        setDestOpts(r.options);
        setQuick(r.quick);
        // выбор из прошлого запуска становится выбором по умолчанию
        if (r.choice.kind === "desktop") set({ deliveryKind: "desktop", deliveryPath: "" });
        else if (r.choice.kind === "folder" || r.choice.kind === "custom")
          set({ deliveryKind: "folder", deliveryPath: r.choice.path ?? "" });
      })
      .catch(() => live && setDestOpts([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  /**
   * Блокировки по папке выгрузки здесь больше нет: раньше CTA гас, пока
   * недоступен введённый в брифе путь, но само поле переехало в ревью —
   * запуск генерации из-за чужой папки падать не должен.
   */

  /**
   * Автопрокрутка к тому, что требует внимания: шлюз («Поехали» — с него
   * начинаются токены), трекер прогона и карточка ревью. Все три рендерятся
   * ПОД липкой панелью с кнопкой, поэтому без этого юзер жал «Начать» и видел
   * прокрутку посреди полей (замер: gateTop 845 при vh 900, 883 при vh 800).
   */
  const attentionRef = useRef<HTMLDivElement | null>(null);
  /** deliver() карточки ревью: главный CTA финала живёт в липкой панели,
      но логика live/offline у выгрузки одна — на карточке */
  const shipRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!gate && !review && !busy) return;
    const el = attentionRef.current;
    if (!el) return;
    // Шлюз выравниваем по НИЗУ: карточка целиком в скроллпорт помещается
    // (534 px против ~723 px), а `nearest` выравнивал по верху и подсказка
    // «Enter — тоже Поехали» оставалась за сгибом на 42 px при vh 800
    const block: ScrollLogicalPosition = gate ? "end" : "nearest";
    el.scrollIntoView({ block, behavior: "smooth" });
  }, [gate, review, busy, phase]);

  /** старт начал сам юзер: подхватывающему эффекту уже нечего ловить */
  const userStartedRef = useRef(false);

  /**
   * F5/закрытие вкладки на шлюзе больше не осирочивает прогон. Раньше папка
   * была засчитана, а UI терял карточку: юзер жал «Начать» ещё раз и получал
   * white_003 рядом с white_002. Сервер держит прогон в `runs` и отдаёт весь
   * журнал SSE — при загрузке подключаемся к нему, токенов заново ни одного.
   */
  useEffect(() => {
    let live = true;
    api
      .projects()
      .then((r) => {
        // «done/cancelled/failed» не поднимаем: это результат, а не работа,
        // и зелёный финал после F5 блокировал бы новый запуск
        const ACTIVE = ["planning", "awaiting-gate", "running", "review", "paused", "needs_human"];
        const cand = r.runs
          .filter((x) => x.live && x.mode === mode && ACTIVE.includes(x.status))
          .sort((a, b) => b.projectId.localeCompare(a.projectId));
        if (!live || userStartedRef.current || runIdRef.current || !cand.length) return;
        const run = cand[0];
        // папка уже найдена: следующая генерация будет после неё, не в этот номер
        setNextId(run.projectId);
        if (run.status !== "review") setBusy(true);
        setPhase(run.status === "awaiting-gate" ? "gate" : run.status === "review" ? "review" : "plan");
        log({ text: `подхватил живой прогон ${run.projectId} (${run.status})`, tone: "info" });
        attach(run.projectId);
      })
      .catch(() => {
        /* сервер ещё не поднялся — просто нечего подхватывать */
      });
    return () => {
      live = false;
    };
    // attach — стабильная по смыслу функция компонента; в deps не кладём,
    // иначе эффект переподписывался бы на каждый рендер и дёргал SSE
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // dev-only: ?review=<id> открывает карточку ревью готовой папки (или после
  // перезапуска сервера, когда прогон не live, а dist на диске есть)
  useEffect(() => {
    const rid = new URLSearchParams(location.search).get("review");
    if (!rid) return;
    setReview(rid);
    setPreviewId(rid);
    setBuilt(true);
  }, []);

  // «Просмотреть» / «Нужны действия» в панели «Проекты» — кнопки, и шлют
  // сюда событие: карточка ревью живёт в этом компоненте, а панель — сосед по
  // сайдбару. Дисковые роуты (/site, /human-fix, /place) работают без живого
  // прогона, поэтому attach() на SSE здесь не нужен
  useEffect(() => {
    const onReview = (ev: Event) => {
      const id = (ev as CustomEvent<{ projectId: string }>).detail?.projectId;
      if (!id) return;
      setReview(id);
      setPreviewId(id);
      setBuilt(true);
      // карточка длинная и встроена в форму: без прокрутки юзер жмёт подпись и
      // не видит, что открылось (тот же класс дефекта, что «финал под сгибом»)
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("builder:review", onReview);
    return () => window.removeEventListener("builder:review", onReview);
  }, []);

  // dev-only: ?gate=1 показывает карточку шлюза на примере плана — без запросов к модели
  useEffect(() => {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("gate")) return;
    setGate({
      plan: {
        version: 1,
        briefHash: "dev", planHash: "dev",
        sections: [
          { type: "hero", heading: "Потолок за один день", slug: "hero" },
          { type: "benefits", heading: "Почему нас выбирают", slug: "benefits" },
          { type: "cta", heading: "Замер бесплатно", slug: "cta" },
        ],
        palette: { bg: "#FFFFFF", accent: "#0F62FE", text: "#14161A" },
        fonts: { heading: "Manrope", body: "Inter" },
        images: [
          { slug: "hero", description: "светлая гостиная с натяжным потолком", aspect: "16:9", role: "hero" },
          { slug: "proof-1", description: "мастер за работой", aspect: "3:4", role: "content" },
        ],
        hardRules: ["светлая серия, много воздуха", "не повторять красный предыдущего white"],
      },
      estimate: { images: 2, tokens: 12400, usd: 0, minutes: 4 },
    });
  }, []);

  /**
   * Журнал хранит ВСЕ строки прогона, а не хвост. Раньше здесь стоял
   * `prev.slice(-7)`, и при 36 задачах + 9 картинках на экране оставался
   * семистрочный хвост: сделанные шаги исчезали из вида, от чего казалось,
   * что «модель пропускает таски». Прокрутка — у панели (.log), не у буфера.
   */
  function log(line: LogLine) {
    setStatus((prev) => [...prev, line]);
  }

  // журнал доворачивается вниз только когда он открыт: в свёрнутом виде
  // скроллить нечего, а лезть в DOM каждый событие прогона незачем
  useLayoutEffect(() => {
    const el = logBoxRef.current;
    if (el && showLog && logPinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [status, showLog]);

  /**
   * «Готово» по клику: возврат страницы в дефолтное состояние — форма брифа
   * с сохранёнными полями, без трекера и лога. Новый запуск юзер жмёт сам,
   * а не по инерции зелёной кнопки.
   */
  function resetToDefault() {
    esRef.current?.close();
    esRef.current = null;
    runIdRef.current = null;
    setFinished(false);
    setBuilt(false);
    builtRef.current = false;
    setBusy(false);
    setPhase("");
    setStatus([]);
    setShowLog(false);
    setGate(null);
    setReview(null);
    setPlaced(null);
    setPreviewId(null);
    setStopNote(null);
    setRunEstimate(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function start() {
    if (gaps.length || busy || startingRef.current) return;
    // ref, а не state: `busy` — React state, между двумя submit одного двойного
    // клика он не успевает обновиться (доказательство: white_002/white_003 с
    // разницей в 5 мс). ref синхронен, вторая отправка выходит сразу
    startingRef.current = true;
    userStartedRef.current = true;
    setBusy(true);
    setPhase("plan");
    startedAtRef.current = Date.now();
    setPreviewId(null);
    setPlaced(null);
    setBuilt(false);
    builtRef.current = false;
    setReview(null);
    setStatus([]);
    setShowLog(false);
    setFinished(false);
    setBuilt(false);
    setGate(null);
    setRunEstimate(null);
    setStopNote(null);
    esRef.current?.close();
    // Номер вайта — не поле юзера: шлём основу серии (`white`), сервер берёт
    // максимальный номер и возвращает `white_036` — `white_000 + 1`.
    let id = mode === "white" ? "white" : `black_${slug(d.offer || d.typeAvatar)}`;
    try {
      let created: { projectId: string };
      try {
        created = await api.createProject(id, toBrief(mode, d), { numbered: mode === "white" });
        log({ text: `проект ${created.projectId} создан`, tone: "info" });
      } catch (e) {
        // повторный запуск того же black: бриф правили — перезаписываем, иначе
        // второй клик давал «проект уже есть» и прогон не стартовал (white
        // номерует сервер, для него этого случая почти не бывает)
        if (!/уже есть/.test((e as Error).message)) throw e;
        created = await api.createProject(id, toBrief(mode, d), {
          numbered: mode === "white",
          force: true,
        });
        log({ text: `проект ${created.projectId}: бриф обновлён`, tone: "info" });
      }
      id = created.projectId;
      const r = await api.startRun(id);
      log({ text: `прогон: ${r.status}`, tone: "info" });
      attach(id);
    } catch (err) {
      log({ text: `✕ ${(err as Error).message}`, tone: "bad" });
      setBusy(false);
    } finally {
      startingRef.current = false;
    }
  }

  /**
   * Открыть SSE на прогон. Вынесено из start(): то же самое нужно при
   * подхвате живого прогона после F5 (см. эффект resurrect) — сервер держит
   * прогон в памяти и отдаёт весь журнал событий, поэтому карточка шлюза
   * возвращается без единого нового токена.
   */
  function attach(id: string) {
    esRef.current?.close();
    runIdRef.current = id;
    setPreviewId(id);
    const es = new EventSource(api.eventsUrl(id));
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as {
          t: string;
          state?: string;
          task?: string;
          message?: string;
          cached?: boolean;
          plan?: SitePlan;
          estimate?: RunManifest["estimate"];
          /** export.place: куда лёг проект, zip и почему не лёг */
          path?: string;
          /** review.update: итог человеческой правки («патч применён…») */
          note?: string;
          zip?: string | null;
          error?: string;
          /** review.fix: разбивка раунда правок по пунктам */
          requested?: number;
          applied?: number;
          items?: Array<{ text: string; done: boolean; note?: string }>;
          /** image.slot: какая картинка и чем кончила */
          slug?: string;
          result?: string;
          /** fix.round: раунд автофиксов судьи */
          round?: number;
          defectsFixed?: number;
        };
        if (e.t === "run.state") log({ text: `состояние: ${e.state}`, tone: "info" });
        if (e.t === "task.skip") log({ text: `✓ ${e.task ?? ""} — уже готов, пропущено`, tone: "ok" });
        if (e.t === "task.start") log({ text: `→ ${e.task}`, tone: "info" });
        if (e.t === "task.start" && e.task) setPhase(phaseOf(e.task));
        if (e.t === "gate.open") setPhase("gate");
        if (e.t === "task.error") {
          log({ text: `✕ ${e.task}: ${e.message}`, tone: "bad" });
          setStopNote((prev) => ({ state: prev?.state ?? "running", reason: e.message ?? "ошибка задачи" }));
        }
        if (e.t === "gate.open" && e.plan) {
          log({ text: "шлюз: план готов, ждёт «Поехали»", tone: "info" });
          setGate({ plan: e.plan, estimate: e.estimate });
          if (e.estimate) setRunEstimate(e.estimate);
        }
        // любое следующее состояние после шлюза = его закрыли (или прогон умер)
        if (e.t === "gate.close" || (e.t === "run.state" && e.state !== "awaiting-gate")) setGate(null);
        // шаг пройден — тёмно-зелёным: сразу видно, что делать повторно не нужно
        if (e.t === "task.done" && e.task)
          log({ text: `✓ ${e.task}${e.cached ? " — из кэша" : ""}`, tone: "ok" });
        // dist готов с этого момента: «Смотреть» активна, и ревью можно открыть
        // даже если прогон потом встанет
        if (e.t === "task.done" && String(e.task ?? "").startsWith("assemble:")) {
          builtRef.current = true;
          setBuilt(true);
        }
        if (e.t === "export.place") {
          setPlaced(e.error ? `${e.path ?? "?"} — ${e.error}` : (e.path ?? "?"));
          log(e.error ? { text: `⚠ выгрузка: ${e.error}`, tone: "bad" } : { text: `выложено: ${e.path ?? "?"}${e.zip ? " + zip" : ""}`, tone: "ok" });
        }
        // ревью: вход (пусто), итог правки (note) или ошибка правки
        if (e.t === "review.update") {
          if (e.note) log({ text: `правка применена: ${e.note}`, tone: "ok" });
          if (e.error) log({ text: `✕ правка: ${e.error}`, tone: "bad" });
        }
        // Раунд правок с разбивкой: сколько заказано, сколько сделано, и по
        // строке на каждый пропущенный пункт — «весь список сделан» должно
        // читаться в журнале, а не угадываться по одной строке
        if (e.t === "review.fix" && e.items) {
          const done = e.items.filter((it) => it.done);
          const skipped = e.items.filter((it) => !it.done);
          log({
            text: `правки: ${e.applied ?? done.length} из ${e.requested ?? e.items.length}`,
            tone: skipped.length ? "bad" : "ok",
          });
          for (const it of done)
            log({ text: `✓ ${it.text}${it.note ? ` — ${it.note}` : ""}`, tone: "ok" });
          for (const it of skipped)
            log({ text: `✕ не сделано: ${it.text}${it.note ? ` — ${it.note}` : ""}`, tone: "bad" });
        }
        // Картинки и раунды автофиксов раньше в журнал не попадали вовсе:
        // 9 слотов и раунд судьи были невидимы — отсюда «таски пропускаются»
        if (e.t === "image.slot" && e.slug) {
          const bad = e.result === "failed" || e.result === "placeholder";
          log({
            text: `${bad ? "⚠" : "✓"} картинка ${e.slug}: ${e.result ?? "?"}`,
            tone: bad ? "bad" : "ok",
          });
        }
        if (e.t === "fix.round")
          log({ text: `раунд автофиксов ${e.round}: ${e.defectsFixed ?? 0} замечаний`, tone: "info" });
        if (e.t === "run.state") {
          // review — не «идёт работа»: кнопки отпускаем, но журнал (SSE) держим
          // открытым: правки и выгрузка будут видны в этом же окне.
          // На время live-правки (running) карточку НЕ прячем — она сама
          // показывает «Допиливаю…» и опрашивает статус; снимаем её только
          // когда прогон реально ушёл из ревью
          if (e.state === "review") {
            setBusy(false);
            setPhase("review");
            setBuilt(true);
            builtRef.current = true;
            setReview(id);
            setStopNote(null);
          } else if ("planning awaiting-gate done cancelled failed".includes(e.state ?? "")) {
            setReview(null);
          }
        }
        if (e.t === "run.state") {
          // поток держим открытым на paused/needs_human: прогон жив и ждёт
          // команды, а закрытый SSE лишал бы обновлений после «Продолжить»
          if (["done", "failed", "cancelled"].includes(e.state ?? "")) {
            setBusy(false);
            // зелёная кнопка — только честный «готов»; сбой/отмена возвращают обычную
            setFinished(e.state === "done");
            if (e.state === "done") setReview(null);
            setStopNote((prev) =>
              // «done» — не остановка: баннер «прервано» на зелёном финале
              // вспыхивал после клика «Готово» (when finished сбрасывается)
              e.state === "done" ? prev : { state: e.state!, reason: prev?.reason ?? "" },
            );
            es.close();
          }
          // пауза/needs_human: ждём человека, но журнал остаётся открытым
          if (e.state === "paused" || e.state === "needs_human") {
            setBusy(false);
            setStopNote((prev) => ({ state: e.state!, reason: prev?.reason ?? "" }));
            // собранное лежит на диске → ревью доступно и при красном вердикте:
            // смотреть/править/выгружать можно и с замечаниями
            if (e.state === "needs_human" && builtRef.current) setReview(id);
          }
          // «Продолжить» сработало — баннер остановки больше не нужен
          if (e.state === "running") {
            setBusy(true);
            setStopNote(null);
          }
        }
      } catch {
        /* событие не JSON — пропускаем */
      }
    };
    es.onerror = () => {
      es.close();
      setBusy(false);
    };
  }

    return (
    <section
      className="brief"
      id="brief"
      /* состояние прогона наружу: по нему прячутся стрип и липкая панель.
         `gate` выделен отдельно: в плане красный «Поехали» единственный CTA */
      data-run={gate ? "gate" : review ? "review" : busy ? "running" : undefined}
    >
      {/* Enter в любом поле = «Начать генерацию»: раньше форма была набором div,
          и с клавиатуры запустить прогон было нельзя. e.target !== currentTarget
          отсекает submit всплывших внутренних форм (карточка шлюза — со своей) */}
      <form onSubmit={(e) => { e.preventDefault(); if (e.target !== e.currentTarget || finished) return; void start(); }}>
      <div className="brief-head">
        <div>
          <p className="eyebrow">
            Бриф <span className="eyebrow-mode">{mode === "white" ? "WHITE" : "BLACK"}</span>
          </p>
          <h2>{mode === "white" ? "Запустите генерацию в пару кликов" : "Что льём"}</h2>
          <p className="brief-sub">
            Вы заполняете основные поля, остальную работу сделают умные модели.
          </p>
        </div>
        {/* Пересказ выбора до сборки — дубли того, что и так стоит в полях выше,
            и на 1280 он переносился на вторую строку. Показываем только когда
            значение перестаёт быть очевидным: была сборка. Голый свотч без строки
            — мёртвая точка в углу, поэтому прячемся целиком */}
        {(built || finished) && (
          <div className="brief-mode">
            <span className="swatch" style={{ background: mode === "white" ? pair.accent : d.redHex }} />
            <span className="mono">
              {mode === "white"
                ? `${pair.label} · ${d.pageCount} стр. · ${d.locale}`
                : `${d.redHex} · ${d.typeAvatar}`}
            </span>
          </div>
        )}
      </div>

      <div className="grid">
        {mode === "white" ? (
          <>
            {/* Порядок = порядок сборки сайта: для чего сайт → как выглядит →
                где и как → контакты → что внутри. Заголовок пишет модель. */}
            <div className="field">
              <span>
                Тематика сайта <Hint text="Первое, с чего начинается сборка: от тематики зависят тексты, сюжеты картинок и лексика заголовков. «Другое» — напишите свою тему." />
              </span>
              <Select
                ariaLabel="Тематика сайта"
                value={d.customTheme.trim() ? "__custom__" : d.theme}
                options={THEMES}
                onChange={(v) => set({ theme: v as WhiteTheme, customTheme: "" })}
                custom={{
                  value: d.customTheme,
                  onChange: (v) => set({ theme: "other", customTheme: v }),
                  placeholder: "Другое",
                }}
              />
            </div>

            <div className="field">
              <span>
                Язык <Hint text="Язык всего, что пишет модель: заголовков, текстов, картинок. English первым в списке, дальше русский и остальные по частоте." />
              </span>
              <Select
                ariaLabel="Язык"
                value={d.locale}
                options={LOCALES}
                onChange={(v) => set({ locale: v })}
              />
            </div>

            <div className="field">
              <span>
                Сколько страниц <Hint text="1 — один индексный файл. 2–6 — столько вариативных страниц (about, contact, services, faq, team) плюс юридическое ядро policy / terms / thanks доезжает автоматически. На одностраничнике ядро не генерим." />
              </span>
              <Select
                ariaLabel="Сколько страниц"
                value={String(d.pageCount)}
                options={[
                  { v: "1", t: "1 страница" },
                  { v: "2", t: "2 страницы" },
                  { v: "3", t: "3 страницы" },
                  { v: "4", t: "4 страницы" },
                  { v: "5", t: "5 страниц" },
                  { v: "6", t: "6 страниц" },
                ]}
                onChange={(v) => {
                  const pages = Number(v) as Draft["pageCount"];
                  if (pages > 1) {
                    // многостраничник: каркас и страничные блоки включены всегда —
                    // иначе «главная без hero» ломает и прогон, и смысл групп
                    const add = [...SPINE, ...PAGE_WORTHY].filter((x) => !d.sections.includes(x));
                    set({ pageCount: pages, sections: add.length ? [...d.sections, ...add] : d.sections });
                  } else {
                    set({ pageCount: pages });
                  }
                }}
              />
            </div>
            {/* обязательное поле: * у подписи + ошибка ПОД ПОЛЕМ (раньше — только
                красный контур, а причина ждала юзера в 400 px ниже, у кнопки) */}
            <label className={`field${d.city.trim() ? "" : " missing"}`}>
              <span>
                Город <i className="req" aria-hidden>*</i> <Hint text="Город попадает в заголовки, тексты и контакты. Поле обязательное — без него прогон не стартует." />
              </span>
              <input
                value={d.city}
                placeholder="Dubai"
                aria-required="true"
                aria-invalid={d.city.trim() ? undefined : "true"}
                aria-describedby={d.city.trim() ? undefined : "city-err"}
                onChange={(e) => set({ city: e.target.value })}
              />
              {!d.city.trim() && <p className="field-err" id="city-err">Без города прогон не стартует: он в заголовках, текстах и контактах.</p>}
            </label>
            {/* Видефон — вторая половина того же сегмента, а не отдельное поле.
                Кнопка выключена ПО-настоящему (`disabled`, не `aria-disabled`):
                видео-модели на этом генераторе ещё нет, и выбор, который ничего
                не меняет, вводит в заблуждение сильнее, чем явная неактивная
                половина. Подписи «скоро» нет — обещание без срока только
                мешает; почему нельзя — в title и в подсказке поля */}
            <div className="field">
              <span>
                Анимация в hero <Hint text="Статика — hero с картинкой-постером: собирается всегда и предсказуемо. Видефон (зацикленный ролик на фоне) станет доступен, когда будет подключена модель генерации видео."
                />
              </span>
              <div className="seg" role="group" aria-label="Анимация в hero">
                <button
                  type="button"
                  className={d.heroMotion === "static" ? "on" : ""}
                  aria-pressed={d.heroMotion === "static"}
                  onClick={() => set({ heroMotion: "static" })}
                >
                  статика
                </button>
                <button
                  type="button"
                  aria-disabled="true"
                  aria-pressed={d.heroMotion === "video"}
                  title="Видефон появится, когда будет настроена модель генерации видео"
                  onClick={(e) => {
                    // выкл по-настоящему: `disabled` в Chromium не показывает
                    // title, и объяснение «почему нельзя» пропало бы
                    if ((e.currentTarget as HTMLButtonElement).getAttribute("aria-disabled") === "true") {
                      e.preventDefault();
                      return;
                    }
                    set({ heroMotion: "video" });
                  }}
                >
                  видефон
                </button>
              </div>
            </div>

            {/* Geometry of the first screen: the freed cell of the row
                (Город | Анимация | …). This is not decoration: `full` stretches hero to the
                window edges, `container` keeps it inside the page's `--maxw` like all
                other sections — the rhythm of the first screen changes from this */}
            <div className="field">
              <span>
                Hero по ширине <Hint text="На всю ширину — текст и картинка идут у краёв окна, первый экран выглядит крупнее. В контейнере — hero сжат до той же колонки, что и остальные секции: спокойный ритм, узкая строка чтения." />
              </span>
              <div className="seg" role="group" aria-label="Hero по ширине">
                {HERO_WIDTHS.map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    className={d.heroWidth === o.v ? "on" : ""}
                    aria-pressed={d.heroWidth === o.v}
                    title={o.hint}
                    onClick={() => set({ heroWidth: o.v })}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
            </div>

            {/* Палитра — соседом по сетке, а не внутри предыдущего field: пока
                этот <div> лежал в <label> «Анимация», `grid-column:1/-1` на него не
                действовал (grid-ребёнок — <label>, а не он), и 14 плиток жались в
                одну колонку 355 px ~7 рядов, оставляя две мёртвые дыры по бокам.
                Заодно <div> внутри <label> — невалидный HTML */}
            {/* палитра: сетка плиток с живой пробой. Раньше был Select: 18 пар
                в окне 264 px = видно ~6, скролл-бар невидим, пробы нет */}
            <div className="field wide">
              <span>
                Цветовая палитра <Hint text="Готовые пары подобраны по цветовому кругу: фон и акцент не конфликтуют. Каждая плитка — мини-экран будущего сайта: фон пары, акцентная полоса и строки текста. «Своя пара» — любые два цвета вручную." />
              </span>
              <div className="pal" role="group" aria-label="Цветовая пара">
                {COLOR_PAIRS.map((p, i) => (
                  <button
                    key={p.label}
                    type="button"
                    className="pal-btn"
                    aria-pressed={d.pairIndex === i}
                    title={`${p.label} · фон ${p.bg} · акцент ${p.accent}`}
                    onClick={() => {
                      set({ pairIndex: i });
                      setHexOpen(false);
                    }}
                  >
                    <span
                      className="pal-prev"
                      style={{ background: p.bg, color: p.accent }}
                      aria-hidden
                    >
                      <i />
                      <b />
                      <s />
                    </span>
                    <span className="pal-name">{p.label}</span>
                  </button>
                ))}
                <span className="pal-custom">
                  <button
                    type="button"
                    ref={hexTileRef}
                    className="pal-btn"
                    aria-pressed={d.pairIndex === CUSTOM}
                    aria-expanded={d.pairIndex === CUSTOM && hexOpen}
                    title="своя пара — выбрать фон и акцент вручную"
                    onClick={() => {
                      // повторный клик по активной плитке закрывает карточку
                      const closing = d.pairIndex === CUSTOM && hexOpen;
                      set({ pairIndex: CUSTOM });
                      setHexOpen(!closing);
                    }}
                  >
                    <span
                      className="pal-prev pal-prev-custom"
                      style={{ background: d.customBg, color: d.customAccent }}
                      aria-hidden
                    >
                      <i />
                      <b />
                      <s />
                      {/* крестик «добавь своё»: без него последняя плитка
                          неотличима от готовых пар, и до неё не доходят */}
                      <svg className="pal-plus" width="12" height="12" viewBox="0 0 12 12">
                        <circle cx="6" cy="6" r="5.2" />
                        <path d="M6 3.6v4.8M3.6 6h4.8" />
                      </svg>
                    </span>
                    <span className="pal-name">своя пара</span>
                  </button>

                  {/* Поп-карточка своей пары. Она привязана к ПЛИТКЕ, а не ко всей
                      плашке палитры: раньше `.hex` был абсолют на всю ширину поля
                      (замер: 1100 px при плитке 152 px) и висячей полосой ложился на
                      «Секции главной страницы». Теперь это карточка размером с плитку
                      ×2, опущенная абсолютным слоем под ряд — поток брифа она не
                      двигает, а чужие поля не накрывает */}
                  {d.pairIndex === CUSTOM && hexOpen && (
                    <div
                      className={`hex-pop${hexUp ? " up" : ""}`}
                      ref={hexPopRef}
                      role="group"
                      aria-label="Своя цветовая пара"
                    >
                      <span className="hex-pop-arrow" aria-hidden />
                      <div className="hex-pop-body">
                        <HexField
                          caption="фон"
                          label="свой фон"
                          value={d.customBg}
                          onCommit={(v) => set({ customBg: v })}
                        />
                        <HexField
                          caption="акцент"
                          label="свой акцент"
                          value={d.customAccent}
                          onCommit={(v) => set({ customAccent: v })}
                        />
                      </div>
                      <div className="hex-pop-foot">
                        <span
                          className="pal-prev hex-prev"
                          style={{ background: d.customBg, color: d.customAccent }}
                          aria-hidden
                        >
                          <i />
                          <b />
                          <s />
                        </span>
                        {/* хексы здесь не дублируем: они уже в двух полях выше */}
                        <button
                          type="button"
                          className="hex-close"
                          aria-label="закрыть выбор своей пары"
                          onClick={() => {
                            setHexOpen(false);
                            hexTileRef.current?.focus();
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                </span>
              </div>
            </div>
          </>
        ) : (
          <>
            <label className={`field${gapKeys.offer ? " missing" : ""}`}>
              <span>
                Оффер — за счёт чего льём <i className="req" aria-hidden>*</i> <Hint text="Суть преленда: скидка, акция, условие. По нему модель пишет экраны и подбирает caption'ы." />
              </span>
              <input
                value={d.offer}
                placeholder="Скидка 60% на абонемент до пятницы"
                aria-required="true"
                aria-invalid={gapKeys.offer ? "true" : undefined}
                onChange={(e) => set({ offer: e.target.value })}
              />
              {gapKeys.offer && <p className="field-err">Без оффера нечего генерить: это суть преленда.</p>}
            </label>
            <label className={`field${gapKeys.redHex ? " missing" : ""}`}>
              <span>
                Красный оттенок <i className="req" aria-hidden>*</i> <Hint text="Акцент black-серии. Перед сборкой значение сверяется с LANDING_REGISTRY.md: повторить красный предыдущего проекта — брак." />
              </span>
              <div className="hex">
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(d.redHex) ? d.redHex : "#E1122A"}
                  onChange={(e) => set({ redHex: e.target.value.toUpperCase() })}
                />
                <input
                  value={d.redHex}
                  aria-required="true"
                  aria-invalid={gapKeys.redHex ? "true" : undefined}
                  onChange={(e) => set({ redHex: e.target.value.toUpperCase() })}
                />
              </div>
              {gapKeys.redHex && <p className="field-err">Нужен формат #RRGGBB — по нему сверяют повтор с прошлым проектом.</p>}
            </label>
            <label className="field">
              <span>
                Тип / аватар <Hint text="Кто на первом экране: пол, возраст, образ. По этому описанию генерируется аватар." />
              </span>
              <input value={d.typeAvatar} onChange={(e) => set({ typeAvatar: e.target.value })} />
            </label>
            <label className={`field${gapKeys.ctaPrimary ? " missing" : ""}`}>
              <span>
                Текст CTA <i className="req" aria-hidden>*</i> <Hint text="Надпись на кнопке клика. Обязательное поле." />
              </span>
              <input
                value={d.ctaPrimary}
                aria-required="true"
                aria-invalid={gapKeys.ctaPrimary ? "true" : undefined}
                onChange={(e) => set({ ctaPrimary: e.target.value })}
              />
              {gapKeys.ctaPrimary && <p className="field-err">Без текста CTA преленд не имеет цели клика.</p>}
            </label>
            <label className="field">
              <span>
                Видео в лендинге <Hint text="Есть ролик — в сборку попадёт папка video/ и плеер на экране. Без видео — только статичные экраны." />
              </span>
              <div className="seg">
                <button className={d.hasVideo ? "on" : ""} type="button" onClick={() => set({ hasVideo: true })}>
                  есть ролик
                </button>
                <button className={!d.hasVideo ? "on" : ""} type="button" onClick={() => set({ hasVideo: false })}>
                  без видео
                </button>
              </div>
            </label>
            <label className="field wide">
              <span>
                Caption'ы — по строке на экран <Hint text="Каждая строка = надпись на своём экране, сверху вниз. Пусто — модель придумает сама по офферу." />
              </span>
              <textarea
                rows={3}
                value={d.captions}
                placeholder="первый экран / второй экран / третий экран — по строке на экран"
                onChange={(e) => set({ captions: e.target.value })}
              />
            </label>
          </>
        )}


        <div className="field wide">
          <span>
            {mode === "black"
              ? "Секции — порядок экранов"
              : d.pageCount === 1
                ? "Секции сайта"
                : "Секции главной страницы"}{" "}
            <Hint
              text={
                mode === "black"
                  ? "Что войдёт в страницу. Порядок здесь = порядок сверху вниз; hero обязателен."
                  : d.pageCount === 1
                    ? "Одностраничник: всё выбранное живёт на одной странице, порядок = сверху вниз. hero обязателен."
                    : "Многостраничник: здесь только то, что видно на главной. Ценой и вопросами модель наполнит отдельные страницы — на главной от них остаются карточка и ссылка."
              }
            />
          </span>
          {mode === "white" && d.pageCount > 1 ? (
            <>
              <div className="chip-group">
                <span className="chip-group-label">каркас</span>
                <div className="chips">
                  {SPINE.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className="locked"
                      // не disabled: «каркас — всегда» — это НЕ «выключено»,
                      // и с disabled пилюля выпадала из порядка табуляции
                      aria-disabled="true"
                      title="Каркас страницы: без него страница не страница, снять нельзя"
                    >
                      {sec}
                    </button>
                  ))}
                </div>
              </div>
              <div className="chip-group">
                <span className="chip-group-label">на главной</span>
                <div className="chips">
                  {MAIN_ONLY.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className={d.sections.includes(sec) ? "on" : ""}
                      onClick={() =>
                        set({
                          sections: d.sections.includes(sec)
                            ? d.sections.filter((x) => x !== sec)
                            : [...d.sections, sec],
                        })
                      }
                    >
                      {sec}
                    </button>
                  ))}
                </div>
              </div>
              <div className="chip-group">
                <span className="chip-group-label">отдельные страницы</span>
                <div className="chips">
                  {PAGE_WORTHY.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className={d.sections.includes(sec) ? "on" : ""}
                      title="Станет отдельной страницей; на главной — карточка со ссылкой"
                      onClick={() =>
                        set({
                          sections: d.sections.includes(sec)
                            ? d.sections.filter((x) => x !== sec)
                            : [...d.sections, sec],
                        })
                      }
                    >
                      {sec}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="chips">
              {SECTION_CATALOG.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className={d.sections.includes(sec) ? "on" : ""}
                  onClick={() =>
                    set({
                      sections: d.sections.includes(sec)
                        ? d.sections.filter((x) => x !== sec)
                        : [...d.sections, sec],
                    })
                  }
                >
                  {sec}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* «Куда выгрузить» из брифа убрано: выбор папки здесь ничего не выгружал
          (placeExport вызывается только кнопкой «Выгрузить»), а после сборки те
          же цели появляются в карточке ревью — то есть блок был дублем и к тому
          же задерживал запуск: введённый путь блокировал кнопку, пока сервер
          проверял доступность. Место по-прежнему помнится сервером
          (settings.delivery), поэтому в ревью предлагается именно прошлая папка.
          Формат индексов (index.php / index.html) уехал оттуда же в карточку
          ревью: он нужен серверу, куда несут сайт, и выбирать его нужно у
          кнопок выгрузки, а не до генерации. */}

      {/* Пожелание — открытое поле, а не «плюс-плашка»: свёрнутая строка с
          плюсом выглядела ссылкой неизвестно на что, и её не замечали.
          Здесь оно и по смыслу последнее поле перед запуском */}
      <div className="field wishes-field">
        <span>
          Дополнительное пожелание к проекту <Hint text="Одно предложение своими словами: «кнопки круглые», «больше фото», «тёмный футер». Это правило с самым высоким приоритетом — модель обязана выполнить его, а не на своё усмотрение. Пусто — модель решает сама." />
        </span>
        <input
          className="wishes-input"
          value={d.wishes}
          placeholder="например: кнопки круглые, заголовок крупнее, телефон в шапке"
          maxLength={300}
          onChange={(e) => set({ wishes: e.target.value })}
        />
      </div>

      <div className="brief-foot">
        {/* Финал сцены: в review единственный красный CTA был «Начать
            генерацию» — то есть «начать заново», а не «забрать готовое».
            Теперь главным становится выгрузка (тот же deliver(), что в
            карточке), а обычный запуск уходит в ghost. Порядок рисует flex-
            order: DOM не переставляем — ref-колбэк живёт у submit и не должен
            пересоздаваться на каждом ререндере прогона */}
        {review && (
          <button
            type="button"
            className="btn primary ship"
            onClick={() => shipRef.current?.()}
            title="выгрузить в прошлую цель — там же, где кнопки в карточке ревью"
          >
            ⤓ Выгрузить
          </button>
        )}
        <button
          type="submit"
          className={`btn${review ? " ghost" : ` primary${finished ? " done" : ""}${busy ? " busy" : ""}`}`}
          onClick={() => (finished ? resetToDefault() : void start())}
          disabled={!busy && gaps.length > 0}
          aria-describedby={gaps.length ? "cta-why" : undefined}
        >
          {finished
            ? "✓ Готово"
            : busy
              ? phase === "plan"
                ? "Строю план → жду подтверждения"
                : phase === "gate"
                  ? "Жду вашего подтверждения"
                  : // три точки пляшут по очереди — прогон живой, кнопка не «мертвая»
                    <span className="gen-dots">Генерация<span><i>.</i><i>.</i><i>.</i></span></span>
              : "Начать генерацию"}
        </button>
        {mode === "white" && nextId && !busy && (
          <span className="hint mono">папка {nextId}</span>
        )}
        {/* смотреть собранное можно с первой сборки и до выгрузки: ссылка на
            локальный сервер генератора, а не file:// — тот же корень, что у хостинга.
            До сборки кнопка existe, ноdisabled — человек видит, что будет дальше */}
        {(previewId || nextId) &&
          (built && previewId ? (
            <a
              className="btn ghost sm"
              href={`/projects/${previewId}/dist/index.html`}
              target="_blank"
              rel="noreferrer"
              title="открыть собранный сайт на локальном сервере (без кэша)"
            >
              ▶ Смотреть
            </a>
          ) : (
            <button type="button" className="btn ghost sm" disabled title="сборок ещё нет: кнопка станет активной, когда dist будет собран">
              ▶ Смотреть
            </button>
          ))}
        {finished && previewId && (
          <span className="hint mono result-acts">
            <a className="dl-link" href={api.downloadUrl(previewId)} download title="скачать архив готового сайта">
              ↓ архив
            </a>
            <a className="dl-link" href={api.promptUrl(previewId)} download title={`скачать промпт: prompt_${previewId}.md`}>
              ↓ промпт
            </a>
            <a
              className="dl-link"
              href={`/projects/${previewId}/dist/index.html`}
              target="_blank"
              rel="noreferrer"
              title={`открыть превью: /projects/${previewId}/`}
            >
              превью
            </a>
          </span>
        )}
        {/* причина неактивной кнопки — под ней, а не в 400 px ниже */}
        {gaps.length > 0 && !busy && (
          <span className="foot-why bad" id="cta-why">
            Не хватает: {gaps.join(", ")}. Как только заполните — кнопка станет активной.
          </span>
        )}
        {placed && (
          <span className="hint placed" title={`готовый проект выложен здесь: ${placed}`}>
            ✓ выложено
          </span>
        )}
      </div>

      {/* якорь автопрокрутки один на все три блока: они взаимоисключающи,
          а три одноимённых ref оставляли последний победивший */}
      <div ref={attentionRef}>
      {gate && (
        <GateCard
          plan={gate.plan}
          estimate={gate.estimate}
          pageCount={mode === "white" ? d.pageCount : 1}
          busy={false}
          onGo={() => {
            const id = runIdRef.current;
            if (!id) return;
            void api.command(id, "skip-gate").then(() => log({ text: "шлюз закрыт — поехали", tone: "info" }));
          }}
          onBack={() => {
            const id = runIdRef.current;
            // выход из плана: прогон отменяется, папка стирается сервером —
            // следующий запуск снова получит тот же номер без конфликта
            if (id) void api.command(id, "back");
            esRef.current?.close();
            esRef.current = null;
            runIdRef.current = null;
            setGate(null);
            setPhase("");
            setBusy(false);
            setPreviewId(null);
            log({ text: "выход в бриф: прогон отменён, проект очищен", tone: "info" });
          }}
          onRegen={(comment) => {
            const id = runIdRef.current;
            if (!id) return;
            void api.command(id, "regen-plan", comment).then(() => log({ text: "перегенерирую план…", tone: "info" }));
          }}
          onPatch={async (plan) => {
            const id = runIdRef.current;
            if (!id) return "прогон не запущен";
            try {
              await api.patchPlan(id, plan);
              return null;
            } catch (err) {
              return (err as Error).message;
            }
          }}
        />
      )}

      {review && (
        <ReviewCard
          projectId={review}
          mode={mode}
          shipRef={shipRef}
          destOpts={destOpts}
          chosenPath={d.deliveryKind === "folder" ? d.deliveryPath.trim() : ""}
          onOpenPicker={() => setPicker(true)}
          onLog={(text, tone) => log({ text, tone })}
          onFinished={() => {
            setReview(null);
            setFinished(true);
          }}
        />
      )}

      {/* Обозреватель папок остался один на всю страницу: им пользуется только
          ревью («в папку…» под собранним сайтом). В брифе он больше не нужен —
          блок выбора цели от туда убран как дубль этого же ряда в ревью */}
      {picker && (
        <DirPicker
          quick={quick}
          initial={d.deliveryPath}
          onPick={(dir) => {
            // Прогон мог перестать быть live (перезапуск сервера) — тогда те же
            // шаги делаются дисковыми роутами
            void api
              .command(review ?? "", "deliver", dir)
              .then(() => log({ text: `выгружаю в ${dir}`, tone: "info" }))
              .catch(async () => {
                if (!review) return;
                try {
                  const r = await api.place(review, { path: dir });
                  await api.acceptOffline(review).catch(() => {});
                  log({
                    text: r.placed ? `выложено: ${r.placed.dir}` : "выгрузка не нужна",
                    tone: r.placed ? "ok" : "info",
                  });
                  setReview(null);
                  setFinished(true);
                } catch (e) {
                  log({ text: `выгрузка: ${(e as Error).message}`, tone: "bad" });
                }
              });
            setPicker(false);
          }}
        />
      )}

      {busy && <RunActivity phase={phase === "review" ? "checks" : phase} waiting={!!gate} startedAt={startedAtRef.current} minutes={runEstimate?.minutes} />}
      </div>
      </form>

      {/* прогон встал не по своей воле: показываем причину человеческим языком,
          а не сухим «состояние: cancelled». Пауза — НЕ начало сначала: всё
          сгенерированное лежит на диске и в кэше, Продолжить доходит с того же шага */}
      {!busy && stopNote && !finished && (
        <div className="stop-note">
          <b>
            {stopNote.state === "cancelled"
              ? "Генерация остановлена"
              : stopNote.state === "paused"
                ? "Прогон ждёт вашего «Продолжить»"
                : stopNote.state === "needs_human"
                  ? "Дальше — только человек"
                  : "Генерация прервана"}
          </b>
          {stopNote.reason && <span> — {stopNote.reason}</span>}
          <span className="stop-note-tip">
            {stopNote.state === "paused" || stopNote.state === "needs_human"
              ? " Токены на этом остановлены: план, тексты, вёрстка и готовые картинки сохранены — «Продолжить» дойдёт с того же шага, заново ничего не генерируется."
              : " Токены на этом остановлены, продолжится с новой генерации."}
          </span>
          {(stopNote.state === "paused" || stopNote.state === "needs_human") && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                const id = runIdRef.current;
                if (!id) return;
                void api
                  .command(id, "resume")
                  .then(() => {
                    setStopNote(null);
                    log({ text: "продолжаю с сохранённых артефактов", tone: "info" });
                  })
                  .catch((e) => log({ text: `не удалось продолжить: ${(e as Error).message}`, tone: "bad" }));
              }}
            >
              ▶ Продолжить
            </button>
          )}
          <button
            type="button"
            className="linkbtn"
            onClick={() => setStopNote(null)}
            aria-label="скрыть причину остановки"
          >
            скрыть ✕
          </button>
        </div>
      )}

      {/* журнал по умолчанию свёрнут: таймлайн уже показывает фазы, а человеку
          важны только проблемы (✕/⚠) — они видны всегда, остальное под ссылкой */}
      {status.some((l) => l.tone === "bad") && (
        <ul className="log log-problems mono">
          {status.filter((l) => l.tone === "bad").map((l, i) => (
            <li key={i}>{l.text}</li>
          ))}
        </ul>
      )}
      {showLog && (
        <ul
          className="log mono"
          ref={logBoxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 40 px запаса: за него считается «всё ещё у конца», иначе округление
            // дробного scrollHeight срывает закрепление на каждом шаге
            logPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {status.map((l, i) => (
            <li key={i} className={`log-${l.tone}`}>{l.text}</li>
          ))}
        </ul>
      )}
      {status.length > 0 && (
        <button
          type="button"
          className="linkbtn log-toggle"
          onClick={() => {
            // при открытии журнал всегда показывает конец: юзер пришёл смотреть,
            // на чём прогон встал, а не куда его откручивал полчаса назад
            if (!showLog) logPinnedRef.current = true;
            setShowLog((v) => !v);
          }}
        >
          {showLog ? "скрыть журнал ▴" : "подробности журнала ▾"}
        </button>
      )}
    </section>
    );
}

/**
 * Обозреватель папок этой машины: сервер перечисляет содержимое, юзер тыкает
 * подпапки и выбирает цель выгрузки без ручного набора пути. Быстрые места
 * (домой, диски, рабочий стол) — первыми; кнопка «выбрать эту папку» фиксирует
 * текущий каталог целью.
 */
function DirPicker({
  quick,
  initial,
  onPick,
}: {
  quick: { label: string; dir: string }[];
  initial: string;
  onPick: (dir: string) => void;
}) {
  const [dir, setDir] = useState(initial || "");
  const [listing, setListing] = useState<{
    dir: string;
    parent: string | null;
    dirs: { name: string; writable: boolean }[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .browse(dir)
      .then((r) => live && setListing(r))
      .catch(() => live && setListing(null));
    return () => {
      live = false;
    };
  }, [dir]);

  const cur = listing?.dir ?? dir;
  return (
    <div className="dirpicker">
      <div className="chips">
        {quick.map((q) => (
          <button key={q.dir} type="button" className={cur === q.dir ? "on" : ""} onClick={() => setDir(q.dir)}>
            {q.label}
          </button>
        ))}
      </div>
      {listing?.error && <span className="deliver-note bad"><code>{listing.error}</code></span>}
      {listing && (
        <>
          <div className="dirpicker-list">
            {listing.parent && (
              <button type="button" className="dirpicker-up" onClick={() => setDir(listing.parent!)}>
                ..
              </button>
            )}
            {listing.dirs.map((x) => (
              <button
                key={x.name}
                type="button"
                className={x.writable ? "" : "off"}
                onClick={() => setDir(`${listing.dir}/${x.name}`)}
              >
                {x.name}
                {!x.writable && <em>только чтение</em>}
              </button>
            ))}
            {listing.dirs.length === 0 && !listing.parent && <span className="hint">пусто</span>}
          </div>
          <div className="dirpicker-foot">
            <code className="mono">{listing.dir}</code>
            <button
              type="button"
              className="btn"
              disabled={!listing.dirs.length && !!listing.error}
              onClick={() => onPick(listing.dir)}
            >
              выбрать эту папку
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Порядок фаз прогона — он же трекер. Задача любое имя task из журнала
 * (`image:hero`, `judge:r1`, `fix:r2:d1`) сводит к своей фазе: трекер показывает
 * только то, что реально происходит, и юзер видит живую работу, а не «зависло».
 */
const PHASES: Array<{ id: string; t: string }> = [
  { id: "plan", t: "план" },
  { id: "gate", t: "подтверждение" },
  { id: "copy", t: "тексты" },
  { id: "images", t: "картинки" },
  { id: "code", t: "вёрстка" },
  { id: "checks", t: "проверки" },
  { id: "export", t: "экспорт" },
];

function phaseOf(task: string): string {
  const head = task.split(":")[0];
  if (head === "plan") return "plan";
  if (head === "copy") return "copy";
  if (head === "image" || head === "image-prompts") return "images";
  if (head === "code") return "code";
  if (["assemble", "shoot", "judge", "fix"].includes(head)) return "checks";
  if (head === "export" || head === "report") return "export";
  return "";
}

/**
 * Что юзеру честно объяснять про текущую фазу. Главная задача — первая:
 * «раздумье» модели до плана длинное, и без объяснения оно выглядит как
 * «генерация пошла сама» — а уходить надо только после подтверждения плана.
 */
const PHASE_HINTS: Record<string, string> = {
  plan: "Строю план сайта — это ~10–60 секунд. Дальше генерация встанет на подтверждении: план появится здесь, уходить можно только после него — пока токены не тратятся.",
  copy: "Пишем тексты по подтверждённому плану…",
  images: "Генерируем картинки по плану…",
  code: "Верстаем страницу: HTML + CSS + JS…",
  checks: "Скриним страницу и проверяем дефекты…",
  export: "Собираем экспорт и архив…",
};

function RunActivity({ phase, waiting, startedAt, minutes }: { phase: string; waiting: boolean; startedAt: number; minutes?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const idx = PHASES.findIndex((p) => p.id === phase);
  const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  return (
    <div className="run-activity">
      <div className="run-steps">
        {PHASES.map((p, i) => {
          const cls = idx < 0 ? "" : i < idx ? "done" : i === idx ? "active" : "";
          return (
            <span key={p.id} className={`run-step ${cls} ${waiting && p.id === "gate" ? "waiting" : ""}`}>
              {i < idx ? "✓ " : ""}
              {p.t}
            </span>
          );
        })}
      </div>
      <div className="run-bar" aria-hidden>
        <div className="run-bar-fill" />
      </div>
      <span className={`run-hint${phase === "plan" && !waiting ? " run-hint-plan" : ""}`}>
        {waiting
          ? "ждём вашего «Поехали» в плане — токены ещё не тратятся"
          : PHASE_HINTS[phase] ?? "идёт работа…"}{" "}
        {/* ожидаемое машинное время рядом со счётчиком: «идёт работа… 3:12»
            без ориентира читается как «зависло», с ним — как «третью часть» */}
        {minutes && !waiting ? <> · машине ≈{minutes} мин</> : null}{" "}
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
      </span>
    </div>
  );
}
