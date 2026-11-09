/**
 * browser-runner: съёмка собранной страницы playwright-core (chromium из кэша).
 * Один прогон даёт и скриншоты 3 брейкпоинтов, и машинные проверки (SPEC §8).
 * Дорожка browser = 1 жёстко: машина 7.8 ГБ RAM, два chromium бьют по памяти.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ChecksResult } from "@builder/shared";

export interface ShootInput {
  dir: string;
  /** абсолютный путь к dist/index.html */
  htmlFile: string;
  round: number;
  breakpoints?: number[];
  /** какие анкоры требовать; отсутствие = не проверять */
  expect?: { cta: boolean; price: boolean; phone: boolean };
  /** red-no-repeat и тому подобное — проверяется вне браузера, здесь только хранилище */
  notes?: string[];
}

const DEFAULT_BREAKPOINTS = [375, 768, 1280];

/** chromium, который реально лежит в кэше: берём самый свежий подходящий. */
export function findChromium(): string | null {
  const env = process.env["BUILDER_CHROMIUM"];
  if (env && fs.existsSync(env)) return env;
  const root = path.join(process.env["HOME"] ?? "~", ".cache", "ms-playwright");
  let versions: string[] = [];
  try {
    versions = fs
      .readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  } catch {
    return null;
  }
  for (const v of versions) {
    for (const rel of [
      ["chrome-linux64", "chrome"],
      ["chrome-linux", "chrome"],
      ["chrome-linux", "headless_shell"],
    ]) {
      const p = path.join(root, v, ...rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function chromiumAvailable(): boolean {
  return findChromium() !== null;
}

/**
 * Измеряет страницу. Никогда не бросает «нет chromium» как fatal:
 * авто-деградация (SPEC §9) — пустые проверки + честная плашка в note.
 */
export async function shoot(input: ShootInput): Promise<ChecksResult> {
  const breakpoints = input.breakpoints ?? DEFAULT_BREAKPOINTS;
  const previewDir = path.join(input.dir, "preview");
  fs.mkdirSync(previewDir, { recursive: true });

  const base: ChecksResult = {
    round: input.round,
    consoleErrors: [],
    overflow: [],
    emptyBlocks: [],
    missingAnchors: [],
    brokenHrefs: [],
    brokenImgs: [],
    lowContrast: [],
    screenshots: [],
    visionUsed: false,
    note: (input.notes ?? []).join(" · "),
  };

  const exe = findChromium();
  if (!exe) {
    base.note = [base.note, "нет chromium в кэше — только проверки сборки"]
      .filter(Boolean)
      .join(" · ");
    return base;
  }

  // playwright-core подгружаем лениво: без него typecheck и режим без браузера живые
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: exe,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--font-render-hinting=none", "--allow-file-access-from-files"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // esbuild (tsx) оборачивает функции в __name(); в странице этого нет → shim
    // через addInitScript: он жив и на page.evaluate, и после goto.
    // Строкой, а не колбэком: сам текст не должен быть транслирован.
    await page.addInitScript("globalThis.__name = globalThis.__name || function (t) { return t; };");
    await page.evaluate("globalThis.__name = globalThis.__name || function (t) { return t; };");
    const consoleErrors = new Set<string>();
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning")
        consoleErrors.add(`${m.type()}: ${m.text()}`.slice(0, 300));
    });
    page.on("pageerror", (e) => consoleErrors.add(`pageerror: ${e.message}`.slice(0, 300)));
    page.on("requestfailed", (r) =>
      consoleErrors.add(`requestfailed: ${shortUrl(r.url())}`.slice(0, 300)),
    );

    const url = `file://${input.htmlFile}`;
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    // даём отработать анимациям появления, иначе скриншоты ниже сгиба пустые
    await autoScroll(page);
    await page.waitForTimeout(400);

    const missing: string[] = [];
    for (const bp of breakpoints) {
      await page.setViewportSize({ width: bp, height: bp === 375 ? 720 : 900 });
      await page.waitForTimeout(250);
      const file = path.join(previewDir, `r${input.round}-${bp}.png`);
      await page.screenshot({ path: file, fullPage: bp === 375 });
      base.screenshots.push({ breakpoint: bp, file });

      const probe = await measure(page, input.expect ?? { cta: true, price: false, phone: false });
      base.consoleErrors = [...consoleErrors];
      if (probe.overflow) base.overflow.push(`${bp}px: ${probe.overflow}`);
      for (const id of probe.missingAnchors) if (!missing.includes(id)) missing.push(id);
      for (const h of probe.brokenHrefs) if (!base.brokenHrefs.includes(h)) base.brokenHrefs.push(h);
      for (const i of probe.brokenImgs) if (!base.brokenImgs.includes(i)) base.brokenImgs.push(i);
      for (const c of probe.lowContrast) if (!base.lowContrast.includes(c)) base.lowContrast.push(c);
      if (bp === 1280) base.emptyBlocks = probe.emptyBlocks;
    }
    base.missingAnchors = missing;
  } finally {
    await browser.close();
  }

  writeChecks(input.dir, base);
  return base;
}

interface PageProbe {
  overflow: string;
  emptyBlocks: string[];
  missingAnchors: string[];
  brokenHrefs: string[];
  brokenImgs: string[];
  lowContrast: string[];
}

async function measure(
  page: import("playwright-core").Page,
  expect: { cta: boolean; price: boolean; phone: boolean },
): Promise<PageProbe> {
  return page.evaluate(
    async (exp: { cta: boolean; price: boolean; phone: boolean }) => {
      const doc = document.documentElement;
      let overflow = "";
      if (doc.scrollWidth > window.innerWidth + 1) {
        const wide: string[] = [];
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const r = el.getBoundingClientRect();
          if (r.right > window.innerWidth + 2 && r.width > 0) {
            wide.push(
              `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${
                el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : ""
              }:${Math.round(r.width)}`,
            );
            if (wide.length >= 4) break;
          }
        }
        overflow = `scrollWidth=${doc.scrollWidth} → ${wide.join(", ") || "?"}`;
      }

      const emptyBlocks: string[] = [];
      for (const sec of Array.from(document.querySelectorAll("section"))) {
        const text = (sec.textContent ?? "").replace(/\s+/g, " ").trim();
        const media = sec.querySelectorAll("img,video,svg,canvas,iframe").length;
        const id = sec.id || sec.className || "section";
        if (text.length < 12 && media === 0) emptyBlocks.push(`#${id}`);
        else {
          for (const box of Array.from(sec.querySelectorAll("img"))) {
            const r = box.getBoundingClientRect();
            if (r.height < 2) emptyBlocks.push(`#${id} img.collapsed`);
          }
        }
      }

      const missingAnchors: string[] = [];
      const hasCta = !!document.querySelector(
        'a[href^="#"], a[href^="tel:"], a[href^="mailto:"], button, .btn, .cta',
      );
      if (exp.cta && !hasCta) missingAnchors.push("cta");
      if (exp.price) {
        // валюта и слова цены на языках наших сборок (en/ru/tr): страница «AED 1,500,
        // Starting from» — с ценами, а русско-символьный regex давал ложный дефект
        // «нет цен», фиксер добавил второй прайс, и начиналась цепочка брака
        const t = document.body.innerText;
        const priceWords =
          /(?:₽|\$|€|£|₸|aed|dhs|usd|eur|try|руб|цена|стоим|price|pricing|rate|package|cost|fee|fiyat)/i;
        if (!priceWords.test(t)) missingAnchors.push("price");
      }
      if (exp.phone && !document.querySelector('a[href^="tel:"]')) missingAnchors.push("phone");

      const brokenHrefs: string[] = [];
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const h = a.getAttribute("href") ?? "";
        if (!h) continue; // пустой href — стоящее исключение серии
        if (h.startsWith("#")) {
          if (h.length > 1 && !document.querySelector(h)) brokenHrefs.push(h);
        } else if (/^assets\/|^\.\.?\//.test(h)) {
          try {
            void new URL(h, document.baseURI);
          } catch {
            brokenHrefs.push(h);
          }
        }
      }

      const brokenImgs: string[] = [];
      for (const im of Array.from(document.images)) {
        if (im.complete && im.naturalWidth === 0) brokenImgs.push(im.getAttribute("src") ?? "?");
      }

      // контраст: тёмный текст на тёмном фоне (включая фото-фоны и оверлеи) —
      // глаз судьи это видит не всегда, а юзер видит сразу; здесь это машинный
      // дефект, который не зависит от настроения vision-модели
      const lowContrast: string[] = [];
      {
        const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const parseCol = (c: string): [number, number, number, number] | null => {
          const m = c.match(/rgba?\((\d+), *(\d+), *(\d+)(?:, *([\d.]+))?\)/);
          return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
        };
        // средняя яркость картинки (hero-фото) через canvas: file:// читаем с
        // --allow-file-access-from-files, canvas не тонтинт при этом
        const imgCache = new Map<string, number>();
        const imgLuma = async (url: string): Promise<number> => {
          if (imgCache.has(url)) return imgCache.get(url)!;
          const v = await new Promise<number>((res) => {
            const im = new Image();
            im.onload = () => {
              try {
                const cv = document.createElement("canvas");
                cv.width = 16;
                cv.height = 16;
                const cx = cv.getContext("2d");
                if (!cx) return res(-1);
                cx.drawImage(im, 0, 0, 16, 16);
                const d = cx.getImageData(0, 0, 16, 16).data;
                let s = 0;
                for (let i = 0; i < d.length; i += 4) s += luma(d[i], d[i + 1], d[i + 2]);
                res(s / (d.length / 4));
              } catch {
                res(-1); // tainted canvas — не гадаем
              }
            };
            im.onerror = () => res(-1);
            im.src = url;
          });
          imgCache.set(url, v);
          return v;
        };
        // фон элемента: непрозрачный цвет, градиент (по средней точке стоп-цветов)
        // или фото; ничего не нашли — идём к родителю
        const bgLuma = async (el: Element): Promise<number> => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const cs = getComputedStyle(e);
            const c = parseCol(cs.backgroundColor);
            if (c && c[3] > 0.9) return luma(c[0], c[1], c[2]);
            const bi = cs.backgroundImage;
            if (bi && bi !== "none") {
              const u = /url\("?([^")]+)"?\)/.exec(bi);
              if (u) {
                const v = await imgLuma(new URL(u[1], document.baseURI).href);
                if (v >= 0) {
                  // затемняющая вуаль поверх фото (linear-gradient с полупрозрачными
                  // тёмными стопами) домешивается к яркости фото по своей альфе
                  const ov = /linear-gradient\(([^)]*)\)/.exec(bi);
                  if (ov) {
                    const stops = [...ov[1].matchAll(/rgba?\((\d+), *(\d+), *(\d+), *([\d.]+)\)/g)]
                      .map((m) => ({ l: luma(+m[1], +m[2], +m[3]), a: +m[4] }))
                      .filter((x) => x.a > 0.15);
                    if (stops.length) {
                      const a = Math.min(1, Math.max(...stops.map((x) => x.a)));
                      const l = stops.reduce((s, x) => s + x.l, 0) / stops.length;
                      return v * (1 - a) + l * a;
                    }
                  }
                  return v;
                }
              }
              const g = /linear-gradient\(([^)]*)\)/.exec(bi);
              if (g) {
                const cols = [...g[1].matchAll(/rgb\((\d+), *(\d+), *(\d+)\)/g)].map((m) => luma(+m[1], +m[2], +m[3]));
                if (cols.length) return cols.reduce((s, x) => s + x, 0) / cols.length;
              }
            }
          }
          return 255;
        };
        for (const t of Array.from(document.querySelectorAll("h1,h2,h3,p,a,button,li,span"))) {
          const txt = (t.textContent ?? "").trim();
          if (txt.length < 3) continue;
          const r = t.getBoundingClientRect();
          if (r.width < 2 || r.height < 8 || r.bottom < 0 || r.top > window.innerHeight * 3) continue;
          const cs = getComputedStyle(t);
          const fg = parseCol(cs.color);
          if (!fg) continue;
          const bg = await bgLuma(t);
          if (bg < 0) continue;
          // разница яркостей меньше 60 (~контраст 2:1 на крайних тонах) — текст
          // тонет в фоне; на светлых парах (#14201B на #F2F7F4) зазор >150
          const d = Math.abs(luma(fg[0], fg[1], fg[2]) - bg);
          if (d < 60) {
            const sel = `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}${t.classList.length ? "." + Array.from(t.classList)[0] : ""}`;
            lowContrast.push(`${sel} «${txt.slice(0, 32)}»`);
            if (lowContrast.length >= 8) break;
          }
        }
      }

      return { overflow, emptyBlocks, missingAnchors, brokenHrefs, brokenImgs, lowContrast };
    },
    expect,
  );
}

/**
 * Прокрутка вниз, чтобы lazy-картинки и appear-анимации сработали до скриншота.
 *
 * Два урока с живых прогонов:
 * · scroll-behavior:smooth у страницы превращал scrollTo в плавный бег: каждый
 *   шаг перезапускал прокрутку, страница оставалась на месте, reveal-анимации
 *   ниже первого экрана не срабатывали и скриншоты выходили пустыми;
 * · requestAnimationFrame в фоновой/невидимой странице притормаживает —
 *   поэтому ждём через setTimeout, а не через кадры.
 */
async function autoScroll(page: import("playwright-core").Page): Promise<void> {
  await page.evaluate(async () => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = "auto";
    // шаг не меньше высоты экрана: иначе один и тот же экран проходится twice,
    // а нижняя часть страницы не доскроллируется до конца
    const stepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      let y = 0;
      for (;;) {
        y += Math.max(1, Math.round(window.innerHeight * 0.9));
        window.scrollTo(0, y);
        await stepMs(120); // IO + CSS-transition успевают отработать
        if (y >= document.body.scrollHeight) break;
      }
      window.scrollTo(0, 0);
      await stepMs(120);
    } finally {
      html.style.scrollBehavior = prev;
    }
  });
  // transition .8s ease: деления появляются не мгновенно после возврата наверх
  await page.waitForTimeout(900);
}

export function writeChecks(dir: string, res: ChecksResult): void {
  const f = path.join(dir, "preview", `checks-r${res.round}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(res, null, 2));
}

function shortUrl(u: string): string {
  return u.replace(/^file:\/\/.*\/(dist|projects)\//, "$1/").slice(0, 200);
}

/**
 * Конвертация растра в webp без нативных зависимостей (ffmpeg есть на машине,
 * cwebp — нет). Режимы больше не различаются: PNG от генератора весит 250–700 КБ,
 * тот же кадр в webp — 40–90 КБ, а мастер-промпт требует «оптимизированный
 * WebP/JPEG» и ширину около 1600 px. maxW кадрирует ширину, height -2 держит
 * чётное значение и пропорции. Нет ffmpeg/сбой → null, оставляем исходник.
 */
export function toWebp(src: string, quality = 78, maxSide = 1600): string | null {
  const dst = src.replace(/\.(png|jpe?g)$/i, ".webp");
  if (dst === src) return src;
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        src,
        // кадрируем ДЛИННУЮ сторону: у вертикальных 3:4 широкая сторона и так
        // меньше 1600, а cap по ширине оставлял портрет 1336×1776 без изменений
        "-vf",
        `scale=${maxSide}:${maxSide}:force_original_aspect_ratio=decrease:flags=lanczos`,
        "-q:v",
        String(quality),
        dst,
      ],
      { timeout: 60_000 },
    );
    return fs.existsSync(dst) ? dst : null;
  } catch {
    return null;
  }
}
