/**
 * Реализации задач прогона (SPEC §6, §8). Каждый помощник:
 *   читает артефакты с диска → один вызов модели/браузера → пишет артефакт.
 * Рестарт прогона пропускает то, что уже лежит на диске с валидным входом.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  Brief,
  ChecksResult,
  Defect,
  ImageArtifact,
  Mode,
  OrchEvent,
  PlanImage,
  PlanPage,
  PlanSection,
  RunManifest,
  SitePlan,
  Verdict,
} from "@builder/shared";
import { saveSettings, settings } from "../config.ts";
import { copyTree, makeZip, rememberDir, resolveDest, type DeliveryChoice } from "../delivery.ts";
import { callImage, imageAvailable } from "../runners/image.ts";
import { shoot as shootPage, toWebp } from "../runners/browser.ts";
import { probeVision } from "../connections/index.ts";
import { resolveLlm } from "../runners/llm.ts";
import { shortHash } from "../prompts/render.ts";
import { callJson, ContractError, type JsonCallResult } from "./llm-json.ts";
import type { RunResult } from "../orchestrator/types.ts";

export interface TasksCtx {
  dir: string;
  mode: Mode;
  brief: Brief;
  plan: SitePlan;
  round: number;
  /** дефекты прошлого вердикта — источник для раунда фиксов */
  defects: Defect[];
  emit: (e: OrchEvent) => void;
  signal: AbortSignal;
  /** этап долгой пост-операции (правка/догенерация) для прогресс-строки UI.
      Живой прогон её не ставит — там этапы и так летят в SSE */
  progress?: (stage: string) => void;
}

interface PageParts {
  html: string;
  css: string;
  js: string;
}

const ASPECT_SIZE: Record<string, [number, number]> = {
  "16:9": [1200, 675],
  "3:4": [900, 1200],
  "1:1": [1000, 1000],
  "9:16": [720, 1280],
  "4:3": [1200, 900],
};

// ─── план ───────────────────────────────────────────────────────────────
export async function plan(ctx: TasksCtx, comment?: string): Promise<RunResult<SitePlan>> {
  const r = await callJson<Partial<SitePlan>>({
    dir: ctx.dir,
    mode: ctx.mode,
    task: "plan",
    role: "plan",
    vars: { brief: ctx.brief },
    signal: ctx.signal,
    // комментарий из gate: правим план, не переписывая промпт вручную
    suffix: comment ? `## Правка по замечанию юзера\n${comment}` : undefined,
    salt: comment ? shortHash(comment) : undefined,
  });
  const plan = normalizePlan(r.value, ctx);
  writeJson(path.join(ctx.dir, "site-plan.json"), plan);
  return {
    ok: true,
    value: plan,
    artifact: "site-plan.json",
    inputHash: shortHash(JSON.stringify({ brief: ctx.brief, model: r.model })),
    usage: r.usage,
  };
}

/** Приводит ответ модели к SitePlan и проверяет контракт slug'ов. */
export function normalizePlan(raw: Partial<SitePlan>, ctx: TasksCtx): SitePlan {
  const sections = (raw.sections ?? [])
    .filter((s) => s && typeof s.slug === "string" && typeof s.type === "string")
    .map((s, i) => ({
      type: s.type.trim(),
      heading: (s.heading ?? s.slug).trim(),
      slug: slugify(s.slug, `sec-${i + 1}`),
      notes: typeof s.notes === "string" ? s.notes.trim() : undefined,
    }));
  if (!sections.length) throw new ContractError("план без секций: sections пуст или кривой");

  const slugs = new Set<string>();
  for (const s of sections) {
    if (slugs.has(s.slug)) throw new ContractError(`план: дублирующийся slug секции «${s.slug}»`);
    slugs.add(s.slug);
  }

  const images = (raw.images ?? [])
    .filter((im) => im && typeof im.slug === "string")
    .map((im) => ({
      slug: slugify(im.slug, "img"),
      description: (im.description ?? "").trim(),
      aspect: normAspect(im.aspect),
      role: normRole(im.role),
      page:
        typeof im.page === "string" && im.page.trim() && im.page.trim().toLowerCase() !== "index"
          ? slugify(im.page, "page").toLowerCase()
          : undefined,
    }));
  const seen = new Set<string>();
  for (const im of images) {
    if (seen.has(im.slug)) throw new ContractError(`план: дублирующийся slug картинки «${im.slug}»`);
    seen.add(im.slug);
    if (!im.description) throw new ContractError(`план: у картинки «${im.slug}» нет description`);
  }

  // вложенные страницы: только то, что реально обещано брифом. Модель могла
  // вернуть pages при pageCount=1 (мусор) или наоборот забыть часть —
  // нормализуем по канону серии, а не по наитию модели
  const wantPages = innerPageSlots(ctx.brief);
  const rawPages = new Map<string, Partial<PlanPage>>();
  for (const pg of raw.pages ?? []) {
    if (!pg || typeof pg.slug !== "string") continue;
    const slug = slugify(pg.slug, "page").toLowerCase();
    if (slug && slug !== "index" && !rawPages.has(slug)) rawPages.set(slug, pg);
  }
  let pages: PlanPage[] | undefined;
  if (wantPages.length) {
    // совпавшие с каноном страницы берём как есть; недостающие — с секциями
    // из canonicalPageSections (модель часто возвращает только имена)
    const picked = wantPages.map((slug) => {
      const hit = rawPages.get(slug);
      const secs = (hit?.sections ?? [])
        .filter((s) => s && typeof s.slug === "string")
        .map((s, i) => ({
          type: (s.type ?? slug).trim(),
          heading: (s.heading ?? s.slug).trim(),
          slug: slugify(s.slug, `${slug}-sec-${i + 1}`),
          notes: typeof s.notes === "string" ? s.notes.trim() : undefined,
        }));
      return {
        slug,
        heading: (hit?.heading ?? innerPageTitle(slug)).trim(),
        sections: secs.length ? secs : canonicalPageSections(slug),
      };
    });
    // секции и картинки должны быть уникальны на весь сайт: секции страниц
    // переносим из main, если модель продублировала их в sections главной
    const mainSeen = new Set(sections.map((s) => s.slug));
    for (const pg of picked)
      for (const s of pg.sections) {
        if (mainSeen.has(s.slug)) s.slug = `${pg.slug}-${s.slug}`;
        mainSeen.add(s.slug);
      }
    pages = picked;
  }

  const palette: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.palette ?? {}))
    if (typeof v === "string" && /^#([0-9a-f]{3,8})$/i.test(v.trim())) palette[k] = v.trim().toUpperCase();
  const briefRed = "redHex" in ctx.brief ? ctx.brief.redHex : undefined;
  if (briefRed) palette.red = briefRed.toUpperCase();
  if (!palette.bg) palette.bg = ctx.mode === "black" ? "#0B0B0D" : "#FFFFFF";
  if (!palette.text) palette.text = ctx.mode === "black" ? "#F2F3F5" : "#14161A";

  const hardRules = (raw.hardRules ?? []).filter((r) => typeof r === "string" && r.trim());
  // просьба юзера — первым правилом и с самой высокой приоритетной формулировкой:
  // её модель обязана выполнить, иначе смысл шлюза теряется и проект перегоняют
  const wish = (ctx.brief.wishes ?? "").trim();
  if (wish)
    hardRules.unshift(`Пожелание заказчика (обязательно к исполнению): ${wish}`);
  hardRules.push(...seriesRules(ctx.mode, ctx.brief));

  return {
    version: 1,
    briefHash: shortHash(JSON.stringify(ctx.brief)),
    planHash: "",
    sections,
    palette,
    fonts: {
      heading: raw.fonts?.heading?.trim() || "Manrope",
      body: raw.fonts?.body?.trim() || "Inter",
    },
    images,
    pages,
    copyFormula: typeof raw.copyFormula === "string" ? raw.copyFormula.trim() : undefined,
    hardRules: [...new Set(hardRules)],
  };
}

/**
 * Канон страниц по мастер-промпту (§3.1 постоянное ядро): pageCount считает
 * вариативные страницы (about, contact, services…), а юридическое ядро
 * policy/terms/thanks доезжает по умолчанию при ЛЮБОМ pageCount > 1 — так
 * футер всегда ведёт в реальные страницы, как в эталонных вайтах серии.
 * Одностраничник — без ядра: ссылок Policy/Terms в нём нет.
 * thanks прикладывает всегда: форма есть и на коротком сайте, вести её
 * после отправки некуда без этой страницы.
 */
export function innerPageSlots(brief: Brief): string[] {
  const n = "pageCount" in brief ? Number(brief.pageCount ?? 1) : 1;
  if (n <= 1) return [];
  const VARIABLE = ["about", "contact", "services", "faq", "team"];
  const slots = VARIABLE.slice(0, n - 1);
  const infra = ["contact", "thanks", "policy", "terms"];
  return [...new Set([...slots, ...infra])];
}

function innerPageTitle(slug: string): string {
  return (
    {
      services: "Services",
      about: "About",
      contact: "Contact",
      faq: "Questions",
      team: "Team",
      policy: "Privacy Policy",
      terms: "Terms of Use",
      thanks: "Thank you",
    }[slug] ?? slug
  );
}

/** Каркас секций вложенной страницы, когда модель вернула только имя. */
function canonicalPageSections(slug: string): PlanPage["sections"] {
  const S = (type: string, heading: string): PlanPage["sections"][number] => ({
    type,
    heading,
    slug: `${slug}-${type}`,
  });
  switch (slug) {
    case "services":
      return [S("services-hero", "What we do"), S("services-grid", "Services"), S("services-process", "How it works"), S("services-cta", "Get started")];
    case "about":
      return [S("about-hero", "About us"), S("about-story", "Our story"), S("about-values", "Values"), S("about-cta", "Come over")];
    case "faq":
      return [S("faq-hero", "Questions"), S("faq-list", "Everything asked"), S("faq-cta", "Ask us")];
    case "team":
      return [S("team-hero", "Our team"), S("team-proof", "Reviews"), S("team-cta", "Join us")];
    case "contact":
      return [S("contact-hero", "Contact us"), S("contact-form", "Send a message")];
    case "policy":
    case "terms":
      // юридическая страница: не менее 10 смысловых разделов (мастер-промпт §8)
      return Array.from({ length: 10 }, (_, i) => S(`${slug}-section`, `${slug === "policy" ? "Privacy" : "Terms"} clause ${i + 1}`));
    case "thanks":
      return [S("thanks-note", "Thank you")];
    default:
      return [S("hero", "Contacts"), S("cta", "Get in touch")];
  }
}

/** Все страницы одной итерации: главная первой, затем вложенные. */
export function planPages(plan: SitePlan): Array<{ slug: string; heading: string; sections: PlanSection[]; images: PlanImage[] }> {
  const main = { slug: "index", heading: plan.sections[0]?.heading ?? "", sections: plan.sections, images: plan.images.filter((i) => !i.page) };
  const inner = (plan.pages ?? []).map((pg) => ({
    slug: pg.slug,
    heading: pg.heading,
    sections: pg.sections,
    images: plan.images.filter((i) => i.page === pg.slug),
  }));
  return [main, ...inner];
}

/** planHash пересчитывается при любой правке плана (в т.ч. из UI). */
export function withPlanHash(p: SitePlan): SitePlan {
  const copy: SitePlan = { ...p, planHash: "" };
  return { ...copy, planHash: shortHash(JSON.stringify({ ...copy, planHash: "" })) };
}

function seriesRules(mode: Mode, brief: Brief): string[] {
  if (mode === "black") {
    const red = "redHex" in brief ? brief.redHex : "";
    return [
      "Чёрная серия: тёмный фон, единственный красный акцент, без Privacy/Terms, футер в одну строку.",
      "Все растровые картинки — webp.",
      "Каждая CTA с data-track=\"cta\".",
      ...(red ? [`Красный акцент = ${red} (из Brief), других красных оттенков нет.`] : []),
    ];
  }
  const city = "city" in brief ? brief.city : "";
  const rules = [
    "Серия whites = качество, а не цвет: много воздуха, один акцент, читаемая типографика. Фон — из выбранной пары Brief: светлая пара → светлый сайт, тёмная пара → тёмный.",
    ...(city ? [`Город и контакты — строго из Brief: ${city}.`] : []),
  ];
  if ("heroMotion" in brief && brief.heroMotion === "video")
    rules.push("Hero-секция: видеон (видео или canvas-фон) на всю ширину, без автоплея звука,poster из картинок плана.");
  if ("heroMotion" in brief && brief.heroMotion === "static")
    rules.push("Hero-секция: статичная картинка/композиция, без фоновых видео.");
  // геометрия hero — поле юзера, а не вкус модели: full растягивает первый экран
  // до краёв окна, container оставляет его в общей колонке страницы
  if ("heroWidth" in brief && brief.heroWidth === "full")
    rules.push(
      "Hero на всю ширину окна: контент секции растянут от края до края (без общего .container), фон/картинка без боковых полей.",
    );
  if ("heroWidth" in brief && brief.heroWidth === "container")
    rules.push(
      "Hero в контейнере страницы: контент секции в том же .container (--maxw), что и остальные секции; на всю ширину не растягивать.",
    );
  // тематика: пресет или своя («рыбалка») — в правила идёт niche, он точнее:
  // для "other" это текст юзера, для остальных — человекочитаемая подпись
  const niche = "niche" in brief ? String(brief.niche ?? "").trim() : "";
  const theme = "theme" in brief ? String(brief.theme ?? "") : "";
  if (niche && (theme !== "other" || niche !== "другое"))
    rules.push(`Тематика сайта: ${niche}. Выдерживать её в подборе картинок и текстов.`);
  if ("pageCount" in brief && brief.pageCount && brief.pageCount > 1) {
    const inner = innerPageSlots(brief);
    rules.push(
      `Страницы сайта: index (главная) + ${inner.map((p) => p + "/").join(", ")}. Ссылки навигации — каталожные, без .html: href="about/", href="../about/" (для вложенных страниц).`,
    );
    rules.push("Постоянное ядро: одинаковые Header/Footer на всех страницах, в футере телефон, email с классом js-dynamic-email, адрес, ссылки Policy и Terms; страница Thanks короткая, без ложного утверждения о доставке письма.");
  }
  return rules;
}

// ─── тексты ─────────────────────────────────────────────────────────────
/**
 * Тексты одной страницы (pageSlug: "index" = главная). Каждая страница —
 * свой вызов модели: задачи идут параллельно в llm-дорожках, суммарно
 * многостраничник стоит почти столько же, сколько одна страница.
 */
export async function copyPage(ctx: TasksCtx, pageSlug = "index"): Promise<RunResult> {
  const page = planPages(ctx.plan).find((pg) => pg.slug === pageSlug);
  if (!page) return { ok: false, error: { klass: "fatal", message: `страницы «${pageSlug}» нет в плане` } };
  const planView = { ...ctx.plan, sections: page.sections, images: page.images, pages: undefined };
  const r = await callJson<Record<string, unknown>>({
    dir: ctx.dir,
    mode: ctx.mode,
    task: "copy",
    role: "copy",
    vars: { plan: planView, brief: ctx.brief },
    signal: ctx.signal,
    salt: pageSlug === "index" ? undefined : pageSlug,
  });
  const value = normalizeCopy(r.value, { ...ctx.plan, sections: page.sections });
  const artifact = pageSlug === "index" ? "copy.json" : `copy-${pageSlug}.json`;
  writeJson(path.join(ctx.dir, artifact), value);
  return { ok: true, value, artifact, usage: r.usage };
}

export async function copy(ctx: TasksCtx): Promise<RunResult> {
  return copyPage(ctx, "index");
}

/** Убирает slug'ов, которых нет в плане, и дополняет пропущенные заголовком плана. */
function normalizeCopy(raw: Record<string, unknown>, plan: SitePlan) {
  const slugs = new Set(plan.sections.map((s) => s.slug));
  const src = (raw ?? {}) as Record<string, unknown>;
  const sections: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "meta") continue;
    if (slugs.has(k)) sections[k] = v;
  }
  for (const s of plan.sections)
    if (!sections[s.slug]) sections[s.slug] = { heading: s.heading, bullets: [] };
  return {
    meta: (src.meta as Record<string, unknown>) ?? {
      title: plan.sections[0]?.heading ?? "",
      description: "",
    },
    sections,
  };
}

// ─── промпты картинок ───────────────────────────────────────────────────
export async function imagePrompts(ctx: TasksCtx): Promise<RunResult> {
  if (!ctx.plan.images.length) return { ok: true, value: {}, artifact: "image-prompts.json" };
  const r = await callJson<{ images?: Array<{ slug: string; prompt?: string; negative?: string }> }>(
    {
      dir: ctx.dir,
      mode: ctx.mode,
      task: "image-prompts",
      role: "copy",
      vars: { plan: ctx.plan, brief: ctx.brief },
      signal: ctx.signal,
    },
  );
  const map: Record<string, { prompt: string; negative?: string }> = {};
  for (const im of r.value?.images ?? []) {
    if (!im || typeof im.slug !== "string") continue;
    const slug = slugify(im.slug, "img");
    if (typeof im.prompt === "string" && im.prompt.trim())
      map[slug] = { prompt: im.prompt.trim(), negative: im.negative };
  }
  for (const im of ctx.plan.images)
    if (!map[im.slug]) map[im.slug] = { prompt: im.description };
  writeJson(path.join(ctx.dir, "image-prompts.json"), map);
  return { ok: true, value: map, artifact: "image-prompts.json", usage: r.usage };
}

// ─── одна картинка по slug ──────────────────────────────────────────────
export async function image(ctx: TasksCtx, slug: string): Promise<RunResult<string>> {
  const planned = ctx.plan.images.find((i) => i.slug === slug);
  if (!planned) return { ok: false, error: { klass: "fatal", message: `картинки «${slug}» нет в плане` } };

  const prompts =
    readJson<Record<string, { prompt?: string; negative?: string }>>(
      path.join(ctx.dir, "image-prompts.json"),
    ) ?? {};
  const s = settings();
  const outFile = path.join(ctx.dir, "assets", "img", `${slug}.png`);

  if (s.selection.imageMode === "manual") {
    const existing = findAsset(ctx.dir, slug);
    const file = existing ?? outFile;
    setArtifact(ctx, {
      slug,
      file: rel(ctx.dir, file),
      status: existing ? "manual" : "placeholder",
      error: existing ? undefined : `нет файла assets/img/${slug}.* — режим «свои фото»`,
    });
    ctx.emit(slot(slug, existing ? "manual" : "placeholder"));
    return { ok: true, value: rel(ctx.dir, file) };
  }

  if (s.selection.imageMode === "none") {
    const file = placeholder(ctx, slug, planned.aspect);
    setArtifact(ctx, { slug, file: rel(ctx.dir, file), status: "placeholder" });
    ctx.emit(slot(slug, "placeholder"));
    return { ok: true, value: rel(ctx.dir, file) };
  }

  // восстановление после падения: картинка slug уже лежит на диске и манифест
  // помечает её done — на перезапуске прогона она не перегенерируется заново
  const manifest0 = readJson<RunManifest>(path.join(ctx.dir, "manifest.json"));
  if (manifest0?.images?.some((i) => i.slug === slug && i.status === "done")) {
    const stored = findAsset(ctx.dir, slug);
    if (stored) {
      const file = rel(ctx.dir, stored);
      ctx.emit(slot(slug, "done"));
      return { ok: true, value: file, artifact: file };
    }
  }

  // нет image-подключения/ключа → не стопорим основную модель: сразу плейсхолдер
  if (!imageAvailable()) {
    markImagesDegraded(ctx, "нет image-подключения или режима api");
    const file = placeholder(ctx, slug, planned.aspect);
    setArtifact(ctx, { slug, file: rel(ctx.dir, file), status: "placeholder", error: "графика недоступна" });
    ctx.emit(slot(slug, "placeholder"));
    return { ok: true, value: rel(ctx.dir, file) };
  }

  const negative = prompts[slug]?.negative;
  const prompt = [prompts[slug]?.prompt ?? planned.description, negative ? `no: ${negative}` : ""]
    .filter(Boolean)
    .join(". ");

  try {
    // сетевой сбой картинки — НЕ повод сдаваться с первого раза: на прошлой
    // генерации один «fetch failed» оставил все девять картинок заглушками, а
    // чинить их потом = заново жечь токены. Три попытки с паузами, и только
    // потом честный плейсхолдер
    let r: Awaited<ReturnType<typeof callImage>> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await callImage({ prompt, aspect: planned.aspect, outFile }, ctx.signal);
        break;
      } catch (err) {
        lastErr = err;
        const klass = (err as { klass?: string }).klass;
        // квота/нет ключа/нет модели — повторять бессмысленно
        if (klass !== "transport" || ctx.signal.aborted) throw err;
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    if (!r) throw lastErr;
    let final = r.file;
    // webp для обоих режимов: PNG от генератора весит 250–700 КБ, тот же кадр
    // в webp — 40–90 КБ (проверено на white_001), а на странице их 8–9.
    // Конвертат не нашёлся → честно остаёмся на исходнике
    if (/\.(png|jpe?g)$/i.test(final)) {
      const webp = toWebp(final);
      if (webp && webp !== final) {
        fs.rmSync(final, { force: true });
        final = webp;
      }
    }
    const file = rel(ctx.dir, final);
    // старый svg-плейсхолдер того же slug больше не нужен: он оставался в
    // assets/ и попадал в экспорт второй копией той же картинки
    if (!/\.svg$/i.test(final)) {
      const stale = path.join(ctx.dir, "assets", "img", `${slug}.svg`);
      if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
    }
    setArtifact(ctx, { slug, file, status: "done", connectionId: r.connectionId });
    ctx.emit(slot(slug, "done"));
    return { ok: true, value: file, artifact: file };
  } catch (err) {
    // SPEC §6: картинка не валит прогон — плейсхолдер в палитре + честный статус
    markImagesDegraded(ctx, (err as Error).message);
    const file = placeholder(ctx, slug, planned.aspect);
    const message = (err as Error).message;
    setArtifact(ctx, {
      slug,
      file: rel(ctx.dir, file),
      // транспортный сбой = «failed», а не «placeholder»: «Догенерить картинки»
      // берёт именно failed/placeholder, и по статусу видно, что пробовать стоит
      status: /429|квот/i.test(message) ? "failed" : /fetch|network|таймаут|timeout/i.test(message) ? "failed" : "placeholder",
      error: message,
    });
    ctx.emit(slot(slug, "placeholder"));
    return { ok: true, value: rel(ctx.dir, file), artifact: rel(ctx.dir, file) };
  }
}

// ─── код страницы ───────────────────────────────────────────────────────
/**
 * HTML одной страницы. Главная ("index") возвращает и css/js — они становятся
 * общим дизайном сайта; вложенные страницы получают только html и одеваются
 * в тот же css на сборке (быстрее и дизайн не разъезжается).
 */
export async function codePage(ctx: TasksCtx, pageSlug = "index"): Promise<RunResult<PageParts>> {
  const page = planPages(ctx.plan).find((pg) => pg.slug === pageSlug);
  if (!page) return { ok: false, error: { klass: "fatal", message: `страницы «${pageSlug}» нет в плане` } };
  const copyName = pageSlug === "index" ? "copy.json" : `copy-${pageSlug}.json`;
  const copyDoc = readJson<Record<string, unknown>>(path.join(ctx.dir, copyName));
  if (!copyDoc) return { ok: false, error: { klass: "fatal", message: `нет ${copyName} — сборка текстов не прошла` } };

  const images = page.images.map((im) => ({
    slug: im.slug,
    path: `assets/img/${im.slug}.img`,
    role: im.role,
    aspect: im.aspect,
  }));
  // ссылки навигации: все страницы сайта знает только план — отдаём модели
  const siblings = planPages(ctx.plan).map((pg) => (pg.slug === "index" ? "./" : `${pg.slug}/`));
  const planView = { ...ctx.plan, sections: page.sections, images: page.images, pages: undefined };
  const r = await callJson<Partial<PageParts>>({
    dir: ctx.dir,
    mode: ctx.mode,
    task: "page-code",
    role: "code",
    vars: { plan: planView, copy: copyDoc, images },
    signal: ctx.signal,
    salt: pageSlug === "index" ? undefined : pageSlug,
    suffix:
      pageSlug === "index"
        ? siblings.length > 1
          ? `## Навигация\nМеню сайта ведёт на страницы: ${siblings.join(", ")} (каталожные ссылки, без .html: href="about/"). Карточки pricing/faq с CTA ведут на services/ и faq/. Email в футере — <a class="js-dynamic-email">. На главной — форма или CTA, ведущая на contact/.`
          : undefined
        : pageSlug === "contact"
          ? `## Страница Contact\nТы собираешь contact/ (H1: ${page.heading}). Верни только "html" (css/js — пустые строки): телефон, email с классом js-dynamic-email, адрес и форма: имя+email обязательны, checkbox согласия со ссылкой policy/, ошибки через aria-describedby. Отправку и переход на ../thanks/ обработает общий script.js генератора — своей отправки не пиши. Ссылки: ../about/, ../policy/.`
          : pageSlug === "thanks"
            ? `## Страница Thanks\nТы собираешь thanks/ (короткая). Верни только "html" (css/js — пустые строки): знак статуса, заголовок, 1–2 действия (на главную "../" и в contact/). Не утверждай, что письмо реально доставлено.`
            : `## Вложенная страница\nТы собираешь страницу ${pageSlug}/ (H1: ${page.heading}). Верни только "html" — css/js вернутся с главной и подключатся сами; "css" и "js" оставь пустыми строками. Шапка с меню: активен пункт ${pageSlug}/, ссылка на главную — ../ (для вложенных). Сохрани дизайн-язык светлой серии из плана.`,
  });
  const html = (r.value?.html ?? "").trim();
  const css = (r.value?.css ?? "").trim();
  const js = (r.value?.js ?? "").trim();
  if (!html) throw new ContractError("page-code вернул пустой html");
  if (!/<!doctype html/i.test(html))
    throw new ContractError("page-code: html без <!doctype html>");
  const artifact = pageSlug === "index" ? "build/page.json" : `build/page-${pageSlug}.json`;
  writeJson(path.join(ctx.dir, "build", pageSlug === "index" ? "page.json" : `page-${pageSlug}.json`), {
    html,
    css,
    js,
  });
  return { ok: true, value: { html, css, js }, artifact, usage: r.usage };
}

export async function code(ctx: TasksCtx): Promise<RunResult<PageParts>> {
  return codePage(ctx, "index");
}

// ─── сборка dist/*.html (главная + вложенные) ───────────────────────────
export async function assemble(ctx: TasksCtx): Promise<RunResult<string>> {
  const page = readJson<PageParts>(path.join(ctx.dir, "build", "page.json"));
  if (!page) return { ok: false, error: { klass: "fatal", message: "нет build/page.json" } };

  const overridesCss = readText(path.join(ctx.dir, "overrides.css"));
  const overridesHtml = readText(path.join(ctx.dir, "overrides.html"));

  // Страховка поверх CSS модели: `[hidden] { display: none !important }`.
  // Модель ставит на скрытый элемент display (типично — `display:flex` на
  // cookie-плашке) и класс перебивает браузерное `[hidden]{display:none}`:
  // JS отработал, атрибут стоит, а плашка висит на экране — юзер читает это
  // как «кнопка не срабатывает» (проверено на white_001: клик писал
  // localStorage и hidden=true, а .cookie-banner оставался видимым)
  let css = `[hidden] { display: none !important; }\n${page.css}`;
  for (let r = 1; r <= ctx.round; r++) {
    const patch = readText(path.join(ctx.dir, "build", `fix-r${r}.css`));
    if (patch) css += `\n/* ── фиксы раунда ${r} ── */\n${patch}`;
  }
  if (overridesCss) css += `\n/* ── overrides.css (ручные правки, оркестратор не трогает) ── */\n${overridesCss}`;

  let html = page.html;

  // 0. патчи фиксов этого раунда — до вставки css/js, чтобы они попали в страницу
  // 1. подмена путей картинок: модель пишет assets/img/<slug>.img, файл — .png/.webp/.svg
  const manifest = readJson<{ images?: ImageArtifact[] }>(path.join(ctx.dir, "manifest.json"));
  const files = new Map<string, string>();
  for (const im of manifest?.images ?? []) if (im.file) files.set(im.slug, im.file);
  for (const im of ctx.plan.images) {
    const real = files.get(im.slug) ?? findAsset(ctx.dir, im.slug);
    const from = new RegExp(`assets/(img/)?${im.slug}\\.(img|png|jpe?g|webp|svg)`, "gi");
    html = html.replace(from, real ? real.replace(/\\/g, "/") : `assets/img/${im.slug}.svg`);
  }
  // модели пишут имя файла от себя («hero.jpg» вместо hero-doctor-patient.png):
  // относительный src без папки, чей корень похож на слаг сгенерённой картинки,
  // подменяется на реальный файл — иначе сайт выходит со сломанными картинками
  // (в прогоне-прецеденте модель звала «dist/assets/img/x.jpg» — корень сайта
  // в dist и так лежит, префикс срезаем до подмены)
  html = html.replace(/(["'(])dist\/assets\//g, "$1assets/");
  const srcImg = path.join(ctx.dir, "assets", "img");
  html = remapLooseImgs(html, srcImg);

  // 2. inline CSS/JS: локальные <link> и <script src> модели нам не нужны
  html = html.replace(/<link\b[^>]*\bhref=["'][^"']*(\.css)["'][^>]*>/gi, "");
  html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, "");
  html = insertIntoHead(html, `<style>\n${css}\n</style>`);
  html = insertJsIntoBody(html, page.js);

  // 3. ручные правки и патчи фиксов — в конец body, overrides не переписывать.
  // оба прогоняются через remapLooseImgs: фикс вставляет свои <img> с именами
  // из головы модели (gallery-waterfront.jpg), а remap шага 1 к ним уже не
  // применялся — так рождались «битые картинки», которые фиксер чинить не умеет
  // Дедуп перед вставкой: патч дописывается в конец body, и без вырезания
  // старой копии «заменить футер» давал ВТОРОЙ футер под первым — юзер не
  // видел изменений, они лежали дублем за сгибом (white_001 жил с двумя
  // футерами, «правок нет» при applied:1). Правила: (а) блок с тем же id —
  // старая убирается; (б) <footer>/<header> в патче ЗАМЕЩАЕТ базовый: у
  // футера id обычно нет, а футеров на странице обязано быть ровно один
  /**
   * Схлопнуть ДУБЛИ ВНУТРИ патча: overrides.html — это список раундов,
   * каждая правка футера дописывает свой <footer>, и без этого в сборке
   * жило по футеру на каждую правку (замер: 2 футера после двух правок),
   * последний лежал ПОД старым — «правки нет, даже после F5». Оставается
   * ПОСЛЕДНЕЕ вхождение (свежая правка), ранние вырезаются. Те же правила,
   * что у dedupeOld, но применяются внутри патча, а не к базовой странице.
   */
  const collapsePatch = (patch: string): string => {
    let out = patch;
    // по id: тот же id в двух раундах → ранний уходит
    const ids = [...out.matchAll(/<(section|div|footer|header|nav)[^>]*\bid="([\w-]+)"/g)];
    for (const [, tag, id] of new Set(ids.map((m) => `${m[1]}|#${m[2]}`))) {
      const re = new RegExp(`<${tag}[^>]*\bid="${id}"[\\s\\S]*?</${tag}>\\s*`, "gi");
      const hits = [...out.matchAll(re)];
      if (hits.length < 2) continue;
      // вырезаем все, КРОМЕ последнего
      for (const h of hits.slice(0, -1)) out = out.replace(h[0], "");
    }
    // без id: футер на страницу один — в патче тоже остаётся последний
    for (const tag of ["footer"] as const) {
      const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>\\s*`, "gi");
      const hits = [...out.matchAll(re)];
      if (hits.length < 2) continue;
      for (const h of hits.slice(0, -1)) out = out.replace(h[0], "");
    }
    return out;
  };
  const dedupeOld = (patch: string): void => {
    for (const m of patch.matchAll(/<(section|div|footer|header|nav)[^>]*\bid="([\w-]+)"/g)) {
      const [, tag, id] = m;
      html = html.replace(new RegExp(`<${tag}[^>]*\bid="${id}"[\\s\\S]*?</${tag}>\\s*`, "i"), "");
    }
    // (б) футер на странице ровно один, поэтому <footer> в патче ЗАМЕЩАЕТ
    //    базовый: у футера чаще всего нет id, по id его не найти
    if (/<footer[\s>]/i.test(patch))
      html = html.replace(/<footer[\s>][\s\S]*?<\/footer>\s*/i, "");
    // (в) <header> трогать осторожнее: в вёрстке серии это ещё и заголовки
    //    секций (sec-head), их сносить нельзя. Заменяем только шапку с тем же
    //    class, что принёс патч («site-header» → «site-header»)
    for (const m of patch.matchAll(/<header[^>]*\bclass="([^"]+)"/g)) {
      const cls = m[1].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(
        new RegExp(`<header[^>]*\\bclass="${cls}"[\\s\\S]*?</header>\\s*`, "i"),
        "",
      );
    }
  };
  if (overridesHtml) {
    const ovr = collapsePatch(remapLooseImgs(overridesHtml, srcImg));
    dedupeOld(ovr);
    html = insertBeforeClose(html, "body", `\n${ovr}\n`);
  }
  const fixHtmlRaw = readText(path.join(ctx.dir, "build", `fix-r${ctx.round}.html`));
  const fixHtml = fixHtmlRaw ? collapsePatch(remapLooseImgs(fixHtmlRaw, srcImg)) : "";
  if (fixHtml) {
    // фикс дописывает секцию в конец body; если секция с таким id уже есть —
    // старая удаляется, иначе фикс «добавить цены» рождал второй прайс и
    // judge законно приносил дефект «дубль», сжигая раунды и токены
    dedupeOld(fixHtml);
    html = insertBeforeClose(html, "body", `\n<!-- дописано фиксом r${ctx.round} -->\n${fixHtml}\n`);
  }

  const distDir = path.join(ctx.dir, "dist");
  // Замена картинок: CSS НЕ может поменять src <img> (модель «заменяла» их
  // background-color — «готово», а пиксель тот же). Поле swaps из ответа
  // фиксера сборка выполняет детерминированно: N-е вхождение файла from -> to,
  // to валидирован по диску ещё на записи. which: 0 = все вхождения
  const swaps =
    readJson<Array<{ roundId?: string; from: string; to: string; which: number }>>(
      path.join(ctx.dir, "img-swaps.json"),
    ) ?? [];
  for (const sw of swaps) {
    if (!sw?.from || !sw?.to) continue;
    // «to» обязано лежать на диске: выдуманное имя = битая картинка вместо
    // дубля (тот же брак, что выдуманные src в html-патче)
    if (!fs.existsSync(path.join(srcImg, sw.to))) continue;
    let n = 0;
    // совпадение снисходительное, как у remapLooseImgs: модель зовёт
    // `gallery-metro.jpg`, а на диске и в src — `gallery-metro.webp`; без
    // совпадения по ОСНОВЕ имени (до расширения) swaps-раунды молча
    // не попадали и раунд честно возвращал «собранный файл не изменился»
    const stem = (f: string) => f.replace(/\.[\w]+$/, "").toLowerCase();
    const fromStem = stem(sw.from);
    const hit = (src: string) => {
      const b = src.split(/[\\/]/).pop() ?? src;
      return b.toLowerCase().includes(sw.from.toLowerCase()) || stem(b) === fromStem;
    };
    html = html.replace(/<img[^>]*\bsrc="([^"]*)"/g, (m0, src: string) => {
      if (!hit(src)) return m0;
      n += 1;
      if (sw.which !== 0 && n !== sw.which) return m0;
      return m0.replace(src, src.replace(/[^/"\\]+$/, sw.to));
    });
  }
  const distImg = path.join(distDir, "assets", "img");
  // dist/assets/img чистится ПЕРЕД копированием: после перевыпуска картинки в
  // другой формат (png → webp) старая копия жила в dist вечно и уезжала в
  // экспорт, удваивая вес сайта при битых ссылках ровно ноль
  fs.rmSync(distImg, { recursive: true, force: true });
  fs.mkdirSync(distImg, { recursive: true });
  if (fs.existsSync(srcImg))
    for (const f of fs.readdirSync(srcImg))
      fs.copyFileSync(path.join(srcImg, f), path.join(distImg, f));

  const out = path.join(distDir, "index.html");
  // Слаг страницы считается построенным только если модель вернула её части:
  // иначе ссылка `./about/` вела бы в 404, а план обещал страницу. Список нужен
  // и главной (переписать `/about/` на `./about/`), и вложенным.
  const pageSlugs = (ctx.plan.pages ?? [])
    .map((p) => p.slug)
    .filter((pg) => readJson<PageParts>(path.join(ctx.dir, "build", `page-${pg}.json`))?.html);
  fs.writeFileSync(out, previewLinks(html, { distDir, built: pageSlugs, depth: 0 }));

  // вложенные страницы: тот же css/js (дизайн общий), свои фиксы css уже в css
  const written = [rel(ctx.dir, out)];
  for (const pg of pageSlugs) {    const sub = readJson<PageParts>(path.join(ctx.dir, "build", `page-${pg}.json`));
    if (!sub?.html) continue;
    let subHtml = sub.html;
    for (const im of ctx.plan.images) {
      const real = files.get(im.slug) ?? findAsset(ctx.dir, im.slug);
      const from = new RegExp(`assets/(img/)?${im.slug}\\.(img|png|jpe?g|webp|svg)`, "gi");
      subHtml = subHtml.replace(from, real ? real.replace(/\\/g, "/") : `assets/img/${im.slug}.svg`);
    }
    subHtml = subHtml.split("dist/assets/").join("assets/");
    subHtml = remapLooseImgs(subHtml, path.join(ctx.dir, "assets", "img"));
    // вложенная страница лежит в dist/<slug>/index.html (каталожная структура,
    // как в мастере §7 и в экспорте) — её пути к общим ресурсам поднимаются
    // на уровень: иначе превью генератора давало 404 на img и css с подстраниц
    subHtml = subHtml
      .replace(/\b(src|href)="(assets\/)/g, '$1="../$2')
      .replace(/href="\.\/"/g, 'href="../"')
      .replace(/href="index\.html"/g, 'href="../"');
    // ссылка на соседнюю страницу из вложенной: about/ → ../about/
    for (const other of (ctx.plan.pages ?? []).map((p) => p.slug))
      subHtml = subHtml.replace(new RegExp(`href="(${other})/"`, "g"), `href="../$1/"`);
    subHtml = subHtml.replace(/<link\b[^>]*\bhref=["'][^"']*(\.css)["'][^>]*>/gi, "");
    subHtml = subHtml.replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, "");
    subHtml = insertIntoHead(subHtml, `<style>\n${css}\n</style>`);
    subHtml = insertJsIntoBody(subHtml, page.js);
    const subDir = path.join(distDir, pg);
    fs.mkdirSync(subDir, { recursive: true });
    const subOut = path.join(subDir, "index.html");
    fs.writeFileSync(subOut, previewLinks(subHtml, { distDir, built: pageSlugs, depth: 1 }));
    written.push(rel(ctx.dir, subOut));
  }
  return { ok: true, value: written.join(", "), artifact: rel(ctx.dir, out) };
}

// ─── съёмка ─────────────────────────────────────────────────────────────
export async function shoot(ctx: TasksCtx): Promise<RunResult<ChecksResult>> {
  // SAFETY: Brief — дискриминированный union с известными полями; читаем только
  // факультативный contact-поле "phone", которого нет у BlackBrief.
  const brief = ctx.brief as unknown as Record<string, unknown>;
  const notes: string[] = [];
  if (ctx.mode === "black") {
    const red = "redHex" in ctx.brief ? ctx.brief.redHex.toUpperCase() : "";
    const planned = ctx.plan.palette.red?.toUpperCase();
    if (red && planned && red !== planned) notes.push(`красный плана ${planned} ≠ Brief ${red}`);
    notes.push("проверь отсутствие Privacy/Terms и webp у всех картинок");
  }
  const res = await shootPage({
    dir: ctx.dir,
    htmlFile: path.join(ctx.dir, "dist", "index.html"),
    round: ctx.round,
    expect: {
      cta: true,
      price: !!(ctx.mode === "white" && "niche" in ctx.brief && ctx.brief.niche),
      phone: !!(typeof brief["phone"] === "string" && (brief["phone"] as string).trim()),
    },
    notes,
  });
  const artifact = rel(ctx.dir, path.join(ctx.dir, "preview", `checks-r${ctx.round}.json`));
  return { ok: true, value: res, artifact };
}

// ─── вердикт ────────────────────────────────────────────────────────────
export async function judge(ctx: TasksCtx): Promise<RunResult<Verdict>> {
  const checks = readJson<ChecksResult>(
    path.join(ctx.dir, "preview", `checks-r${ctx.round}.json`),
  );
  const shots = (checks?.screenshots ?? []).map((s) => ({
    breakpoint: s.breakpoint,
    file: s.file,
  }));

  const machineDefects = machineDefectsOf(checks);
  const shot = pickShot(ctx.dir, shots);

  if (!shot) {
    // нет chromium/скриншотов → detector-only, честный вердикт без vision
    const verdict: Verdict = {
      critical: machineDefects.filter((d) => d.severity === "critical").length,
      defects: machineDefects,
      summary: "vision недоступен: вердикт только по машинным проверкам",
    };
    writeJson(path.join(ctx.dir, "preview", `verdict-r${ctx.round}.json`), verdict);
    return { ok: true, value: verdict, artifact: `preview/verdict-r${ctx.round}.json` };
  }

  let call: JsonCallResult<Partial<Verdict>>;
  let visionUsed = true;
  try {
    call = await callJson<Partial<Verdict>>({
      dir: ctx.dir,
      mode: ctx.mode,
      task: "judge",
      role: "code",
      vars: { screens: shots, checks: checks ?? {} },
      signal: ctx.signal,
      image: { path: shot, mime: mimeOf(shot) },
      salt: `r${ctx.round}`,
    });
  } catch (err) {
    if (!/ключ|vision|400|404|not support|modalities/i.test((err as Error).message)) throw err;
    visionUsed = false;
    const verdict: Verdict = {
      critical: machineDefects.filter((d) => d.severity === "critical").length,
      defects: machineDefects,
      summary: `vision-пасс не удался (${(err as Error).message.slice(0, 80)}): только машинные проверки`,
    };
    writeJson(path.join(ctx.dir, "preview", `verdict-r${ctx.round}.json`), verdict);
    return { ok: true, value: verdict, artifact: `preview/verdict-r${ctx.round}.json` };
  }

  const defects = [...machineDefects, ...(call.value?.defects ?? []).map(normDefect)];
  const verdict: Verdict = {
    critical: defects.filter((d) => d.severity === "critical").length,
    defects,
    summary: call.value?.summary ?? "",
  };
  if (checks) checks.visionUsed = visionUsed;
  writeJson(path.join(ctx.dir, "preview", `checks-r${ctx.round}.json`), checks);
  writeJson(path.join(ctx.dir, "preview", `verdict-r${ctx.round}.json`), verdict);
  return { ok: true, value: verdict, artifact: `preview/verdict-r${ctx.round}.json`, usage: call.usage };
}

/** Машинные проверки сами по себе рождают дефекты — судья их не «забывает». */
function machineDefectsOf(c: ChecksResult | null): Defect[] {
  if (!c) return [];
  const out: Defect[] = [];
  let n = 0;
  const push = (sev: Defect["severity"], message: string, selector?: string) =>
    out.push({ id: `m${++n}`, task: "assemble", severity: sev, message, selector });
  // одна битая картинка не должна плодить три задачи-фикса
  const { consoleErrors } = dedupeImageDefects(c);
  for (const e of consoleErrors.slice(0, 8)) push("major", `console: ${e}`);
  for (const o of c.overflow) push("critical", `горизонтальный переполнение — ${o}`);
  for (const b of c.emptyBlocks) push("major", `пустая секция ${b}`, b);
  for (const a of c.missingAnchors) push(a === "cta" ? "critical" : "minor", `нет контент-анкора «${a}»`);
  for (const h of c.brokenHrefs) push("minor", `битая ссылка ${h}`, `a[href="${h}"]`);
  for (const i of c.brokenImgs ?? []) push("major", `картинка не загрузилась: ${i}`, `img[src*="${i}"]`);
  // текст тонет в фоне — это читаемости, major: раунд фиксов обязан реагировать
  for (const lc of c.lowContrast ?? []) push("major", `низкий контраст текста: ${lc}`);
  return out;
}

/**
 * Одна битая картинка давала 2–3 дефекта (requestfailed + ERR_FILE_NOT_FOUND +
 * brokenImgs) и раздувала раунд фиксов до 17 LLM-задач по 5.5k токенов. Здесь
 * консольные строки, поминающие файл из brokenImgs, схлопнуты в сам brokenImgs:
 * на файл остаётся один дефект.
 */
function dedupeImageDefects(c: ChecksResult): { consoleErrors: string[] } {
  const imgNames = new Set((c.brokenImgs ?? []).map((i) => i.split("/").pop() ?? i));
  const consoleErrors = c.consoleErrors.filter((e) => {
    const hit = [...imgNames].some((n) => e.includes(n));
    // requestfailed/ERR_FILE_NOT_FOUND по уже учтённой картинке — это тот же дефект
    if (hit && /requestfailed|ERR_FILE_NOT_FOUND|Failed to load resource/i.test(e)) return false;
    return true;
  });
  return { consoleErrors };
}

function normDefect(d: Defect, i: number): Defect {
  const sev = ["critical", "major", "minor", "info"].includes(d?.severity) ? d.severity : "minor";
  return {
    id: d?.id ?? `v${i + 1}`,
    task: d?.task ?? "assemble",
    severity: sev,
    message: String(d?.message ?? "").slice(0, 500),
    selector: typeof d?.selector === "string" ? d.selector : undefined,
  };
}

// ─── фиксы ──────────────────────────────────────────────────────────────
export async function fixOne(ctx: TasksCtx, defect: Defect): Promise<RunResult<string>> {
  const page = readJson<PageParts>(path.join(ctx.dir, "build", "page.json"));
  if (!page) return { ok: false, error: { klass: "fatal", message: "нет build/page.json для правки" } };
  const selector = defect.selector ?? "";
  const r = await callJson<{ css?: string; html?: string; note?: string }>({
    dir: ctx.dir,
    mode: ctx.mode,
    task: "fix",
    role: "fix",
    vars: {
      defect: defect.message,
      selector,
      css: clip(page.css, 12_000),
      htmlFragment: fragmentOf(page.html, selector),
      pageOutline: outlineOf(page.html),
      imageFiles: listImageFiles(ctx.dir),
      imageMap: imageMap(page.html),
    },
    signal: ctx.signal,
    salt: `r${ctx.round}-${defect.id}`,
  });

  const cssPatch = (r.value?.css ?? "").trim();
  const htmlPatch = (r.value?.html ?? "").trim();
  // «убрать секцию» — единственное действие, которого у html-патча нет (он только
  // дописывает). hide: точный селектор дубля превращается в remove-правило.
  const hideSel = (r.value as { hide?: string } | undefined)?.hide?.trim();
  const hidePatch = hideSel && /^[#.]?[\w-]+$/.test(hideSel) ? `${hideSel}{display:none!important}` : "";
  const cssAll = [cssPatch, hidePatch].filter(Boolean).join("\n");
  // Дедуп по defect.id: в judge-вердикте одна ошибка приходит и отдельным
  // defect'ом, и строкой console (в white_001 один ERR_FILE_NOT_FOUND дал
  // четыре строки в отчёте). Без метки один дефект чинился twice и раздувал
  // «сломанного» в глазах юзера
  const marker = `/* fix:${defect.id} */`;
  const prevFix = readText(path.join(ctx.dir, "build", `fix-r${ctx.round}.css`));
  if (cssAll && !prevFix.includes(marker))
    fs.appendFileSync(
      path.join(ctx.dir, "build", `fix-r${ctx.round}.css`),
      `\n${marker} /* ${oneLine(defect.message)} */\n${cssAll}\n`,
    );
  if (htmlPatch)
    fs.appendFileSync(
      path.join(ctx.dir, "build", `fix-r${ctx.round}.html`),
      `\n<!-- ${defect.id} -->\n${htmlPatch}\n`,
    );
  if (!cssAll && !htmlPatch) {
    // пустой ответ — не катастрофа: дефект просто остаётся в отчёте, прогон
    // не должен умирать в needs_human из-за одной «непочиняемой» модели
    return { ok: true, value: `пустой патч по ${defect.id} — пропущен`, usage: r.usage };
  }
  return { ok: true, value: r.value?.note ?? cssPatch, usage: r.usage };
}

// ─── экспорт и отчёт ────────────────────────────────────────────────────────────
/**
 * Чёрный: папка black_NNN рядом с проектом + строка для LANDING_REGISTRY.md.
 * Белый: пока копия dist/ (многостраничность whites решается при первой сборке, SPEC §5).
 */
/**
 * Экспорт и выгрузка.
 * Чёрный: папка `black_NNN/` рядом с проектом + строка для LANDING_REGISTRY.md.
 * Белый: по желанию `index.php` вместо `index.html` + выгрузка в папку, выбранную
 * юзером: остаться в мастерской или лечь в любую папку этой машины. Про серверы
 * (WAMP, OpenServer, nginx, хостинг) генератор ничего не знает: кладём папку и
 * zip рядом, юзер сам переносит их к себе.
 */
export async function exportSite(ctx: TasksCtx): Promise<RunResult<string>> {
  const dist = path.join(ctx.dir, "dist");
  if (!fs.existsSync(path.join(dist, "index.html")))
    return { ok: false, error: { klass: "fatal", message: "нет dist/index.html для экспорта" } };

  const outDir = path.join(ctx.dir, "export");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(dist, outDir, { recursive: true });

  const lines: string[] = [];
  if (ctx.mode === "black") {
    // папка black_NNN создаётся один раз: повторный экспорт после human-fix
    // обязан пополнить ту же папку, а не заводить black_NNN+1 рядом
    const existing = safeReaddir(ctx.dir).find((f) => /^black_\d{3}$/.test(f));
    const folder = existing ?? `black_${nextFolderNumber(ctx.dir)}`;
    fs.rmSync(path.join(ctx.dir, folder), { recursive: true, force: true });
    fs.renameSync(outDir, path.join(ctx.dir, folder));
    const red = ctx.plan.palette.red ?? ("redHex" in ctx.brief ? ctx.brief.redHex : "?");
    lines.push(
      `| ${folder} | ${red} | ${("typeAvatar" in ctx.brief && ctx.brief.typeAvatar) || "—"} | ` +
        `${(ctx.plan.sections.map((s) => s.slug).join(", ")).slice(0, 80)} | ${new Date().toISOString().slice(0, 10)} |`,
    );
  } else {
    lines.push(`# white-экспорт: ${path.basename(ctx.dir)}`);
    // структура по мастеру §7: страницы папками, общие assets/style.css +
    // script.js, assets/image/, favicon и SEO-файлы в корне
    restructureWhiteExport(ctx, outDir);
    if ("php" in ctx.brief && ctx.brief.php) toPhp(outDir);
    // выгрузка сюда НЕ входит: с раунда «ревью перед выгрузкой» export/ — только
    // сборка; за пределы мастерской проект уходит явным действием (кнопка
    // «Выгрузить» → placeExport), а не молча по пути из брифа
    const inner = (ctx.plan.pages ?? []).map((pg) => `${pg.slug}/`);
    if (inner.length) lines.push(`Страницы сайта: index${inner.length ? " + " + inner.join(", ") : ""}.`);
  }
  fs.writeFileSync(path.join(ctx.dir, "export-note.md"), lines.join("\n") + "\n");
  return { ok: true, value: rel(ctx.dir, outDir), artifact: "export/" };
}

/**
 * Whites-обвязка: index.php вместо index.html. PHP здесь не нужен по смыслу
 * (страница статичная), но серия whites раздаётся с `*.php`, и без него форма
 * страницы не принимается; относительные ссылки при этом не меняются.
 */
function toPhp(dir: string): void {
  convertIndexFormat(dir, "php");
}

/** Обратный ход: `.php` → `.html` (см. setExportFormat). */
function toHtml(dir: string): void {
  convertIndexFormat(dir, "html");
}

/**
 * Переименовывает страницы всего экспорта в другой формат и правляет
 * перекрёстные ссылки. Нужен двусторонний ход: формат выбирается у кнопок
 * выгрузки, то есть ПОСЛЕ сборки, и менять его приходится на готовом
 * export/, не перегенерируя сайт.
 */
function convertIndexFormat(dir: string, to: "php" | "html"): void {
  const from = to === "php" ? "html" : "php";
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, f.name);
      if (f.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!new RegExp(`\\.${from}$`, "i").test(f.name)) continue;
      const body = fs.readFileSync(p, "utf8");
      fs.writeFileSync(
        p,
        // `\\w`, а не `\w`: внутри шаблонной строки одинарный бэкслеш теряется,
        // класс превращается в [w-] и ссылки не переписываются вовсе
        body.replace(new RegExp(`href="([\\w-]+)\\.${from}"`, "g"), `href="$1.${to}"`),
      );
      fs.renameSync(p, p.replace(new RegExp(`\\.${from}$`, "i"), `.${to}`));
    }
  }
}

/**
 * Формат индексов в ГОТОВОМ экспорте: `php` (index.php) или `html`
 * (index.html). Возвращает число страниц, тронутых конвертацией; 0 значит
 * «формат уже такой» и файлы не дёргались (mtime, а с ним и свежесть zip,
 * остаются прежними).
 */
export function setExportFormat(dir: string, to: "php" | "html"): number {
  const outDir = exportDirOf(dir);
  const from = to === "php" ? "html" : "php";
  if (!fs.existsSync(outDir)) return 0;
  let n = 0;
  const stack = [outDir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of fs.readdirSync(cur, { withFileTypes: true })) {
      if (f.isDirectory()) stack.push(path.join(cur, f.name));
      else if (new RegExp(`\\.${from}$`, "i").test(f.name)) n++;
    }
  }
  if (n) convertIndexFormat(outDir, to);
  return n;
}

/**
 * Структура whites по мастеру §7: страницы папками (about/index.html), общие
 * assets/style.css и assets/script.js, картинки в assets/image/, favicon.svg
 * и SEO-файлы в корне. Рабочая сборка (dist/) остаётся плоской — превью и
 * проверки не трогаем, перестраиваем только экспорт.
 */
function restructureWhiteExport(ctx: TasksCtx, outDir: string): void {
  const slugs = (ctx.plan.pages ?? []).map((p) => p.slug);
  // 1. страницы — в папки
  for (const slug of slugs) {
    const flat = path.join(outDir, `${slug}.html`);
    if (!fs.existsSync(flat)) continue;
    fs.mkdirSync(path.join(outDir, slug), { recursive: true });
    fs.renameSync(flat, path.join(outDir, slug, "index.html"));
  }
  const spots: Array<[string, number]> = [
    [path.join(outDir, "index.html"), 0],
    ...slugs.map((s): [string, number] => [path.join(outDir, s, "index.html"), 1]),
  ];
  const pages: Array<{ file: string; depth: number; html: string }> = [];
  for (const [file, depth] of spots)
    if (fs.existsSync(file)) pages.push({ file, depth, html: fs.readFileSync(file, "utf8") });
  if (!pages.length) return;

  // 2. общие css/js: модели вернули их инлайном — выносим в assets/ только
  //    если блок повторяется минимум на двух страницах (уникальный инлайн оставляем)
  const pickShared = (re: RegExp): string => {
    const freq = new Map<string, number>();
    for (const pg of pages)
      for (const m of pg.html.matchAll(re)) {
        const body = m[1].trim();
        if (body.length > 50) freq.set(body, (freq.get(body) ?? 0) + 1);
      }
    let best = "";
    let n = 0;
    for (const [body, c] of freq)
      if (c > n) {
        best = body;
        n = c;
      }
    return n >= 2 ? best : "";
  };
  const esc = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const css = pickShared(/<style[^>]*>\s*([\s\S]*?)\s*<\/style>/gi);
  const js = pickShared(/<script(?![^>]*\bsrc=)[^>]*>\s*([\s\S]*?)\s*<\/script>/gi);
  if (css) {
    const re = new RegExp(`<style[^>]*>\\s*${esc(css)}\\s*</style>`, "g");
    for (const pg of pages)
      pg.html = pg.html.replace(re, () => `<link rel="stylesheet" href="${pg.depth ? "../" : ""}assets/style.css">`);
    fs.writeFileSync(path.join(outDir, "assets", "style.css"), css + "\n");
  }
  if (js) {
    const re = new RegExp(`<script(?![^>]*\\bsrc=)[^>]*>\\s*${esc(js)}\\s*</script>`, "g");
    for (const pg of pages)
      pg.html = pg.html.replace(re, () => `<script src="${pg.depth ? "../" : ""}assets/script.js"></script>`);
    fs.writeFileSync(path.join(outDir, "assets", "script.js"), js + "\n");
  }

  // 3. картинки — в assets/image/ (мастер), пути в html заодно
  const imgOld = path.join(outDir, "assets", "img");
  if (fs.existsSync(imgOld)) fs.renameSync(imgOld, path.join(outDir, "assets", "image"));
  for (const pg of pages) pg.html = pg.html.split("assets/img/").join("assets/image/");

  // 4. favicon в корень; нет у модели — минимальный с инициалом бренда.
  //    Ссылку переписываем в обоих случаях: модель часто тычет её в assets/,
  //    а по мастеру файл лежит в корне — иначе вложенная страница просила бы
  //    ../assets/favicon.svg, которого там нет
  const favOld = path.join(outDir, "assets", "favicon.svg");
  const rootFav = path.join(outDir, "favicon.svg");
  if (fs.existsSync(favOld)) fs.renameSync(favOld, rootFav);
  else if (!fs.existsSync(rootFav)) {
    const accent = ctx.plan.palette.accent ?? "#888888";
    const brand = String((ctx.brief as { brand?: string }).brand ?? "W").trim() || "W";
    fs.writeFileSync(
      rootFav,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${accent}"/><text x="32" y="43" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#fff">${brand[0]!.toUpperCase()}</text></svg>\n`,
    );
  }
  for (const pg of pages)
    pg.html = pg.html.replace(
      // модель могла написать favicon в assets/, assets/img/ или assets/image/
      // (шаг 3 уже переименовал img→image) — всё это вести должно в корень
      /href="(?:\.\.\/|\.\/)?(?:assets\/(?:image\/|img\/)?)?favicon\.svg"/g,
      `href="${pg.depth ? "../" : ""}favicon.svg"`,
    );

  // 5. относительные ссылки: из вложенной страницы на соседнюю — ../slug/,
  //    на главную — ../ (мастер §7: без .html)
  for (const pg of pages) {
    if (!pg.depth) continue;
    for (const slug of slugs)
      pg.html = pg.html.replace(new RegExp(`href="(?:\.\./|\./)?${slug}/"`, "g"), `href="../${slug}/"`);
    pg.html = pg.html.replace(/href="\.\/"/g, `href="../"`);
  }

  // 5b. модель часто рисует в навигации страницы, которых нет в плане
  //     (services/ policy/ при pageCount=1) — на выгруженном сайте это 404;
  //     ведущие в никуда каталожные ссылки детерминированно ведут на главную.
  //     Отдельно лечатся ссылки ОТ КОРНЯ (`/about/`, `/`): они верны только на
  //     домене верхнего уровня, а вайт серии кладут и в подпапку (WAMP
  //     htdocs/white_004/, рабочий стол), где `/about/` проваливается в корень
  //     сервера. Хозяин — мастер §7: ссылки относительные, без .html
  const known = new Set(slugs);
  for (const pg of pages) {
    const home = pg.depth ? "../" : "./";
    const up = pg.depth ? "../" : "";
    pg.html = pg.html.replace(/href="(\/|\.\.\/|\.\/)?([\w-]+)\/"/g, (_m, root: string, slug: string) =>
      known.has(slug) ? `href="${root === "/" ? up : root}${slug}/"` : `href="${home}"`,
    );
    // «/» — главная сайта: для вайта в подпапке это не она
    pg.html = pg.html.replace(/href="\/"/g, `href="${home}"`);
  }

  // 6. SEO-файлы — детерминированно, без токенов модели
  const canonical =
    /<link rel="canonical" href="([^"]+)"/i.exec(pages[0].html)?.[1]?.replace(/\/$/, "") ??
    "https://example.com";
  const sitePages = ["", ...slugs.filter((s) => s !== "thanks")];
  fs.writeFileSync(
    path.join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nDisallow: /thanks/\n\nSitemap: ${canonical}/sitemap.xml\n`,
  );
  fs.writeFileSync(
    path.join(outDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      sitePages.map((s) => `  <url><loc>${canonical}${s ? "/" + s + "/" : "/"}</loc></url>`).join("\n") +
      "\n</urlset>\n",
  );
  const title = pages[0].html.match(/<title>([^<]+)/)?.[1]?.trim() ?? "";
  const desc = /<meta\s+name="description"\s+content="([^"]+)/i.exec(pages[0].html)?.[1] ?? "";
  fs.writeFileSync(
    path.join(outDir, "llms.txt"),
    `# ${title}\n\n${desc}\n\n## Pages\n\n` +
      sitePages
        .map((s) => `- [${s ? s[0]!.toUpperCase() + s.slice(1) : "Home"}](${canonical}${s ? "/" + s + "/" : "/"})`)
        .join("\n") +
      "\n",
  );

  for (const pg of pages) fs.writeFileSync(pg.file, pg.html);
}

/**
 * Выложить готовое за пределы мастерской: копия export/ (для black — папки
 * black_NNN) в выбранную папку + zip рядом с ней. «В генераторе» (here) —
 * копия не нужна: export/ и есть результат, возвращаем null.
 *
 * Вызывается НЕ из графа прогона, а из ручки «Выгрузить»: до нажатия на столе
 * ничего не появляется, поэтому human-fix не порождает мусорных копий.
 */
export function placeExport(
  dir: string,
  emit: (e: OrchEvent) => void,
  choiceOverride?: DeliveryChoice,
): { dir: string; zip: string } | null {
  const s = settings();
  const brief = readJson<Brief & { delivery?: DeliveryChoice }>(path.join(dir, "brief.json"));
  const choice =
    choiceOverride ?? brief?.delivery ?? s.delivery ?? ({ kind: "here" } as DeliveryChoice);
  if (!choice.kind || choice.kind === "here") return null;

  // что кладём: white — export/, black — уже переименованную папку black_NNN
  const outDir = exportDirOf(dir);
  const blackFolder = /^black_\d{3}$/.test(path.basename(outDir))
    ? path.basename(outDir)
    : undefined;
  const hasEntry =
    fs.existsSync(path.join(outDir, "index.html")) || fs.existsSync(path.join(outDir, "index.php"));
  if (!hasEntry) {
    const note = "нет собранного экспорта — сначала довести прогон до сборки";
    emit({ t: "export.place", at: new Date().toISOString(), path: note, error: note });
    return null;
  }

  const project = path.basename(dir);
  const dest = resolveDest(
    { kind: choice.kind === "desktop" ? "desktop" : "folder", path: choice.path, zip: choice.zip },
    { project: blackFolder ?? project },
  );
  if (!dest.writable || !dest.dir) {
    emit({ t: "export.place", at: new Date().toISOString(), path: dest.note, error: dest.note });
    return null;
  }
  const target = path.join(dest.dir, dest.sub);
  copyTree(outDir, target);
  const wantZip = choice.zip ?? s.delivery?.zip ?? true;
  let zip = "";
  if (wantZip) {
    // один объект на столе: папка проекта, а внутри неё и сайт, и zip.
    // архив пишем во временное имя рядом и переносим внутрь — иначе zip
    // попал бы сам к себе в содержимое. Временное имя ОБЯЗАТЕЛЬНО кончается
    // на .zip: make_archive режет именно финальное расширение, а «.zip.tmp»
    // рождал на столе хвост «white_001.zip.tmp.zip»
    const tmpZip = path.join(dest.dir, `.${dest.sub}.tmp.zip`);
    // остатки старых имён временного архива («x.zip.tmp» — папка после сбоя,
    // «x.zip.tmp.zip» — хвост python-архиватора): им тут быть не должно
    fs.rmSync(path.join(dest.dir, `${dest.sub}.zip.tmp`), { recursive: true, force: true });
    fs.rmSync(path.join(dest.dir, `${dest.sub}.zip.tmp.zip`), { force: true });
    const err = makeZip(target, tmpZip);
    if (err) {
      // выгрузка не состоялась — говорим сразу: иначе юзер получит «готово»
      // с половинчатым результатом и молча уйдёт
      emit({ t: "export.place", at: new Date().toISOString(), path: target, error: err });
      throw Object.assign(new Error(`выгрузка: ${err}`), { klass: "fatal" });
    }
    zip = path.join(target, `${dest.sub}.zip`);
    fs.renameSync(tmpZip, zip);
  }
  // запоминаем: в следующий раз тот же выбор предложится пилюлей по умолчанию
  if (choice.kind === "desktop") {
    s.delivery = { kind: "desktop", zip: wantZip };
  } else {
    rememberDir(s, dest.dir);
    s.delivery = { kind: "folder", path: dest.dir, zip: wantZip };
  }
  try {
    saveSettings(s);
  } catch {
    /* не удалось сохранить — на результат выгрузки не влияет */
  }
  emit({ t: "export.place", at: new Date().toISOString(), path: target, zip: zip || null });
  // выложено вовне — проект «утяжеляет» мастерскую: чистим тяжёлые рабочие
  // артефакты (скриншоты проверок, кэш ответов моделей). Патчи build/ остаются:
  // пока прогон жив и может правиться, assemble читает fix-rN.*
  for (const heavy of ["preview", ".cache"])
    fs.rmSync(path.join(dir, heavy), { recursive: true, force: true });
  writeJson(path.join(dir, "placed.json"), {
    dir: target,
    zip,
    at: new Date().toISOString(),
    stamp: exportStamp(dir),
  });
  return { dir: target, zip };
}

/**
 * Метка времени сборки (mtime entry-файла экспорта). Служит «версией» выгрузки:
 * положил проект на стол, потом попросил правку — если stamp вырос, на столе
 * лежит устаревшая копия и это видно в UI.
 *
 * Экспортом считается export/ (white) или переименованная папка black_NNN/
 * (чёрный экспорт переезжает туда сразу после сборки).
 */
export function exportDirOf(dir: string): string {
  const black = safeReaddir(dir).find((f) => /^black_\d{3}$/.test(f));
  for (const cand of [path.join(dir, "export"), black ? path.join(dir, black) : "", path.join(dir, "dist")]) {
    if (!cand) continue;
    if (fs.existsSync(path.join(cand, "index.html")) || fs.existsSync(path.join(cand, "index.php")))
      return cand;
  }
  return path.join(dir, "export");
}

export function exportStamp(dir: string): string {
  const base = exportDirOf(dir);
  for (const cand of ["index.html", "index.php"]) {
    const f = path.join(base, cand);
    if (fs.existsSync(f)) return fs.statSync(f).mtime.toISOString();
  }
  return "";
}

/** Куда и когда проект уже выкладывали (placed.json), и не устарела ли копия. */
export function placement(dir: string): {
  dir: string;
  zip: string;
  at: string;
  stale: boolean;
} | null {
  const p = readJson<{ dir?: string; zip?: string; at?: string; stamp?: string }>(
    path.join(dir, "placed.json"),
  );
  if (!p?.dir) return null;
  return {
    dir: p.dir,
    zip: p.zip ?? "",
    at: p.at ?? "",
    stale: Boolean(p.stamp) && exportStamp(dir) > p.stamp!,
  };
}

/**
 * Адресная правка (совет ревью-раунда 09.11: «инструкция тонет в большом
 * контексте»). По тексту заказа выбираем СЕКЦИЮ, к которой он относится
 * (per-section outline уже есть), и отдаём модели только её html + только
 * CSS-правила, упомянутые в ней. Остальной CSS — списком селекторов: модель
 * знает имена классов, но не тонет в 12k правил. Замер до/после: 21k симв.
 * контекста → 6–9k, при том же патче.
 */
function sectionOfOrder(html: string, order: string): { name: string; html: string } | null {
  const secs = [...html.matchAll(/<(section|footer|header)([^>]*)>/g)].map((m) => ({
    tag: m[1],
    at: m.index ?? 0,
    name: /id="([^"]+)"/.exec(m[2] ?? "")?.[1] ?? /class="([^"]+)"/.exec(m[2] ?? "")?.[1] ?? m[1],
  }));
  const words = oneLine(order).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const RU: Record<string, string> = {
    "футер": "footer", "подвал": "footer", "шапк": "header", "меню": "header", "навиг": "header",
    "геро": "hero", "главн": "hero", "баннер": "hero", "галер": "gallery", "форм": "cta",
    "заявк": "cta", "кнопо": "cta", "преиму": "benefit",
  };
  let best: { name: string; score: number } | null = null;
  for (const w of words) {
    for (const [k, v] of Object.entries(RU)) if (w.includes(k) && !best) best = { name: v, score: 3 };
  }
  for (const w of words)
    for (const sec of secs)
      if (sec.name.toLowerCase().includes(w) && (!best || best.score < 2)) best = { name: sec.name, score: 2 };
  if (!best) return null;
  const sec = secs.find((x) => x.name.toLowerCase().includes(best!.name.toLowerCase()));
  if (!sec) return null;
  const closeRe = new RegExp(`</${sec.tag}>`, "i");
  const m = closeRe.exec(html.slice(sec.at));
  const body = html.slice(sec.at, sec.at + (m ? m.index + m[0].length : 2_000));
  return { name: sec.name, html: clip(body, 3_500) };
}

/** CSS-правила, относящиеся к фрагменту: селекторы которого в нём встречаются */
function cssForFragment(css: string, frag: string): string {
  const blocks = css.match(/[^{}]+\{[^}]*\}/g) ?? [];
  const keep = blocks.filter((b) => {
    const head = b.slice(0, b.indexOf("{"));
    if (/^\s*(:root|\*|body|html)\b/i.test(head)) return true; // переменные и база — всегда
    const sels = b.slice(0, b.indexOf("{")).split(",");
    return sels.some((raw) => {
      const cls = [...raw.matchAll(/\.([\w-]+)|#([\w-]+)|(section|footer|header|body|html)/g)];
      return cls.some((m) => frag.includes(m[1] ?? m[2] ?? m[3] ?? ""));
    });
  });
  return keep.length ? keep.join("\n") : clip(css, 6_000);
}

/**
 * Правка человека в review: свободный текст → патч (тот же prompt fix) →
 * export/ пересобран → съёмка без vision-судьи. Патчи НЕ пишутся в build/fix-rN
 * — их читает assemble раунда, а review живёт после всех раундов; человеческие
 * правки копятся в overrides.css / overrides.html, которые assemble дописывает
 * в конец и которые оркестратор не переписывает.
 */
/**
 * Разобрать свободный текст правки на отдельные пункты.
 *
 * Причина функции: весь текст уходил модели одним `defect`, а промпт
 * fix.md.jte буквально говорит «чинишь ОДИН дефект». Из «заголовок крупнее;
 * телефон в шапку; футер темнее» модель честно выполняла первый пункт и
 * останавливалась — юзер видел «одну правку сделала и всё». Разделители:
 * перевод строки, `;`, `•`, « – » , «1)» / «2.» — тем, чем список пишут в
 * текстовом поле.
 */
export function splitEdits(comment: string): string[] {
  const parts = comment
    .split(/\r?\n|;|•|\s[-–—]\s+(?=\S)|\d+[).]\s+/)
    .map((s) => s.trim().replace(/^[,.:;\s]+/, ""))
    .filter((s) => s.length > 1);
  return parts.length ? parts : [comment.trim()];
}

/** Одна запись ответа режима «список правок». */
interface FixItem {
  item?: string;
  css?: string;
  html?: string;
  hide?: string;
  note?: string;
  /** модель обязана сказать, выполнила ли пункт: молчаливый пропуск = провал */
  done?: boolean;
  why?: string;
  /**
   * ЗАМЕНИТЬ картинку: src не меняется ни css, ни html-патчем (css не умеет,
   * html-патч дописывается в конец и до старого <img> не дотягивается).
   * Модель звала `swaps`, сборка выполняет подмену сама и валидирует `to`
   * по диску: иначе на «замени дубли картинок» приходил `background-color`
   * и «готово» при том же пикселе.
   */
  swaps?: Array<{ from: string; to: string; which?: number }>;
}

/**
 * Отчёт раунда правки. Пишется в human-fix.json и отдаётся через /site:
 * «все правки сделаны» должно быть видно и после перезапуска сервера, а не
 * только в момент ответа на запрос.
 */
export interface HumanFixReport {
  at: string;
  requested: number;
  applied: number;
  items: Array<{ text: string; done: boolean; note?: string }>;
  /**
   * Машинные проверки «до/после» этого раунда (сумма console+overflow+битых
   * src/href). Модель может «применить» пункт и сломать картинку — «✓ все
   * правки» без этих цифр врут, UI обязан показать регрессию.
   */
  checks?: { before: number; after: number };
  /**
   * mtime dist/ сразу после пересборки ЭТИМ раундом. UI сверяет его с текущим
   * штампом сборки: равен — плашка показывает результат, который человек видит
   * в превью прямо сейчас; отличается — это история (была ещё правка, откат или
   * догенерение картинок), и подавать её как «только что внесено» нельзя:
   * вчерашний отчёт горел зелёным как статус свежего действия.
   */
  builtAt?: number;
  /** правка реально изменила собранный файл (хэш dist до/после) */
  changed?: boolean;
  /** патч с первой попытки не изменил страницу — раунд переделывался */
  retried?: boolean;
}


/**
 * Правка человека в review: свободный текст → патч (тот же prompt fix) →
 * export/ пересобран → съёмка без vision-судьи. Патчи НЕ пишутся в build/fix-rN
 * — их читает assemble раунда, а review живёт после всех раундов; человеческие
 * правки копятся в overrides.css / overrides.html, которые assemble дописывает
 * в конец и которые оркестратор не переписывает.
 */
/**
 * Правка человека в review: свободный текст → патч (тот же prompt fix) →
 * export/ пересобран → съёмка без vision-судьи. Патчи НЕ пишутся в build/fix-rN
 * — их читает assemble раунда, а review живёт после всех раундов; человеческие
 * правки копятся в overrides.css / overrides.html, которые assemble дописывает
 * в конец и которые оркестратор не переписывает.
 *
 * Цикл из ДВУХ попыток (09.11, ответ на «модель не слушает правки, пишет свою
 * дичь»). дешёвая модель на роли fix систематически выдаёт патч-имитацию:
 * «Заменены все дублирующие картинки через CSS content», а собранный файл —
 * байт в байт прежний. Раньше такой раунд возвращал ok:true с «✓ готово», и
 * человек видел это каждый раз. Теперь: патч, не изменивший хэш dist,
 * ОТКАТЫВАЕТСЯ с диска и модель переспрашивается с конкретным упрёком; вторая
 * неудача — ok:false «модель дважды прислала патч, который не меняет
 * страницу», а не ложный успех.
 */
export async function humanFix(
  ctx: TasksCtx,
  comment: string,
): Promise<RunResult<string>> {
  const page = readJson<PageParts>(path.join(ctx.dir, "build", "page.json"));
  if (!page) return { ok: false, error: { klass: "fatal", message: "нет build/page.json — сборка не найдена" } };

  const edits = splitEdits(comment);
  const beforeChecks = readJson<ChecksResult>(path.join(ctx.dir, "preview", `checks-r${ctx.round}.json`));
  const distFile = path.join(ctx.dir, "dist", "index.html");
  const cssFile = path.join(ctx.dir, "overrides.css");
  const htmlFile = path.join(ctx.dir, "overrides.html");
  const swFile = path.join(ctx.dir, "img-swaps.json");
  const usageSum = { prompt: 0, completion: 0 };
  let rebuke = "";
  // попытки: 1 — выбранная модель; 2 — она же с упрёком; 3 — ЭСКАЛАЦИЯ
  // (сильная модель из settings.fixEscalation), если она настроена
  const escal = settings().fixEscalation ?? null;
  const ATTEMPTS = escal ? 3 : 2;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const strong = attempt === ATTEMPTS && attempt > 2 && escal;
    // Ключ кэша обязан различать и ПОВТОР той же жалобы (overrides меняются),
    // и ПОПЫТКУ: после отката overrides возвращаются в прежнее состояние, и
    // без -r2 повторный запрос получил бы из кэша ровно тот же провалившийся
    // патч — «переделываю» превратился бы в тишину
    const overridesBefore = readText(cssFile);
    const saltTail =
      (overridesBefore ? `+ov${shortHash(overridesBefore)}` : "") +
      (attempt > 1 ? `-r${attempt}${shortHash(rebuke)}` : "");
    // АДРЕСНОСТЬ: вместо «весь css + первые 3000 символов html» — секция,
    // к которой относится заказ, и только относящиеся к ней CSS-правила.
    // Остальное — имена классов: модель видит словарь, но не тонет в 12k
    const target = sectionOfOrder(page.html, comment);
    const frag = target ? target.html : clip(page.html, 3_000);
    const vars = {
      css: cssForFragment(page.css, frag),
      cssRest: (page.css.match(/(^|[\s,}])[.#][\w-]+/g) ?? [])
        .map((x) => x.trim().split(/[\s,}]/).pop())
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .slice(0, 120)
        .join(" "),
      htmlFragment: frag,
      fragmentNote: target
        ? `Фрагмент = секция «${target.name}»: заказ относится к ней, остальная страница не трогается.`
        : "Фрагмент = начало страницы; целевую секцию ищи по карте страницы.",
      pageOutline: outlineOf(page.html),
      imageFiles: listImageFiles(ctx.dir),
      imageMap: imageMap(page.html),
      appliedPatches: appliedPatchesSummary(ctx.dir),
    };
    // эскалация: сильная модель вызывается ТОЛЬКО если дешёвая дважды
    // провалилась — обычно правка стоит дёшево и заканчивается на попытке 1
    const override = strong && escal ? { connection: escal.connection, model: escal.model } : undefined;
    ctx.progress?.(
      attempt === 1
        ? "модель пишет патч"
        : strong
          ? `дешёвая модель дважды не изменила страницу — пробует ${escal?.model ?? "сильная модель"}`
          : "патч не изменил страницу — модель переделывает",
    );
    const single =
      edits.length === 1
        ? await callJson<FixItem>({
            dir: ctx.dir,
            mode: ctx.mode,
            task: "fix",
            role: "fix",
            vars: { ...vars, defect: `Правка по заказу человека: ${comment}`, selector: "" },
            signal: ctx.signal,
            suffix: rebuke || undefined,
            salt: `human-${shortHash(comment)}${saltTail}`,
            modelOverride: override,
          })
        : null;
    const multi =
      edits.length > 1
        ? await callJson<{ fixes?: FixItem[]; note?: string }>({
            dir: ctx.dir,
            mode: ctx.mode,
            task: "fix-list",
            role: "fix",
            vars: { ...vars, count: String(edits.length), edits: edits.map((text, i) => ({ n: String(i + 1), text })) },
            signal: ctx.signal,
            suffix: rebuke || undefined,
            modelOverride: override,
            salt: `human-list-${shortHash(comment)}${saltTail}`,
          })
        : null;
    const resp = (single ?? multi)!;
    usageSum.prompt += resp.usage?.prompt ?? 0;
    usageSum.completion += resp.usage?.completion ?? 0;

    const items: Array<{ text: string; patch: FixItem }> = single
      ? [{ text: edits[0], patch: (single.value ?? {}) as FixItem }]
      : edits.map((text, i) => ({ text, patch: multi!.value?.fixes?.[i] ?? {} }));

    const cssParts: string[] = [];
    const htmlParts: string[] = [];
    const report: HumanFixReport = { at: new Date().toISOString(), requested: edits.length, applied: 0, items: [] };
    const swapOps: Array<{ roundId: string; from: string; to: string; which: number }> = [];
    const imgFilesNow = new Set(listImageFiles(ctx.dir));
    for (const { text, patch } of items) {
      const css = (patch.css ?? "").trim();
      const html = (patch.html ?? "").trim();
      const hideSel = (patch.hide ?? "").trim();
      const hide = hideSel && /^[#.]?[\w-]+$/.test(hideSel) ? `${hideSel}{display:none!important}` : "";
      const swapsOk = (patch.swaps ?? [])
        .map((s) => ({ from: (s.from ?? "").split("/").pop() ?? "", to: (s.to ?? "").split("/").pop() ?? "", which: s.which ?? 0 }))
        .filter((s) => s.from && s.to && s.from !== s.to && imgFilesNow.has(s.to));
      const done = patch.done !== false && Boolean(css || html || hide || swapsOk.length);
      if (done) report.applied += 1;
      report.items.push({
        text: oneLine(patch.item?.trim() || text).slice(0, 120),
        done,
        note: (patch.note ?? patch.why ?? "").trim().slice(0, 160) || undefined,
      });
      if (css || hide) cssParts.push([css, hide].filter(Boolean).join("\n"));
      if (html) htmlParts.push(html);
      swapOps.push(...swapsOk.map((s) => ({ roundId: "", ...s })));
    }

    const cssAll = cssParts.filter(Boolean).join("\n");
    const htmlPatch = htmlParts.join("\n");
    if (!cssAll && !htmlPatch && !swapOps.length) {
      if (attempt < 2) {
        rebuke = `На заказ «${oneLine(comment).slice(0, 80)}» ты вернула пустые патчи. Он выполним — посмотри карту страницы и список картинок.`;
        continue;
      }
      return {
        ok: false,
        error: {
          klass: "contract",
          message: `модель вернула пустой патч на «${oneLine(comment).slice(0, 60)}» — сборка не изменена`,
        },
        usage: usageSum,
      };
    }

    const roundId = Date.now().toString(36);
    if (swapOps.length) {
      const prev = readJson<Array<{ roundId?: string; from: string; to: string; which: number }>>(swFile) ?? [];
      writeJson(swFile, [...prev, ...swapOps.map((s) => ({ ...s, roundId }))]);
    }
    const stamp = `/* ── правка человека #${roundId} ── ${oneLine(comment).slice(0, 120)} */`;
    if (cssAll) fs.appendFileSync(cssFile, `\n${stamp}\n${cssAll}\n`);
    if (htmlPatch) {
      const note = `<!-- ── правка человека #${roundId} ── ${oneLine(comment).slice(0, 120)} -->`;
      const ids = [...htmlPatch.matchAll(/<(section|div|footer|header)[^>]*\bid="([\w-]+)"/g)];
      let htmlOld = readText(htmlFile);
      for (const [, tag, id] of ids)
        htmlOld = htmlOld.replace(new RegExp(`<${tag}[^>]*\bid="${id}"[\\s\\S]*?</${tag}>\\s*`, "i"), "");
      fs.writeFileSync(htmlFile, `${htmlOld}\n${note}\n${htmlPatch}\n`);
    }

    ctx.emit({
      t: "review.fix",
      at: new Date().toISOString(),
      requested: report.requested,
      applied: report.applied,
      items: report.items,
    });

    ctx.progress?.("пересобираю сайт");
    const hashBefore = shortHash(readText(distFile));
    const built = await assemble(ctx);
    if (!built.ok) return built;

    if (shortHash(readText(distFile)) === hashBefore) {
      // патч есть, страницы нет — ОТКАТ раунда (иначе overrides раздувались
      // мертвыми правилами) и вторая попытка с упрёком
      const cutRound = (file: string): void => {
        if (!fs.existsSync(file)) return;
        const txt = fs.readFileSync(file, "utf8");
        const hits = [...txt.matchAll(/(?:\/\*|<!--)\s?── правка человека(?: #(\w+))? ──/g)];
        const i = hits.findIndex((h) => h[1] === roundId);
        if (i < 0) return;
        const end = hits[i + 1]?.index ?? txt.length;
        fs.writeFileSync(file, txt.slice(0, hits[i].index) + txt.slice(end));
      };
      cutRound(cssFile);
      cutRound(htmlFile);
      const swAll = readJson<Array<{ roundId?: string }>>(swFile) ?? [];
      if (swAll.some((x) => x.roundId === roundId))
        writeJson(swFile, swAll.filter((x) => x.roundId !== roundId));
      // вернуть dist в прежнее состояние (await: второй assemble не должен
      // гонять параллельно с этим и писать один файл)
      await assemble(ctx);
      const said = report.items[0]?.note ?? "пусто";
      rebuke =
        `ТВОЙ ПРЕДЫДУЩИЙ ПАТЧ («${oneLine(said).slice(0, 90)}») НЕ ИЗМЕНИЛ СОБРАННУЮ СТРАНИЦУ НИ НА БАЙТ. ` +
        "Он либо повторяет уже применённое правило (смотри раздел «уже применено»), либо звёт селектор/файла, " +
        "которого нет на странице. Перечитай ЗАКАЗ, карту страницы и карту картинок и сделай ДРУГУЮ правку, " +
        "которая явно изменит стили или разметку. Не имитируй: css не может менять src картинок (для этого есть swaps).";
      if (attempt < 2) continue;
      return {
        ok: false,
        error: {
          klass: "contract",
          message:
            `модель дважды прислала патч, который не меняет собранную страницу («${oneLine(comment).slice(0, 60)}»); ` +
            `последнее, что она обещала: «${oneLine(said).slice(0, 90)}». Сайт прежний, раунд откачен.`,
        },
        usage: usageSum,
      };
    }

    const builtAt = fs.existsSync(distFile) ? Math.round(fs.statSync(distFile).mtimeMs) : 0;
    ctx.progress?.("фоткаю 375 / 768 / 1280");
    const shot = await shoot(ctx);
    if (!shot.ok) return { ok: false, error: shot.error };
    const fresh = await exportSite(ctx);

    const nOf = (c: ChecksResult | null | undefined) =>
      c ? c.consoleErrors.length + c.overflow.length + c.brokenImgs.length + c.brokenHrefs.length : -1;
    const was = nOf(beforeChecks);
    const now = nOf(shot.value);
    const checkNote = was >= 0 && now >= 0 ? ` · сломанного: ${was} → ${now}` : "";
    const regressed = was >= 0 && now > was;
    if (was >= 0 && now >= 0) report.checks = { before: was, after: now };
    report.builtAt = builtAt;
    report.changed = true;
    if (attempt > 1) report.retried = true;
    writeJson(path.join(ctx.dir, "human-fix.json"), report);

    const head =
      report.requested === 1
        ? (items[0]!.patch.note?.trim() || "правка применена")
        : `правки: ${report.applied} из ${report.requested}` +
          (report.applied < report.requested
            ? ` — не сделано: ${report.items.filter((it) => !it.done).map((it) => `«${it.text.slice(0, 40)}»`).join(", ")}`
            : "");
    return {
      ok: true,
      value:
        head +
        (attempt > 1 ? " (со второй попытки) " : "") +
        "· страница пересобрана" +
        (fresh.ok ? " · export/ обновлён" : " · ⚠ export не собрался") +
        checkNote +
        (regressed ? " — ⚠ правка добавила поломок, проверьте превью" : ""),
      usage: usageSum,
      artifact: "overrides.css / overrides.html",
    };
  }
  return { ok: false, error: { klass: "fatal", message: "humanFix: цикл попыток завершился без результата" } };
}

/**
 * Что человек УЖЕ просил и это лежит в сборке: дешёвая модель фиксера без
 * этого раздела каждый раз «чинит» заново — и раунд, байт в байт повторяющий
 * применённое правило, выглядел как «написали что готово, а изменений нет».
 */
function appliedPatchesSummary(dir: string): string {
  const bits: string[] = [];
  const css = clip(readText(path.join(dir, "overrides.css")), 3_000);
  if (css) bits.push(css);
  const sw = readJson<Array<{ from: string; to: string }>>(path.join(dir, "img-swaps.json")) ?? [];
  if (sw.length) bits.push("замены картинок: " + sw.map((s) => `${s.from} → ${s.to}`).join(", "));
  const oh = readText(path.join(dir, "overrides.html"));
  if (oh) {
    const ids = [...oh.matchAll(/<(?:section|footer|header|div|figure|article)[^>]*\bid="([^"]+)"/g)].map((m) => `#${m[1]}`);
    const n = (oh.match(/<(?:section|footer|header|div|figure|article)[\s>]/gi) ?? []).length;
    bits.push(`html-дописки: ${ids.length ? ids.join(", ") : `${n} блок(ов) без id`}`);
  }
  return bits.join("\n") || "(ручных правок ещё не было)";
}

/** Следующий свободный black_NNN по реестру рядом с projectsRoot (не перенумеровывать). */
function nextFolderNumber(dir: string): string {
  const registry = path.join(path.dirname(dir), "LANDING_REGISTRY.md");
  const used = new Set<number>();
  try {
    for (const m of fs.readFileSync(registry, "utf8").matchAll(/black_(\d{3})/g))
      used.add(Number(m[1]));
  } catch {
    /* реестра ещё нет */
  }
  for (const f of safeReaddir(path.dirname(dir))) {
    const m = /^black_(\d{3})$/.exec(f);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n) || n < 26) n++;
  return String(n).padStart(3, "0");
}

export async function report(ctx: TasksCtx): Promise<RunResult<string>> {
  const verdict = readJson<Verdict>(path.join(ctx.dir, "preview", `verdict-r${ctx.round}.json`));
  const checks = readJson<ChecksResult>(
    path.join(ctx.dir, "preview", `checks-r${ctx.round}.json`),
  );
  const manifest = readJson<{ images?: ImageArtifact[] }>(path.join(ctx.dir, "manifest.json"));
  const rows = (manifest?.images ?? [])
    .map((i) => `| ${i.slug} | ${i.status} | ${i.file ?? "—"} | ${i.error ?? ""} |`)
    .join("\n");
  const defects = (verdict?.defects ?? [])
    .map((d) => `- **${d.severity}** ${d.message}${d.selector ? ` (\`${d.selector}\`)` : ""}`)
    .join("\n");

  const md = [
    `# Отчёт прогона ${path.basename(ctx.dir)} · раунд ${ctx.round}`,
    `Дата: ${new Date().toISOString()}`,
    "",
    `## Вердикт`,
    `Критичных: **${verdict?.critical ?? "?"}** · ${verdict?.summary ?? ""}`,
    checks?.visionUsed === false ? "⚠ vision-пасс не выполнялся (детекторы без зрения)" : "",
    "",
    `## Машинные проверки`,
    `- console: ${checks?.consoleErrors.length ?? 0}`,
    `- переполнение: ${checks?.overflow.length ?? 0}`,
    `- пустые блоки: ${checks?.emptyBlocks.length ?? 0}`,
    `- анкоры: ${checks?.missingAnchors.join(", ") || "все на месте"}`,
    `- битые ссылки: ${checks?.brokenHrefs.length ?? 0}`,
    `- картинки не загрузились: ${checks?.brokenImgs?.length ?? 0}`,
    `- низкий контраст: ${checks?.lowContrast?.length ?? 0}`,
    checks?.note ? `- примечание: ${checks.note}` : "",
    "",
    `## Дефекты`,
    defects || "нет",
    "",
    `## Картинки`,
    `| slug | статус | файл | ошибка |`,
    `|---|---|---|---|`,
    rows || "—",
    "",
    readText(path.join(ctx.dir, "export-note.md")) || "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  fs.writeFileSync(path.join(ctx.dir, "report.md"), md + "\n");
  return { ok: true, value: md, artifact: "report.md" };
}

/** «Догенерить картинки» — пост-операция без переписывания HTML (SPEC §6). */
export async function regenFailedImages(dir: string): Promise<number> {
  const m = readJson<RunManifest>(path.join(dir, "manifest.json"));
  const failed = (m?.images ?? []).filter(
    (i) => i.status === "failed" || i.status === "placeholder",
  );
  let n = 0;
  for (const a of failed) {
    const ctx: TasksCtx = {
      dir,
      mode: m?.mode ?? "white",
      brief: readJson<Brief>(path.join(dir, "brief.json"))! as Brief,
      plan: readJson<SitePlan>(path.join(dir, "site-plan.json")) as SitePlan,
      round: 0,
      defects: [],
      emit: () => {},
      signal: new AbortController().signal,
    };
    if (!ctx.plan || !ctx.brief) return n;
    const r = await image(ctx, a.slug);
    if (r.ok) n++;
  }
  // осевшие svg-плейсхолдеры перевыпущенных slug: они больше ни на что не
  // ссылаются, но кочевали assets → dist → export и удваивали картинки в архиве
  cleanStalePlaceholders(dir);
  return n;
}

/** Удалить svg-заглушки тех slug, чей растр (webp/png/jpg/avif) уже на диске. */
export function cleanStalePlaceholders(dir: string): void {
  const imgDir = path.join(dir, "assets", "img");
  let files: string[];
  try {
    files = fs.readdirSync(imgDir);
  } catch {
    return;
  }
  const raster = new Set(
    files.filter((f) => /\.(webp|png|jpe?g|avif)$/i.test(f)).map((f) => f.replace(/\.[^.]+$/, "")),
  );
  for (const f of files) {
    if (!/\.svg$/i.test(f)) continue;
    if (!raster.has(f.replace(/\.svg$/i, ""))) continue;
    fs.rmSync(path.join(imgDir, f), { force: true });
  }
}

/**
 * Реальные имена картинок проекта — для фиксера.
 * В прогоне-прецеденте модель на правку «добавь картинки» вставила секцию с 12
 * выдуманными src (gallery-1.jpg … gallery-lab-4.jpg), а на диске 9 файлов
 * .webp с другими именами: remap простил выдуманные имена по словам, но на 12
 * имён файлов не хватило — итог «сломанного: 0 → 7». Фиксер обязан видеть,
 * чем он реально располагает, а не угадывать.
 */
/**
 * Где какая картинка стоит: каждой — секция, в которой она нарисована, плюс
 * пометка «ДУБЛЬ» если тот же src встречается в page.json больше одного раза.
 * Без этой карты модель на «убери дубли картинок» прятала первую попавшуюся
 * (замер: спрятали img внутри feature-плитки, а реальный дубль — секции
 * `gallery` и `campus-gallery`, печатающие одни и те же 6 файлов).
 */
function imageMap(html: string): string {
  const secs = [...html.matchAll(/<(section|footer|header|nav)([^>]*)>/g)].map((m) => {
    const attrs = m[2] ?? "";
    return {
      at: m.index ?? 0,
      name: /id="([^"]+)"/.exec(attrs)?.[1] ?? /class="([^"]+)"/.exec(attrs)?.[1] ?? m[1],
    };
  });
  const rows: string[] = [];
  const seen = new Map<string, number>();
  for (const m of html.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)) {
    const src = m[1];
    const at = m.index ?? 0;
    const owner = [...secs].reverse().find((s) => s.at < at)?.name ?? "—";
    seen.set(src, (seen.get(src) ?? 0) + 1);
    rows.push(`${src.split("/").pop()} → секция «${owner}»`);
  }
  const dups = [...seen].filter(([, n]) => n > 1);
  const text = rows.slice(0, 40).join("\n");
  if (!dups.length) return text || "( картинок нет)";
  return (
    text +
    "\n\nПОВТОРЯЮЩИЕСЯ src: " +
    dups.map(([s, n]) => `${s.split("/").pop()} x${n}`).join(", ") +
    " — если просят убрать дубль, правь СЕКЦИЮ из строки выше (или скрывай её), " +
    "а не первую картинку на странице."
  );
}

function listImageFiles(dir: string): string[] {
  return safeReaddir(path.join(dir, "assets", "img")).filter((f) => /\.(png|jpe?g|webp|svg|avif)$/i.test(f));
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

// ─── служебное ──────────────────────────────────────────────────────────
function placeholder(ctx: TasksCtx, slug: string, aspect: string): string {
  const [w, h] = ASPECT_SIZE[aspect] ?? ASPECT_SIZE["16:9"]!;
  const p = ctx.plan.palette;
  const bg = p.bg ?? "#EEF1F5";
  const fg = p.red ?? p.accent ?? "#8A94A6";
  const file = path.join(ctx.dir, "assets", "img", `${slug}.svg`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="100%" height="100%" fill="${bg}"/>` +
      `<rect x="${w * 0.04}" y="${h * 0.04}" width="${w * 0.92}" height="${h * 0.92}" fill="none" stroke="${fg}" stroke-opacity="0.35" stroke-width="${Math.round(w / 60)}"/>` +
      `<text x="50%" y="50%" fill="${fg}" fill-opacity="0.75" font-family="Inter, DejaVu Sans, sans-serif" font-size="${Math.round(w / 16)}" text-anchor="middle" dominant-baseline="middle">${slug}</text>` +
      `</svg>\n`,
  );
  return file;
}

function findAsset(dir: string, slug: string): string | null {
  const dirImg = path.join(dir, "assets", "img");
  for (const ext of ["webp", "png", "jpg", "jpeg", "svg", "avif"]) {
    const f = path.join(dirImg, `${slug}.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  }
  return null;
}

/**
 * Модель часто пишет <img src="hero.jpg"> своими именами, игнорируя слаг
 * «hero-doctor-patient». Если src — относительный путь без папки и его корень
 * узнаваемо совпадает с одним из реальных файлов (slug начинается с него или
 * наоборот), подменяем на реальный файл. Не совпало — не трогаем: пусть
 * чекер честно доложит о битом src.
 */
export function remapLooseImgs(html: string, imgDir: string): string {
  let real: string[];
  try {
    real = fs.readdirSync(imgDir).filter((f) => /\.(png|jpe?g|webp|svg|avif)$/i.test(f));
  } catch {
    return html;
  }
  if (!real.length) return html;
  const roots = new Map<string, string>();
  // реальный файл важнее плейсхолдера: после «Догенерить картинки» рядом лежат
  // gallery-campus.png и прежний gallery-campus.svg с одним корнем имени, а
  // Map.set отдавал победу последнему в readdir — то есть svg-заглушке
  const EXT_RANK: Record<string, number> = { webp: 0, png: 1, jpg: 1, jpeg: 1, avif: 1, svg: 9 };
  const rank = (f: string) => EXT_RANK[(f.split(".").pop() ?? "").toLowerCase()] ?? 5;
  for (const f of real) {
    const root = f.replace(/\.[^.]+$/, "").toLowerCase();
    const prev = roots.get(root);
    if (!prev || rank(f) < rank(prev)) roots.set(root, f);
  }
  const used = new Set<string>();
  // одно и то же выдуманное имя встречается в странице несколько раз (карточка
  // галереи + lightbox): без мемо вторая копия утаскивала бы СЛЕДУЮЩИЙ файл
  const memo = new Map<string, string>();
  const take = (root: string): string => {
    used.add(roots.get(root)!);
    return roots.get(root)!;
  };
  return html.replace(/\bsrc=["'](?!https?:|data:|\/)([^"']+\.(?:png|jpe?g|webp|svg|avif))["']/gi, (m, src: string) => {
    const base = src.split("/").pop() ?? "";
    const key = base.replace(/\.[^.]+$/, "").toLowerCase();
    if (roots.has(key)) {
      used.add(roots.get(key)!);
      return m.replace(base, roots.get(key)!);
    }
    // «consult-room.jpg» → «consultation-room.png»: префиксное совпадение по первому слову
    const head = key.split(/[-_]/)[0];
    const cands = [...roots.keys()].filter((r) => head.length >= 4 && (r.startsWith(head) || key.startsWith(r.split(/[-_]/)[0])));
    if (cands.length === 1) return m.replace(base, take(cands[0]));
    // модель придумала имя целиком («desert-rally-hero.jpg» вместо «hero.png»):
    // берём реальный файл с максимумом совпавших слов имени; при равенстве —
    // первый по алфавиту из ещё не занятых (два выдуманных имени не должны
    // вести в один файл). Без этого шага страница уходила с 8 битыми src,
    // которые CSS-фиксер починить не может в принципе
    const words = key.split(/[-_]/).filter((w) => w.length >= 3);
    const last = key.split(/[-_]/).filter((w) => w.length >= 3).pop();
    // то же имя во второй раз обязан вести в тот же файл
    if (memo.has(key)) {
      const f = memo.get(key)!;
      used.add(f);
      return m.replace(base, f);
    }
    let best = "";
    let bestHits = 0;
    for (const r of [...roots.keys()].sort()) {
      if (used.has(roots.get(r)!)) continue;
      // последнее слово выдуманного имени — головное («desert-rally-hero» → hero),
      // весит вдвое: иначе «hero» проигрывал алфавитному «cta-desert» по слову «desert»
      const hits = words.reduce((s, w) => s + (r.includes(w) ? (w === last ? 3 : 1) : 0), 0);
      if (hits > bestHits) {
        best = r;
        bestHits = hits;
      }
    }
    if (bestHits) {
      memo.set(key, take(best));
      return m.replace(base, memo.get(key)!);
    }
    // совпавших слов нет вовсе (модель звала «gallery-waterfront.jpg», а в плане
    // его не было): битая иконка браузера хуже, чем фото из той же пачки —
    // берём любой ещё не занятый файл
    const spare = [...roots.keys()].sort().find((r) => !used.has(roots.get(r)!));
    if (spare) {
      memo.set(key, take(spare));
      return m.replace(base, memo.get(key)!);
    }
    // Свободных нет: на правку «добавь галерею» модель придумала 12 имён, а на
    // диске 9 файлов — последние src остались выдуманными и дали «сломанного
    // 0 → 7». Повторить уже использованный файл честнее битой иконки; из
    // занятых предпочитаем тех, в чьём имени есть слово из запроса
    const pool = [...roots.entries()].sort(([a], [b]) => a.localeCompare(b));
    const reuse =
      pool.find(([root]) => words.some((w) => root.includes(w)) && used.has(roots.get(root)!)) ?? pool[0];
    if (reuse) {
      memo.set(key, reuse[1]);
      return m.replace(base, reuse[1]);
    }
    return m;
  });
}

/** Честная плашка в манифесте: прогон прошёл, но картинок нет. */
function markImagesDegraded(ctx: TasksCtx, why: string): void {
  const f = path.join(ctx.dir, "manifest.json");
  const m = readJson<RunManifest>(f);
  if (!m || m.imagesDegraded) return;
  m.imagesDegraded = true;
  m.notes = why;
  writeJson(f, m);
}

function setArtifact(ctx: TasksCtx, a: ImageArtifact): void {
  const f = path.join(ctx.dir, "manifest.json");
  const m = readJson<{ images?: ImageArtifact[] }>(f);
  if (!m) return;
  m.images = m.images ?? [];
  const i = m.images.findIndex((x) => x.slug === a.slug);
  if (i >= 0) m.images[i] = { ...m.images[i], ...a };
  else m.images.push(a);
  writeJson(f, m);
}

const slot = (slug: string, result: ImageArtifact["status"]): OrchEvent => ({
  t: "image.slot",
  slug,
  at: new Date().toISOString(),
  result,
});

function pickShot(dir: string, shots: Array<{ breakpoint: number; file: string }>): string | null {
  const order = [375, 1280, 768];
  for (const bp of order) {
    const s = shots.find((x) => x.breakpoint === bp);
    if (s && fs.existsSync(s.file) && fs.statSync(s.file).size > 0) return s.file;
  }
  for (const s of shots) if (fs.existsSync(s.file)) return s.file;
  void dir;
  return null;
}

function mimeOf(f: string): string {
  return /\.(png|webp|gif|jpe?g)$/i.test(f) ? `image/${f.split(".").pop()!.replace("jpg", "jpeg")}` : "image/png";
}

/** Фрагмент HTML вокруг селектора: #id → секция, класс → строки с ним. */
/**
 * «Картa страницы» для фиксера: каждый секция/футер одной строкой — tag, id,
 * классы и первые слова заголовка. Первая правка человека лечит это:
 * htmlFragment = clip(html, 3000) — это ОДНИ head'ы, фиксер не видел ни одной
 * секции и на «перестроить футер» честнейше дописывал второй футер и вторые
 * CTA, потому что первых в его обзоре не было.
 */
function outlineOf(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/<(section|footer|header|nav)([^>]*)>/g)) {
    const attrs = m[2] ?? "";
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? "—";
    const cls = /class="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const body = html.slice(m.index, m.index + 1500);
    const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/.exec(body)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    out.push(`<${m[1]} id="${id}"${cls ? ` class="${cls}"` : ""}> ${oneLine(h).slice(0, 40)}`);
  }
  return out.join("\n") || "(секций не найдено)";
}

function fragmentOf(html: string, selector: string): string {
  const m = /^#([\w-]+)/.exec(selector.trim());
  if (m) {
    const i = html.indexOf(`id="${m[1]}"`);
    if (i >= 0) return clip(html.slice(Math.max(0, i - 200), i + 2000), 4000);
  }
  const c = /\.([\w-]+)/.exec(selector.trim());
  if (c) {
    const i = html.indexOf(c[1]);
    if (i >= 0) return clip(html.slice(Math.max(0, i - 400), i + 1200), 4000);
  }
  return clip(html, 3000);
}

function insertIntoHead(html: string, block: string): string {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  ${block}\n</head>`);
  return insertBeforeClose(html, "body", block);
}

/** JS всегда внутри body: модели возвращают голый код без <script>. */
function insertJsIntoBody(html: string, js: string): string {
  const tag = `<script>\n${js}\n</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}\n</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${tag}\n</html>`);
  return `${html}\n${tag}`;
}

function insertBeforeClose(html: string, tag: "body" | "script", block: string): string {
  const re = new RegExp(`</${tag}>`, "i");
  if (re.test(html)) return html.replace(re, `${block}</${tag}>`);
  return `${html}\n${block}`;
}

/**
 * Ссылки от корня домена в рабочей сборке (dist/).
 *
 * Модель пишет навигацию как на настоящем хостинге — `/about/`, `/contact/`,
 * `/`. На хостинге так и есть, но превью генератора раздаётся из
 * `/projects/<id>/dist/`, и клик по «About» вёл на `localhost:5173/about/`,
 * то есть на сам генератор (замер: после клика location = /about/, в DOM —
 * витрина). Правка только у путей: они становятся относительными к папке
 * сборки, а внешние (`https://`, `tel:`, `mailto:`, `#`, `data:`) не трогаются.
 *
 * Цель, которой в сборке нет (модель рисует `/policy/` при pageCount = 1),
 * ведёт на главную сборки — ровно как шаг 5b в экспорте, иначе превью
 * покрывалось бы 404 вместо клика.
 */
function previewLinks(
  html: string,
  opts: { distDir: string; built: string[]; depth: number },
): string {
  const { distDir, built, depth } = opts;
  const up = depth ? "../" : "./";
  const known = new Set(built);
  const swap = (raw: string, attr: string): string => {
    // только корневые пути: всё остальное (относительное, протокольное, якорь)
    if (!raw.startsWith("/") || raw.startsWith("//")) return `${attr}="${raw}"`;
    const slug = raw.replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
    if (!slug || !known.has(slug)) return `${attr}="${up}"`; // главная или нет такой страницы
    return `${attr}="${up}${slug}/"`;
  };
  let out = html.replace(/\b(href)="([^"]*)"/g, (_m, a: string, v: string) => swap(v, a));
  // картинки/скрипты от корня — та же история: они бы просили /assets/... в корне
  out = out.replace(/\b(src)="(\/[^"]*)"/g, (_m, a: string, v: string) => {
    const rel = v.replace(/^\/+/, "");
    return fs.existsSync(path.join(distDir, ...rel.split("/")))
      ? `${a}="${depth ? "../" : ""}${rel}"`
      : `${a}="${v}"`;
  });
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(обрезано)" : s;
}
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 120).replace(/\*\//g, "");
}
function rel(dir: string, abs: string): string {
  return path.relative(dir, abs).split(path.sep).join("/");
}
function slugify(s: string, fallback: string): string {
  const out = String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0430-\u044f]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || fallback;
}
function normAspect(a: unknown): SitePlan["images"][number]["aspect"] {
  return a === "16:9" || a === "3:4" || a === "1:1" || a === "9:16" || a === "4:3" ? a : "16:9";
}
function normRole(r: unknown): SitePlan["images"][number]["role"] {
  return r === "hero" || r === "avatar" || r === "background" || r === "content" ? r : "content";
}

export function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Vision-способность активной модели — один раз на прогон, для честного плашки. */
let visionCache: boolean | null = null;
export async function visionReady(): Promise<boolean> {
  if (visionCache !== null) return visionCache;
  try {
    const { c, model } = resolveLlm("code");
    visionCache = await probeVision(c, model);
  } catch {
    visionCache = false;
  }
  return visionCache;
}
