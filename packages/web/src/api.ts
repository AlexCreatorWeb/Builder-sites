/** Тонкий клиент сайдкара: только те роуты, которые уже есть на сервере. */
import type { Brief, OrchEvent, SitePlan } from "@builder/shared";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  // Заголовок ставим только когда тело правда есть. `fetch` с `method: "DELETE"`
  // и без body сохраняет content-type: application/json — и Fastify отвечает
  // 400 FST_ERR_CTP_EMPTY_JSON_BODY ещё до обработки роута (так и падало
  // удаление проекта), хотя сам роут был живой
  const hasBody = init?.body != null && String(init.body).length > 0;
  const r = await fetch(url, {
    ...init,
    headers: hasBody ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const msg = (data as { error?: string })?.error ?? `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/*
 * Снимок связи с серверного монитора (net/monitor.ts): путь до внешнего адреса
 * = «вайфай», путь до хоста провайдера + его DNS = «сторона провайдера»,
 * calls = длительность настоящих запросов (модель думает — это не сеть).
 */
export interface NetSample {
  at: string;
  online: boolean;
  link: { ok: boolean; ms: number | null };
  linkWindow: number[];
  connections: Array<{
    id: string;
    name: string;
    kind: string;
    host: string;
    hasKey: boolean;
    /** назначено ли подключение на роль — вердикт считает по активным */
    active: boolean;
    /** свободный health-пинг того же API: жив ли провайдер и каким кодом */
    health: { status: number; ms: number | null; at: number } | null;
    /**
     * Лента последних событий связи (~минута): рабочие запросы (call) и
     * бесплатные проверки (check). Полная зелёная = «всё хорошо».
     */
    ribbon: Array<{ code: number; kind: "call" | "check" }>;
    rtt: { ok: boolean; ms: number | null };
    dns: { ok: boolean; ms: number | null };
    calls: {
      count: number;
      lastMs: number | null;
      p50Ms: number | null;
      slowMs: number;
      /** HTTP-коды последних запросов, новые в конце; 0 = ответа не было */
      codes: number[];
    };
    /** задача целиком: генерация картинки / ответ модели — «сколько думает» */
    tasks: { count: number; lastMs: number | null; p50Ms: number | null; slowMs: number };
  }>;
}

export interface ConnectionsInfo {
  connections: Array<{
    id: string;
    name: string;
    /** определён сервером по хосту подключения, а не вписан руками */
    provider?: string;
    kind: string;
    enabled: boolean;
    baseUrl: string;
    protocol?: string;
    models: Array<{ id: string; label?: string }>;
    vision?: boolean;
    auth?: { mode: string; ref: string };
    limit?: { mode: string; unlimited?: boolean };
  }>;
  badges: Array<{
    connectionId: string;
    state: string;
    /** проценты 0..100, если квота известна */
    percent?: number;
    display: string;
    updatedAt: string;
    /** баланс не даёт пользоваться платными моделями (бесплатные — дают) */
    paidBlocked?: boolean;
  }>;
  /** «наша» пара подключений: к ней возвращает пилюля «← назад» */
  defaults?: {
    codeCopy: { connection: string; model: string | null };
    image: { connection: string; model: string | null };
  } | null;
  selection?: {
    codeCopy: { connection: string; model: string | null };
    image: { connection: string; model: string | null };
    imageMode: "api" | "none" | "manual";
  };
}

/*
 * Ответ «определить подключение по ключу»: needAddress=true значит, что ключ
 * не подсказывает хост и адрес придётся вписать (одно поле, не три).
 */
export interface DetectResult {
  needAddress: boolean;
  provider: string | null;
  kind: string | null;
  /** откуда известно назначение: endpoint = адрес из нашего списка (точно),
   *  models = список моделей выдал сам API, unknown = не известно, window =
   *  принято из окна, куда вставили ключ */
  kindSource?: "endpoint" | "models" | "unknown" | "window";
  baseUrl?: string;
  models?: number;
  quota?: { state: string; display: string } | null;
  hint?: string;
  error?: string;
  draft?: Record<string, unknown>;
}

/** Куда проект попадёт после генерации: папка + вердикт доступности. */
export interface DestInfo {
  kind: "here" | "desktop" | "folder" | "custom";
  /** ключ пилюли: here | desktop | folder|<путь> */
  value?: string;
  label: string;
  dir: string;
  sub: string;
  writable: boolean;
  note: string;
}

export const api = {
  health: () => j<{ ok: boolean; root: string; projectsRoot: string }>("/api/health"),
  net: () => j<NetSample>("/api/net"),
  netRefresh: () => j<NetSample>("/api/net/refresh", { method: "POST" }),
  connections: () => j<ConnectionsInfo>("/api/connections"),
  addConnection: (c: Record<string, unknown>, replace = false) =>
    j<{ ok: boolean; id: string; models?: number }>(
      `/api/connections${replace ? "?replace=1" : ""}`,
      { method: "POST", body: JSON.stringify(c) },
    ),
  /** подключение по одному ключу: провайдер/адрес/назначение/модели/лимит определяются сами.
   *  kind = куда вставляют ключ: если подошло несколько адресов, выбирают окно */
  detectConnection: (key: string, baseUrl?: string, kind?: "llm" | "image") =>
    j<DetectResult>("/api/connections/detect", {
      method: "POST",
      body: JSON.stringify({ key, baseUrl, kind }),
    }),
  patchConnection: (id: string, c: Record<string, unknown>) =>
    j<{ ok: boolean }>(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify(c) }),
  removeConnection: (id: string) =>
    j<{ ok: boolean }>(`/api/connections/${id}`, { method: "DELETE" }),
  pullModels: (id: string) =>
    j<{ ok: boolean; count: number }>(`/api/connections/${id}/models`, { method: "POST" }),
  /** вручную добавить/убрать модель: списку с /models доверять нельзя */
  addModel: (id: string, model: string, label?: string) =>
    j<{ ok: boolean; count: number }>(`/api/connections/${id}/models`, {
      method: "PATCH",
      body: JSON.stringify({ add: model, label }),
    }),
  removeModel: (id: string, model: string) =>
    j<{ ok: boolean; count: number }>(`/api/connections/${id}/models`, {
      method: "PATCH",
      body: JSON.stringify({ remove: model }),
    }),
  pullImageModels: (id: string) =>
    j<{ ok: boolean; count: number }>(`/api/connections/${id}/models/imagening`, { method: "POST" }),
  setSelection: (sel: Record<string, unknown>) =>
    j<{ ok: boolean }>("/api/selection", { method: "PUT", body: JSON.stringify(sel) }),
  /**
   * numbered: projectId — только основа серии (`white`), номер (`_036`) подбирает
   * сервер по уже собранным папкам и возвращает готовое имя в ответе.
   */
  createProject: (projectId: string, brief: Brief, opts?: { force?: boolean; numbered?: boolean }) =>
    j<{ projectId: string }>(`/api/projects${opts?.force ? "?force=1" : ""}`, {
      method: "POST",
      body: JSON.stringify({ projectId, brief, numbered: opts?.numbered ?? false }),
    }),
  /** имя папки, которое даст запуск: `white_001`, `white_002`, … считает сервер */
  nextWhite: () => j<{ projectId: string }>("/api/series/white"),
  /** варианты выгрузки: «в генераторе», «на рабочий стол», избранные папки */
  delivery: (project: string) =>
    j<{
      options: DestInfo[];
      choice: { kind: string; path?: string };
      quick: { label: string; dir: string }[];
    }>(`/api/delivery?project=${encodeURIComponent(project)}`),
  /** обозреватель папок этой машины (для выбора цели выгрузки) */
  browse: (dir: string) =>
    j<{
      dir: string;
      parent: string | null;
      dirs: { name: string; writable: boolean }[];
      error?: string;
    }>(`/api/fs/browse?path=${encodeURIComponent(dir)}`),
  startRun: (projectId: string) =>
    j<{ projectId: string; status: string; attached?: boolean }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),
  command: (projectId: string, cmd: string, detail?: string) =>
    j<{ ok: boolean; status: string }>(`/api/runs/${projectId}/command`, {
      method: "POST",
      body: JSON.stringify({ cmd, detail }),
    }),
  patchPlan: (projectId: string, plan: SitePlan) =>
    j<{ ok: boolean; planHash?: string; error?: string }>(`/api/runs/${projectId}/plan`, {
      method: "POST",
      body: JSON.stringify(plan),
    }),
  eventsUrl: (projectId: string) => `/api/runs/${projectId}/events`,
  /**
   * Снимок собранного сайта для ревью: есть ли dist, ссылка на локальный
   * превью-сервер, куда выкладывали и не устарела ли копия, плюс последние
   * машинные проверки и вердикт.
   */
  site: (projectId: string) =>
    j<{
      projectId: string;
      built: boolean;
      url: string;
      exportReady: boolean;
      /** формат индексов в export/: php | html — переключается у кнопок выгрузки */
      format?: "php" | "html";
      placed: { dir: string; zip: string; at: string; stale: boolean } | null;
      /** последний раунд правок человека: сколько заказано и сколько сделано */
      lastFix: {
        at: string;
        requested: number;
        applied: number;
        items: Array<{ text: string; done: boolean; note?: string }>;
        /** машинные проверки до/после: суммы поломок (console+overflow+битые src/href) */
        checks?: { before: number; after: number } | null;
        /** mtime dist после пересборки тем раундом: сверить с builtAt — тот ли
            результат сейчас в превью */
        builtAt?: number;
        /** хэш dist до/после раунда: правка реально что-то поменяла в файле */
        changed?: boolean;
      } | null;
      /** mtime текущей сборки — по нему вкладка превью перезагружается
          (сервер подмешивает сверку), а UI отличается «результат сейчас» от
          «история правок» */
      builtAt?: number;
      /** mtime вердикта/проверок: судья НЕ переснимается после human-fix, и
          без этих меток вчерашний вердикт выглядел нынешним */
      verdictAt?: number;
      checksAt?: number;
      imagesPending: number;
      /** смета прогона с manifest'а: картинки/токены/машинальные минуты */
      estimate?: { images: number; tokens: number; usd: number; minutes?: number } | null;
      status: string | null;
      /** фоновая правка/догенерация без живого прогона: этап прямо сейчас */
      postOp: { kind: "fix" | "images"; stage: string; startedAt: string } | null;
      /** финал последней фоновой операции — «готово» с цифрами, а не молчание */
      postResult: { kind: "fix" | "images"; ok: boolean; note: string; at: string } | null;
      verdict: {
        critical: number;
        summary: string;
        defects: Array<{ severity: string; message: string; selector?: string }>;
      } | null;
      checks: {
        console: number;
        overflow: number;
        brokenImgs: number;
        brokenHrefs: number;
        lowContrast: number;
        shots: Array<{ bp: number; url: string }>;
      } | null;
    }>(`/api/projects/${projectId}/site`),
  /** выгрузить сейчас (кнопка «Выгрузить»); без target — выбор из брифа */
  place: (projectId: string, target?: { path?: string; desktop?: boolean }) =>
    j<{
      ok: boolean;
      noop: boolean;
      placed: { dir: string; zip: string; at: string; stale: boolean } | null;
    }>(`/api/projects/${projectId}/place`, {
      method: "POST",
      body: JSON.stringify(target ?? {}),
    }),
  /** сменить формат индексов готового экспорта (php | html) */
  setFormat: (projectId: string, format: "php" | "html") =>
    j<{ ok: boolean; format: "php" | "html"; changed: number }>(
      `/api/projects/${projectId}/format`,
      { method: "POST", body: JSON.stringify({ format }) },
    ),
  /** догенерить картинки-заглушки + пересобрать (токенов на тексты не тратит) */
  regenImages: (projectId: string) =>
    j<{ ok: boolean; started: boolean }>(`/api/projects/${projectId}/regen-images`, {
      method: "POST",
    }),
  /** правка/accept для проекта без живого прогона (сервер перезапускали в review).
      Правка отвечает СРАЗУ: пересъёмка занимает минуту, прогресс и финал
      карточка читает из site.postOp / site.postResult */
  humanFixOffline: (projectId: string, comment: string) =>
    j<{ ok: boolean; started: boolean }>(`/api/projects/${projectId}/human-fix`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    }),
  /** отменить последний раунд правки: overrides срезан, сайт пересобран (фон) */
  undoFix: (projectId: string) =>
    j<{ ok: boolean; started: boolean }>(`/api/projects/${projectId}/undo-fix`, { method: "POST" }),
  acceptOffline: (projectId: string) =>
    j<{ ok: boolean; status: string }>(`/api/projects/${projectId}/accept`, { method: "POST" }),
  /** список проектов на диске: чем они кончили, есть ли превью/экспорт */
  projects: () =>
    j<{
      runs: {
        projectId: string;
        mode: string;
        status: string;
        createdAt: string | null;
        hasPreview: boolean;
        hasExport: boolean;
        live: boolean;
        error: string | null;
        /** есть ли снимок в библиотеке: удалять рабочую папку тогда безопаснее */
        inLibrary?: boolean;
        /** миниатюра строки: снимок съёмки для тултипа по наведению */
        thumb?: string | null;
      }[];
    }>("/api/runs"),
  /**
   * Удалить проект. `full: true` стирает и снимок в библиотеке (zip + промпт);
   * без него остаётся то, что уже можно отдать заказчику.
   */
  deleteProject: (projectId: string, full = false) =>
    j<{ ok: boolean; removedProject: boolean; removedLibrary: boolean }>(
      `/api/projects/${projectId}${full ? "?full=1" : ""}`,
      { method: "DELETE" },
    ),
  /** zip готовой сборки (export/ или dist/) — тот же файл, что кладём рядом при выгрузке */
  downloadUrl: (projectId: string) => `/api/projects/${projectId}/download`,
  /** финальный промпт проекта одним Markdown: prompt_<id>.md */
  promptUrl: (projectId: string) => `/api/projects/${projectId}/prompt.md`,
};

export function parseEvent(e: MessageEvent): OrchEvent | null {
  try {
    return JSON.parse(e.data) as OrchEvent;
  } catch {
    return null;
  }
}
