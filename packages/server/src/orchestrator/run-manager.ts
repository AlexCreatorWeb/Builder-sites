/**
 * RunManager — один инстанс на прогон (SPEC §6).
 * Держит AbortSignal, шлюз плана, цикл фиксов; правда на диске:
 * run.jsonl + артефакты, поэтому прогон восстанавливается после падения.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  Brief,
  ChecksResult,
  Defect,
  OrchEvent,
  RunCommand,
  RunManifest,
  RunStatus,
  SitePlan,
  Verdict,
} from "@builder/shared";
import { settings } from "../config.ts";
import { makeZip } from "../delivery.ts";
import { Scheduler } from "./scheduler.ts";
import { buildRoundTasks, type TaskHelpers } from "./graph.ts";
import * as tasks from "../tasks/index.ts";
import { withPlanHash } from "../tasks/index.ts";
import { shortHash } from "../prompts/render.ts";
import type { RunResult, Task, TaskCtx } from "./types.ts";

export interface RunHandle {
  projectId: string;
  dir: string;
  status: RunStatus;
  subscribe: (fn: (e: OrchEvent) => void) => () => void;
  last: OrchEvent[];
  command: (cmd: RunCommand, detail?: string) => void;
  /** правка плана из gate-карточки: пересчёт planHash + запись на диск */
  patchPlan: (plan: SitePlan) => { ok: boolean; planHash?: string; error?: string };
}

/**
 * Шлюз: промис, который закрывает UI кнопкой «Поехали»/skip-gate.
 * «Перегенерить с комментарием» не закрывает шлюз, а пересобирает план
 * и открывает карточку заново — поэтому у шлюза два сигнала.
 */
class Gate {
  private resolve!: () => void;
  promise = new Promise<void>((res) => (this.resolve = res));
  closed = false;
  regenComment: string | null = null;
  private fire(): void {
    this.resolve();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire();
  }
  regen(comment: string): void {
    if (this.closed) return;
    this.regenComment = comment;
    this.fire();
  }
  /** ждать следующего закрытия (после перегенерации — нового) */
  rearm(): void {
    this.regenComment = null;
    this.promise = new Promise<void>((res) => (this.resolve = res));
  }
}

/**
 * Ревью собранного сайта (между «сборка готова» и «выгружено»).
 * Один промис = один вопрос человеку: смотреть/править/выгрузить. После каждой
 * правки шлюз перезаряжается — review живёт столько, сколько нужно человеку.
 */
type ReviewReq =
  | { kind: "accept" }
  | { kind: "deliver"; path?: string; desktop?: boolean }
  | { kind: "fix"; comment: string };

class Review {
  private resolve!: (r: ReviewReq) => void;
  promise = new Promise<ReviewReq>((res) => (this.resolve = res));
  closed = false;
  submit(r: ReviewReq): void {
    if (this.closed) return;
    this.closed = true;
    this.resolve(r);
  }
  rearm(): void {
    this.closed = false;
    this.promise = new Promise<ReviewReq>((res) => (this.resolve = res));
  }
}

export function createRun(projectId: string): RunHandle {
  const s = settings();
  const dir = path.join(s.projectsRoot, projectId);
  fs.mkdirSync(path.join(dir, "assets", "img"), { recursive: true });
  fs.mkdirSync(path.join(dir, "preview"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });

  const listeners = new Set<(e: OrchEvent) => void>();
  const last: OrchEvent[] = [];
  const emit = (e: OrchEvent): void => {
    last.push(e);
    if (last.length > 500) last.shift();
    // журнал — best-effort: при «Назад в бриф» папка проекта уже стёрта,
    // а незакрытый ENOENT здесь ронял весь API-процесс (проверено в логе)
    try {
      fs.appendFileSync(path.join(dir, "run.jsonl"), JSON.stringify(e) + "\n");
    } catch {
      /* папки нет (back/удаление) — событие живёт только в last */
    }
    for (const fn of listeners) fn(e);
  };

  const ctrl = new AbortController();
  const gate = new Gate();
  const review = new Review();
  /** живой планировщик раунда: через него «resume» снимает шторм-паузу на месте */
  const schedRef: { current: Scheduler | null } = { current: null };
  let status: RunStatus = "draft";
  /** план, отредактированный в gate (перекрывает сгенерированный) */
  let editedPlan: SitePlan | null = null;
  let gateComment = "";
  /** «Назад в бриф» из gate: отменить и стереть папку, чтобы номер не сгорел */
  let backRequested = false;

  const setState = (st: RunStatus): void => {
    status = st;
    emit({ t: "run.state", state: st, at: new Date().toISOString() });
  };

  const handle: RunHandle = {
    projectId,
    dir,
    get status() {
      return status;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    last,
    command(cmd, detail) {
      emit({ t: "command", cmd, at: new Date().toISOString(), detail });
      if (cmd === "skip-gate") gate.close();
      if (cmd === "regen-plan") gate.regen(detail ?? "сделай план иначе, сохранив Brief");
      if (cmd === "cancel") {
        // причина в журнал: без неё «cancelled» висит без объяснения,
        // а человек не понимает, упало ли всё или он сам нажал
        emit({ t: "task.error", task: "run", at: new Date().toISOString(), klass: "fatal", message: "прогон отменён вручную (кнопка «Отмена»)" });
        ctrl.abort();
        gate.close(); // прогон может стоять в await gate.promise — будим, иначе висит навсегда
      }
      if (cmd === "back") {
        // «Назад в бриф» из gate: отменить и стереть папку — номер не сгорает, конфликта нет
        backRequested = true;
        ctrl.abort();
        gate.close();
      }
      if (cmd === "pause") setState("paused");
      if (cmd === "resume") {
        // если прогон стоит в шторм-паузе — разморозить планировщик и повторить
        // отбракованные задачи; иначе это просто выход из ручной паузы
        schedRef.current?.resume();
        setState("running");
      }
      if (cmd === "regen-images") void tasks.regenFailedImages(dir);
      // ── ревью собранного сайта ──
      if (cmd === "accept") review.submit({ kind: "accept" });
      if (cmd === "deliver")
        review.submit({
          kind: "deliver",
          path: detail && detail !== "desktop" ? detail : undefined,
          desktop: detail === "desktop",
        });
      if (cmd === "human-fix" && detail) review.submit({ kind: "fix", comment: detail });
      if (cmd === "cancel") review.submit({ kind: "accept" }); // разбудит await в review
    },
    patchPlan(plan) {
      const normalized = sanitizePlan(plan);
      if (!normalized.ok) return { ok: false, error: normalized.error };
      editedPlan = withPlanHash(normalized.plan);
      tasks.writeJson(path.join(dir, "site-plan.json"), editedPlan);
      // gate.close здесь не эмитим: правка плана НЕ закрывает шлюз («Поехали» —
      // отдельная кнопка). Иначе UI спрятал бы карточку, а прогон остался в awaiting-gate.
      return { ok: true, planHash: editedPlan.planHash };
    },
  };

  void execute({
    dir,
    emit,
    signal: ctrl.signal,
    gate,
    review,
    setState,
    schedRef,
    getEditedPlan: () => editedPlan,
    getGateComment: () => gateComment,
    setGateComment: (c: string) => (gateComment = c),
    isBack: () => backRequested,
  }).catch((err: unknown) => {
    setState("failed");
    emit({
      t: "task.error",
      task: "run",
      at: new Date().toISOString(),
      klass: "fatal",
      message: (err as Error).message,
    });
  });

  return handle;
}

interface Ctx {
  dir: string;
  emit: (e: OrchEvent) => void;
  signal: AbortSignal;
  gate: Gate;
  review: Review;
  setState: (s: RunStatus) => void;
  schedRef: { current: Scheduler | null };
  getEditedPlan: () => SitePlan | null;
  getGateComment: () => string;
  setGateComment: (c: string) => void;
  isBack: () => boolean;
}

async function execute(ctx: Ctx): Promise<void> {
  const s = settings();
  const { dir, emit, signal, setState } = ctx;
  const schedRef = ctx.schedRef;
  setState("planning");

  const briefPath = path.join(dir, "brief.json");
  const brief = tasks.readJson<Brief>(briefPath);
  if (!brief)
    throw new Error(
      `Нет валидного brief.json (${briefPath}) — создай прогон из UI или почини JSON`,
    );

  // 1. План: готовый с диска (восстановление) или свежий от модели
  let plan = reusePlan(dir, brief);
  if (plan) {
    emit({ t: "task.done", task: "plan", at: new Date().toISOString(), cached: true });
  } else {
    const r = await tasks.plan(
      taskCtx(dir, brief, placeholderPlan(), 0, [], emit, signal),
    );
    if (!r.ok || !r.value)
      throw new Error(r.error?.message ?? "план не сгенерирован");
    plan = r.value;
    emit({ t: "task.done", task: "plan", at: new Date().toISOString(), usage: r.usage });
  }

  // 2. Единственный шлюз (SPEC §7): «Поехали», правка плана, или перегенерация
  while (s.gates.afterPlan && !ctx.gate.closed) {
    setState("awaiting-gate");
    emit({
      t: "gate.open",
      gate: "plan",
      plan,
      estimate: buildEstimate(plan),
    });
    await ctx.gate.promise;
    // «Отмена»/«Назад» будят шлюз через abort — выходим до любых токенных задач;
    // при «Назад» стираем папку: nextWhiteId снова отдаст white_001, конфликтов нет
    if (signal.aborted) {
      // состояние — до удаления папки: setState пишет в run.jsonl этой же папки
      if (ctx.isBack()) {
        setState("cancelled");
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      return void setState("cancelled");
    }
    const comment = ctx.gate.regenComment;
    if (comment !== null) {
      ctx.gate.rearm();
      setState("planning");
      const r = await tasks.plan(taskCtx(dir, brief, plan, 0, [], emit, signal), comment);
      if (r.ok && r.value) plan = r.value;
      else
        emit({
          t: "task.error",
          task: "plan",
          at: new Date().toISOString(),
          klass: r.error?.klass ?? "fatal",
          message: r.error?.message ?? "план не перегенерирован",
        });
      continue;
    }
    emit({
      t: "gate.close",
      gate: "plan",
      edited: Boolean(ctx.getEditedPlan()),
      at: new Date().toISOString(),
    });
  }
  plan = ctx.getEditedPlan() ?? plan;

  // Патчи фиксов дописываются к build/fix-r*, а assemble складывает их по раундам:
  // при перезапуске прогона старые патчи легли бы поверх новых и вернули бы
  // прежний брак (проверено: фикс из прошлого прогона прятал полстраницы).
  // Gate пройден — значит стартуем раунды честно, с чистого листа фиксов.
  try {
    for (const f of fs.readdirSync(path.join(dir, "build")))
      if (/^fix-r\d+\.(css|html)$/.test(f)) fs.rmSync(path.join(dir, "build", f));
  } catch {
    /* нет папки build — фиксов тем более нет */
  }

  // 3. Манифест картинок — контракт имён для кода и сборки
  const manifestPath = path.join(dir, "manifest.json");
  const manifest: RunManifest = tasks.readJson<RunManifest>(manifestPath) ?? {
    projectId: path.basename(dir),
    mode: brief.mode,
    status: "running",
    createdAt: new Date().toISOString(),
    images: plan.images.map((im) => ({ slug: im.slug, status: "pending" as const })),
    defects: [],
  };
  manifest.mode = brief.mode;
  manifest.status = "running";
  manifest.estimate = buildEstimate(plan);
  tasks.writeJson(manifestPath, manifest);

  const visionOk = await tasks.visionReady();
  if (!visionOk && s.requireVision === "block") {
    setState("needs_human");
    emit({
      t: "task.error",
      task: "judge",
      at: new Date().toISOString(),
      klass: "fatal",
      message: "vision недоступен, а requireVision = block",
    });
    return;
  }

  // 4. Раунды: сборка → съёмка → вердикт → фиксы
  let round = 0;
  let defects: Defect[] = [];
  for (;;) {
    setState("running");
    const sched = new Scheduler({ lanes: { ...s.lanes, fs: 2 }, emit, signal });
    schedRef.current = sched;
    const helpers = buildHelpers(dir, brief, plan, round, defects, emit, signal);
    const imageSlugs =
      s.selection.imageMode === "api" || s.selection.imageMode === "manual"
        ? plan.images.map((i) => i.slug)
        : [];
    const roundTasks = buildRoundTasks(
      {
        projectId: manifest.projectId,
        plan,
        manifest,
        imageSlugs,
        fixRound: round,
        defects,
        finalize: (r) => {
          // финализируем, когда вердикт зелёный или раунды фиксов кончились
          const v = readVerdict(dir, r);
          return v.critical === 0 || r >= s.maxFixRounds;
        },
      },
      helpers,
    );
    sched.addAll(roundTasks);
    // gate пройден до графа раунда — в графе он тривиальная завершённая задача
    sched.markDone("gate:plan", { ok: true });
    if (round > 0) {
      // артефакты первого раунда лежат на диске: задачи текстов/кода не пересоздаются
      const pageIds = ["index", ...(plan.pages ?? []).map((pg) => pg.slug)];
      for (const pg of pageIds)
        for (const base of ["copy", "code"]) {
          const id = pg === "index" ? `${base}:r0` : `${base}:r0:${pg}`;
          sched.markDone(id, { ok: true });
        }
      sched.markDone("image-prompts", { ok: true });
      for (const slug of imageSlugs) sched.markDone(`image:${slug}`, { ok: true });
    }

    const { completed, storm } = await sched.run({ projectId: manifest.projectId, dir, signal, emit });
    if (signal.aborted) return void setState("cancelled");
    if (storm) return void setState("paused");
    if (!completed) return void setState("needs_human");

    const verdict = readVerdict(dir, round);
    defects = verdict.defects;
    // task-слой писал манифест на диске (статусы картинок) — перечитываем,
    // иначе перезапишем их устаревшей копией из памяти
    const fresh = tasks.readJson<RunManifest>(manifestPath);
    if (fresh) Object.assign(manifest, fresh, { projectId: manifest.projectId });
    manifest.defects = defects;
    // статус в манифесте = куда прогон реально уйдёт после этой проверки,
    // а не «running» на всякий случай: по манифесту список проектов показывает
    // состояние после рестарта сервера, и «running» тут превращался в вечное «сборка…»
    manifest.status =
      verdict.critical === 0 ? "review" : round >= s.maxFixRounds ? "needs_human" : "running";
    tasks.writeJson(manifestPath, manifest);

    if (verdict.critical === 0) {
      // сборка готова — НО не выгружать молча: человек смотрит сайт на
      // локальном сервере и решает сам. Здесь прогон стоит в «review»
      // столько, сколько нужно, а в done уходит только по accept/deliver
      return await reviewLoop(ctx, manifest, manifestPath, brief, plan, round);
    }
    if (round >= s.maxFixRounds) {
      // красный вердикт — тоже ревью, только состояние «needs_human»: человек
      // смотрит, правит своими словами и всё равно может принять/выгрузить.
      // Иначе команда «Допилить» в UI уткнулась бы в мёртвый прогон
      return await reviewLoop(ctx, manifest, manifestPath, brief, plan, round, "needs_human");
    }
    round++;
    emit({
      t: "fix.round",
      round,
      at: new Date().toISOString(),
      defectsFixed: verdict.defects.filter((d) => d.fixed).length,
    });
  }
}

/**
 * Петля ревью: состояние review держится, пока человек не примет сборку и не
 * выгрузит её (или не отменит прогон). Правка = tasks.humanFix (патч в
 * overrides.* + assemble + shoot БЕЗ vision-судьи) — раунды не ограничены
 * maxFixRounds, это не автофиксы судьи, а заказы человека.
 */
async function reviewLoop(
  ctx: Ctx,
  manifest: RunManifest,
  manifestPath: string,
  brief: Brief,
  plan: SitePlan,
  /** раунд, на котором вердикт стал зелёным: assemble обязан продолжить читать
   * его build/fix-rN.html, иначе human-fix молча вернёт старый HTML */
  verdictRound: number,
  /** состояние простоя: review (вердикт чист) или needs_human (красный вердикт) */
  idleState: RunStatus = "review",
): Promise<void> {
  const { dir, emit, signal, setState, review } = ctx;
  let round = 0;
  for (;;) {
    setState(idleState);
    emit({ t: "review.update", at: new Date().toISOString() });
    const req = await review.promise;
    if (signal.aborted) return void setState("cancelled");

    if (req.kind === "accept") {
      finishToDone(ctx, manifest, manifestPath);
      return;
    }
    if (req.kind === "deliver") {
      // цель из клика (пилюля/обозреватель) перекрывает выбор брифа;
      // «в генераторе» = копия не нужна, это тоже accept
      const choice = req.desktop
        ? ({ kind: "desktop" } as const)
        : req.path
          ? ({ kind: "folder", path: req.path } as const)
          : undefined;
      try {
        tasks.placeExport(dir, emit, choice);
      } catch (err) {
        // выгрузка не удалась — остаёмся в review: человек увидит причину
        // в логе и повторит или примет без выгрузки
        emit({
          t: "task.error",
          task: "deliver",
          at: new Date().toISOString(),
          klass: "fatal",
          message: (err as Error).message,
        });
        review.rearm();
        continue;
      }
      finishToDone(ctx, manifest, manifestPath);
      return;
    }

    // human-fix: патч по словам человека, пересборка, съёмка. Ошибка — не
    // выкидывает из review: пишем причину и ждём следующей команды
    setState("running");
    emit({ t: "task.start", task: `human-fix:r${round + 1}`, at: new Date().toISOString() });
    const r = await tasks.humanFix(
      {
        dir,
        mode: brief.mode,
        brief,
        plan,
        round: verdictRound,
        defects: [],
        emit,
        signal,
      },
      req.comment,
    );
    if (r.ok) {
      emit({
        t: "task.done",
        task: `human-fix:r${round + 1}`,
        at: new Date().toISOString(),
        usage: r.usage,
      });
      emit({ t: "review.update", at: new Date().toISOString(), note: String(r.value ?? "") });
    } else {
      emit({
        t: "task.error",
        task: `human-fix:r${round + 1}`,
        at: new Date().toISOString(),
        klass: r.error?.klass ?? "fatal",
        message: r.error?.message ?? "правка не применена",
      });
      emit({
        t: "review.update",
        at: new Date().toISOString(),
        error: r.error?.message ?? "правка не применена",
      });
    }
    round++;
    review.rearm();
  }
}

/** done: снимок в библиотеку (zip + промпт + index.json) и состояние. */
function finishToDone(ctx: Ctx, manifest: RunManifest, manifestPath: string): void {
  const { setState } = ctx;
  manifest.status = "done";
  manifest.finishedAt = new Date().toISOString();
  tasks.writeJson(manifestPath, manifest);
  try {
    librarySave(ctx.dir, manifest.projectId);
  } catch {
    /* библиотека не должна ронять завершённый прогон */
  }
  setState("done");
}

// ─── библиотека готовых проектов ────────────────────────────────────
// projects/ — рабочая папка прогона, её чистят без потерь: на done проект
// уезжает снимком в library/ (zip + промпт + index.json). Имена id считаются
// с учётом библиотеки — повторного white_NNN не случится.
export interface LibraryEntry {
  projectId: string;
  mode: string;
  niche?: string;
  createdAt: string;
  zip: string;
  hasPreview: boolean;
}

export function libraryDir(): string {
  return path.join(path.dirname(settings().projectsRoot), "library");
}

export function libraryIndex(): LibraryEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(libraryDir(), "index.json"), "utf8"));
    return Array.isArray(raw) ? (raw as LibraryEntry[]) : [];
  } catch {
    return [];
  }
}

export function librarySave(dir: string, projectId: string): LibraryEntry {
  const slot = path.join(libraryDir(), projectId);
  fs.mkdirSync(slot, { recursive: true });
  const idx = libraryIndex().filter((e) => e.projectId !== projectId);
  const brief = tasks.readJson<Record<string, unknown>>(path.join(dir, "brief.json"));
  // exportDirOf знает и про black_NNN/: без него чёрный снимок уходил в
  // библиотеку без zip (export/ к этому моменту уже переименован)
  const src = tasks.exportDirOf(dir);
  const hasEntry =
    fs.existsSync(path.join(src, "index.html")) || fs.existsSync(path.join(src, "index.php"));
  const zip = "site.zip";
  if (hasEntry) {
    // пишем во временное имя и переносим: полупистый zip от сбоя не подменит
    // валидный снимок. ВРЕМЕННОЕ ИМЯ ОБЯЗАТЕЛЬНО кончается на .zip:
    // python make_archive дописывает расширение сам, а «.site.zip.tmp» давал
    // «.site.zip.tmp.zip», который страховочный rmSync в makeZip стирал как
    // хвост — и снимок уходил в библиотеку без архива
    const tmp = path.join(slot, ".site.tmp.zip");
    fs.rmSync(tmp, { recursive: true, force: true });
    const err = makeZip(src, tmp, projectId);
    if (!err) fs.renameSync(tmp, path.join(slot, zip));
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  // brief + план рядом: «скачать промпт» работает и после чистки projects/
  for (const f of ["brief.json", "site-plan.json"]) {
    try {
      fs.copyFileSync(path.join(dir, f), path.join(slot, f));
    } catch {
      /* нет файла — не беда */
    }
  }
  const entry: LibraryEntry = {
    projectId,
    mode: typeof brief?.mode === "string" ? brief.mode : "white",
    niche: typeof brief?.niche === "string" ? brief.niche : undefined,
    createdAt: new Date().toISOString(),
    zip: fs.existsSync(path.join(slot, zip)) ? zip : "",
    hasPreview: fs.existsSync(path.join(dir, "preview")),
  };
  idx.push(entry);
  fs.writeFileSync(path.join(libraryDir(), "index.json"), JSON.stringify(idx, null, 2) + "\n");
  return entry;
}

// ─── план: восстановление и правки ──────────────────────────────────────
function reusePlan(dir: string, brief: Brief): SitePlan | null {
  const p = tasks.readJson<SitePlan>(path.join(dir, "site-plan.json"));
  if (!p?.sections?.length || !p.images) return null;
  // промпт/Brief изменились → план устарел, генерируем заново
  if (p.briefHash && p.briefHash !== shortHash(JSON.stringify(brief))) return null;
  return withPlanHash(p);
}

function placeholderPlan(): SitePlan {
  return {
    version: 1,
    briefHash: "",
    planHash: "",
    sections: [],
    palette: {},
    fonts: { heading: "Manrope", body: "Inter" },
    images: [],
    hardRules: [],
  };
}

/** План из UI: только то, что мы умеем валидировать; всё остальное — как прислали. */
function sanitizePlan(
  p: SitePlan,
): { ok: true; plan: SitePlan } | { ok: false; error: string } {
  if (!Array.isArray(p?.sections) || !p.sections.length)
    return { ok: false, error: "plan.sections пуст" };
  const slugs = new Set<string>();
  for (const s of p.sections) {
    if (!s?.slug || !s?.type) return { ok: false, error: "у секции нет slug/type" };
    if (slugs.has(s.slug)) return { ok: false, error: `дублирующийся slug «${s.slug}»` };
    slugs.add(s.slug);
  }
  const imgSlugs = new Set<string>();
  for (const im of p.images ?? []) {
    if (!im?.slug) return { ok: false, error: "у картинки нет slug" };
    if (imgSlugs.has(im.slug)) return { ok: false, error: `дублирующийся slug картинки «${im.slug}»` };
    imgSlugs.add(im.slug);
  }
  const pageSlugs = new Set<string>();
  for (const pg of p.pages ?? []) {
    if (!pg?.slug || !Array.isArray(pg.sections) || !pg.sections.length)
      return { ok: false, error: "у страницы нет slug или секций" };
    if (pageSlugs.has(pg.slug) || pg.slug === "index")
      return { ok: false, error: `дублирующийся slug страницы «${pg.slug}»` };
    pageSlugs.add(pg.slug);
  }
  return { ok: true, plan: { ...p, version: p.version ?? 1 } };
}

function estimateTokens(plan: SitePlan): number {
  const inner = (plan.pages ?? []).reduce((n, pg) => n + pg.sections.length, 0);
  return 8000 + (plan.sections.length + inner) * 1200 + plan.images.length * 300;
}

/**
 * Ожидаемое МАШИННОЕ время прогона (без ожидания человека в шлюзе и ревью).
 * База — run.jsonl белого прогона до конца (white_004, факт 5 мин): copy и
 * промпты картинок ≈1.5 мин, КАРТИНКИ ДОРОЖКОЙ — 11 штук легли стеной в ~60 с,
 * а не 11×25 с, поэтому 0.15 мин/шт; код страницы ≈0.5 мин/секцию (5 секций =
 * 115 с) + сборка/съёмка/судья. white_001 дал 10 мин на тех же 9/5 — это
 * сетевой шторм с ретраями, и потому в UI стоит «≈», а не обещание: смета
 * честна для чистого прогона, не для аварии. Токены падают молча, время — нет:
 * без этой цифры прогон у стены выглядит зависшим.
 */
function estimateMinutes(plan: SitePlan): number {
  return Math.max(3, Math.round(1.5 + plan.images.length * 0.15 + plan.sections.length * 0.5));
}

function buildEstimate(plan: SitePlan) {
  return {
    images: plan.images.length,
    tokens: estimateTokens(plan),
    usd: 0,
    minutes: estimateMinutes(plan),
  };
}

// ─── помощники задач ────────────────────────────────────────────────────
function buildHelpers(
  dir: string,
  brief: Brief,
  plan: SitePlan,
  round: number,
  defects: Defect[],
  emit: (e: OrchEvent) => void,
  signal: AbortSignal,
): TaskHelpers {
  const p0 = plan;
  const ctx = () => taskCtx(dir, brief, plan, round, defects, emit, signal);
  return {
    task<T>(
      id: string,
      lane: Task<T>["lane"],
      dependsOn: string[],
      run: () => Promise<RunResult<T>>,
    ): Task<T> {
      return { id, lane, dependsOn, run };
    },
    copyPage: (pg) => tasks.copyPage({ ...ctx(), plan: p0 }, pg),
    imagePrompts: (p) => tasks.imagePrompts({ ...ctx(), plan: p }),
    image: (slug) => tasks.image(ctx(), slug),
    codePage: (pg) => tasks.codePage({ ...ctx(), plan: p0 }, pg),
    assemble: () => tasks.assemble(ctx()),
    shoot: () => tasks.shoot(ctx()),
    judge: () => tasks.judge(ctx()),
    fix: (d) => tasks.fixOne(ctx(), d),
    exportSite: () => tasks.exportSite(ctx()),
    report: () => tasks.report(ctx()),
  };
}

function taskCtx(
  dir: string,
  brief: Brief,
  plan: SitePlan,
  round: number,
  defects: Defect[],
  emit: (e: OrchEvent) => void,
  signal: AbortSignal,
): tasks.TasksCtx {
  return { dir, mode: brief.mode, brief, plan, round, defects, emit, signal };
}

function readVerdict(dir: string, round: number): Verdict {
  const parsed = tasks.readJson<Verdict>(path.join(dir, "preview", `verdict-r${round}.json`));
  if (!parsed)
    return { critical: 0, defects: [], summary: "вердикта нет — судья не оставил файла" };
  return {
    critical: parsed.critical ?? 0,
    defects: parsed.defects ?? [],
    summary: parsed.summary,
  };
}

export type { TaskCtx, ChecksResult };
