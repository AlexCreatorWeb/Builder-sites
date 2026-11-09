/**
 * Сайдкар: Fastify на 127.0.0.1. Тонкий — только роуты, SSE и статика превью.
 * Вся логика в orchestrator/ и connections/.
 */
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { ROOT, loadEnv, settings, saveSettings, resolveKey, setEnvLocal } from "./config.ts";
import { limitBadge, probeVision, connectionFor, fetchTaskImageModels } from "./connections/index.ts";
import { browse, deliveryOptions, makeZip, quickDirs, winPath } from "./delivery.ts";
import { createRun, libraryDir, libraryIndex, librarySave, type RunHandle } from "./orchestrator/run-manager.ts";
import {
  placeExport as tasksPlaceExport,
  placement,
  humanFix as tasksHumanFix,
  exportDirOf,
  setExportFormat,
  regenFailedImages as tasksRegenImages,
  assemble as tasksAssemble,
  shoot as tasksShoot,
  exportSite as tasksExportSite,
} from "./tasks/index.ts";
import type { OrchEvent } from "@builder/shared";
import {
  netRefresh,
  netSnapshot,
  startNetMonitor,
  subscribeNet,
  type NetSample,
} from "./net/monitor.ts";
import type { Brief, Connection, RunCommand, RunManifest, SitePlan } from "@builder/shared";

loadEnv();
const s = settings();

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: `http://localhost:${s.webPort}` });
await app.register(fastifyStatic, {
  root: path.join(ROOT, "projects"),
  prefix: "/projects/",
});
// превью генератора пересобирается под рукой (human-fix, раунды фиксов), а
// Chrome по-доброму консервирует index.html — отсюда рождалось «стили слетели»
// на обновлённой странице. Для раздаваемых проектов кэш отключаем совсем
app.addHook("onSend", (req, reply, payload, done) => {
  if (req.url.startsWith("/projects/"))
    reply.header("cache-control", "no-store, no-cache, must-revalidate");
  done(null, payload);
});

/**
 * Главная страница сборки раздаётся ЯВНЫМ роутом (а не статикой), чтобы
 * подмешать в неё авто-перезагрузку. Правка человека применяется ~минуту,
 * а превью открыто в ОТДЕЛЬНОЙ вкладке — без подсказки извне она стоит
 * устаревшим кадром, и человек выносит вердикт «правки не внесены» по
 * вчерашнему виду (замер: вкладка не перезагружалась никогда).
 * Скрипт сверяет штамп сборки (mtime dist) и перезагружает себя, когда сборка
 * стала новее. Только для главной: вложенные страницы и ассеты отдаёт статика.
 */
app.get("/projects/:id/dist/index.html", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const file = path.join(s.projectsRoot, id, "dist", "index.html");
  if (!fs.existsSync(file)) return reply.code(404).send({ error: "сборки ещё нет" });
  const html = fs.readFileSync(file, "utf8");
  const stamp = Math.round(fs.statSync(file).mtimeMs);
  const live =
    `<script>/* builder-live */(function(){var id=${JSON.stringify(id)},t=${stamp};` +
    `setInterval(function(){fetch("/api/projects/"+id+"/site",{cache:"no-store"})` +
    `.then(function(r){return r.json()}).then(function(d){` +
    `if(d&&d.builtAt&&d.builtAt!==t)location.reload()}).catch(function(){})},4000)})();</script>`;
  const out = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${live}</body>`) : `${html}\n${live}`;
  return reply.type("text/html; charset=utf-8").send(out);
});

const runs = new Map<string, RunHandle>();
/** правки без живого прогона идут последовательно на проект (двойной клик) */
const fixing = new Set<string>();
/**
 * Ход фоновой пост-операции (правка/догенерение картинок) без живого прогона.
 * Раньше POST висел минуту молча: юзер не знал, уснул генератор или работает,
 * а ответ «правка применена» приходил до того, как человек видел результат.
 * Теперь роут отвечает сразу, этап пишется сюда, карточка ревью опрашивает
 * /site — та же схема, что у живого прогона, только источник событий диск.
 */
const postOp = new Map<string, { kind: "fix" | "images"; stage: string; startedAt: string }>();
/** финал последней фоновой операции: «готово» без него — обещание, а не факт */
const postOpResult = new Map<string, { kind: "fix" | "images"; ok: boolean; note: string; at: string }>();

/**
 * Уборка мусора при старте сервера: незавершённые прогоны (план/шлюз/сборка/черновик),
 * у которых нет живого процесса, — трупы прошлого сервера. Живой прогон после
 * перезапуска сам не оживает, поэтому их папки уезжают в archive/ с меткой:
 * номер проекта освобождается, в UI и на диске ничего не висит.
 * Готовые (done), сбойные (failed/needs_human) и отменённые — результаты, их не трогаем.
 */
function sweepStaleRuns(): void {
  // «review» сюда не входит: собранный и непроверенный взглядом сайт — результат,
  // а не труп прошлого сервера; он живёт в мастерской, пока юзер его не примет
  const STALE = new Set(["draft", "planning", "awaiting-gate", "running"]);
  let names: string[] = [];
  try {
    names = fs.readdirSync(s.projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
  for (const name of names) {
    const dir = path.join(s.projectsRoot, name);
    let state: string | null = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as RunManifest;
      if (manifest.status && manifest.status !== "running") state = manifest.status;
    } catch {
      /* манифеста нет — решаем по журналу */
    }
    if (!state) {
      try {
        const lines = fs.readFileSync(path.join(dir, "run.jsonl"), "utf8").trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const e = JSON.parse(lines[i]) as { t?: string; state?: string };
          if (e.t === "run.state" && e.state) {
            state = e.state;
            break;
          }
        }
      } catch {
        /* журнала нет — папка с брифом, но прогон не начинался: это draft */
        state = "draft";
      }
    }
    if (!state) continue;
    // «running» из манифеста без живого процесса — залипшая запись прошлого сервера
    if (state === "running") state = "planning";
    // review без живого процесса: сервер перезапустили, пока сайт ждал просмотра.
    // Токенов не потрачено, папка с dist/ нужна — оставляем, но номер проекта
    // при этом занят: в archive такую папку не несём
    if (state === "review") continue;
    // готовое, ВЫГРУЖЕННОЕ вовне — результат у юзера на столе, в мастерской
    // такой проект только занимает номер: тоже в archive. Правдивый признак —
    // placed.json (пишется при реальной выгрузке), а не выбор в брифе: с раунда
    // «ревью» кнопка «Выгрузить» явная, и done без выгрузки теперь законен
    if (state === "done") {
      let placedOut = false;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, "placed.json"), "utf8")) as {
          dir?: string;
        };
        placedOut = Boolean(p?.dir);
      } catch {
        /* placed.json нет — не выгружали, оставляем в мастерской */
      }
      if (!placedOut) continue;
      state = "delivered";
    } else if (!STALE.has(state)) {
      continue;
    }
    try {
      const arch = path.join(ROOT, "archive");
      fs.mkdirSync(arch, { recursive: true });
      fs.renameSync(dir, path.join(arch, `${name}_stale-${stamp}`));
      console.log(`[sweep] ${name} (${state}) → archive/ — мёртвый прогон убран из мастерской`);
    } catch (err) {
      console.log(`[sweep] ${name}: не удалось убрать (${(err as Error).message})`);
    }
  }
}
sweepStaleRuns();

// ─── health / doctor-данные для UI ─────────────────────────────────────
app.get("/api/health", async () => {
  return {
    ok: true,
    root: ROOT,
    projectsRoot: s.projectsRoot,
    webPort: s.webPort,
  };
});

// ─── подключения: список + бейджи квот + проверка ──────────────────────
app.get("/api/connections", async () => {
  const badges = await Promise.all(
    s.connections
      .filter((c) => c.enabled)
      .map((c) => limitBadge(c).catch(() => null)),
  );
  return {
    // провайдер определяется по хосту при отдаче: в старых settings.json его нет,
    // и заголовок в UI не должен быть захардкожен текстом
    connections: s.connections.map((c) =>
      c.provider ? c : { ...c, provider: detectProvider(c.baseUrl) },
    ),
    badges: badges.filter(Boolean),
    // какие подключения/модели сейчас назначены на роли — это и есть «активные»
    selection: s.selection,
    // «наша» пара подключений: к ней возвращаются пилюлей «по умолчанию»
    defaults: s.defaults ?? null,
  };
});

// ─── своё подключение: чтобы генератор можно было отдать коллеге с его ключами ───
// От юзера — один API-ключ. Провайдер, адрес, назначение (код/картинки) и список
// моделей определяются по ключу и ответам его API; адрес остаётся единственным
// полем, которое иногда приходится вписать: ключ не несёт в себе хост.
type ConnInput = Partial<Connection> & { name?: string; baseUrl?: string; kind?: string; key?: string };

// Ключ определяет провайдера двумя способами. Первый — префикс: часть провайдеров
// выдаёт ключи с узнаваемой шапкой (sk-or-, imk_, gsk_…). Второй — перебор
// KNOWN_ENDPOINTS: «проверить ключ у каждого адреса, который мы знаем; где принял,
// тот и провайдер». Третьего случая, когда ключ молчит, два: self-hosted эндпоинт
// (наша же vLLM за прокси) и провайдер, которого мы ещё не знаем, — там адрес
// приходится вписать, потому что в строке ключа хост не зашит.
const KEY_HINTS: Array<[RegExp, string]> = [
  [/^sk-or-/, "OpenRouter"],
  [/^imk_/, "Imagening"],
  [/^gsk_/, "Groq"],
  [/^sk-ant-/, "Anthropic"],
  [/^sk-kimi-/, "Kimi"],
  [/^skey-v1-/, "Together"],
];

// Известные адреса для перебора. verify — эндпоинт, который отбивается от
// неверного ключа: GET /models его не заменяет, потому что OpenRouter отдаёт
// список из 451 модели даже на мусорный ключ (проверено).
interface KnownEndpoint {
  baseUrl: string;
  kind: "llm" | "image";
  verify: string;
}

const KNOWN_ENDPOINTS: KnownEndpoint[] = [
  { baseUrl: "https://openrouter.ai/api/v1", kind: "llm", verify: "/key" },
  { baseUrl: "https://imagening.click", kind: "image", verify: "/api/v1/me" },
  { baseUrl: "https://api.openai.com/v1", kind: "llm", verify: "/models" },
  { baseUrl: "https://api.groq.com/openai/v1", kind: "llm", verify: "/models" },
  { baseUrl: "https://api.anthropic.com/v1", kind: "llm", verify: "/models" },
  { baseUrl: "https://api.z.ai/api/paas/v4", kind: "llm", verify: "/models" },
  // kie: картиночный task-API. Его /models при чужом ключе отвечает HTTP 200 с
  // телом {"code":401} — такие ответы ловит проверка тела ниже
  { baseUrl: "https://api.kie.ai/api/v1", kind: "image", verify: "/models" },
  { baseUrl: "https://api.deepseek.com/v1", kind: "llm", verify: "/models" },
  { baseUrl: "https://api.moonshot.ai/v1", kind: "llm", verify: "/models" },
  { baseUrl: "https://api.mistral.ai/v1", kind: "llm", verify: "/models" },
];

// Провайдер не вписывается руками: он определяется по факту подключения — хосту и
// тому API, который на нём отвечает. Хост → имя; неизвестный хост остаётся хостом.
const PROVIDER_HOSTS: Array<[RegExp, string]> = [
  [/imagening\.click$/i, "Imagening"],
  [/openrouter\.ai$/i, "OpenRouter"],
  [/kie\.ai$/i, "Kie.ai"],
  [/dirigent\.cloud$/i, "LiteLLM"],
  [/(^|\.)(z\.ai|bigmodel\.cn)$/i, "Z.ai"],
  [/api\.openai\.com$/i, "OpenAI"],
  [/groq\.com$/i, "Groq"],
  [/deepseek\.com$/i, "DeepSeek"],
  [/anthropic\.com$/i, "Anthropic"],
  [/mistral\.ai$/i, "Mistral"],
  [/moonshot\.ai$/i, "Kimi"],
];

function detectProvider(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* как пришло */
  }
  for (const [re, name] of PROVIDER_HOSTS) if (re.test(host)) return name;
  return host;
}

/** Протокол по хосту: у Imagening своё API generations, не kie-подобный createTask. */
function defaultProtocol(kind: "llm" | "image", baseUrl: string): Connection["protocol"] {
  if (kind === "image" && detectProvider(baseUrl) === "Imagening") return "imagening";
  return kind === "image" ? "task-poll" : "openai-chat";
}

/**
 * Принимает ли этот адрес этот ключ. Проверяем эндпоинтом, который от неверного
 * ключа отказывает (verify), а не списком моделей: GET /models у части провайдеров
 * публичный и принимает что угодно.
 */
async function probeEndpoint(
  baseUrl: string,
  key: string,
): Promise<{ ok: boolean; kind: "llm" | "image"; models: Array<{ id: string; label?: string }> }> {
  const auth = { authorization: `Bearer ${key}` };
  const get = async (path: string, ms = 9_000) => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: auth,
      signal: AbortSignal.timeout(ms),
      redirect: "follow",
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  // imagening: свой формат ответа и картинки, а не чат — проверяем своим /me
  try {
    const models = await fetchImageningModels(baseUrl, key);
    if (models.length) return { ok: true, kind: "image", models };
  } catch {
    /* не imagening */
  }

  const known = KNOWN_ENDPOINTS.find((e) => e.baseUrl === baseUrl);
  try {
    const res = await get(known?.verify ?? "/models");
    const accepted = res.status >= 200 && res.status < 300;
    if (!accepted || !res.json) return { ok: false, kind: "llm", models: [] };
    // «ключ не твой» эти API отдают телом с ошибкой при HTTP 200 (kie и подобные)
    const code = Number((res.json as { code?: number }).code ?? 200);
    if (code >= 400) return { ok: false, kind: "llm", models: [] };
  } catch {
    return { ok: false, kind: "llm", models: [] };
  }

  // Ключ принят. Список моделей — отдельный шаг: у каждого формата он свой.
  // Task-API картиночных интеграторов (kie) отдаёт общий прайс со всем,
  // поэтому для image-эндпоинтов пробуем его формат, а не только openai-список.
  try {
    const pics = await fetchTaskImageModels(baseUrl, key);
    if (pics.length) return { ok: true, kind: known?.kind ?? "image", models: pics };
  } catch {
    /* не task-формат */
  }
  try {
    const ids = await fetchModelList(baseUrl, key);
    return { ok: true, kind: known?.kind ?? "llm", models: ids.map((id) => ({ id })) };
  } catch {
    return { ok: true, kind: known?.kind ?? "llm", models: [] };
  }
}

function normalizeConn(body: ConnInput, existing?: Connection): Connection | string {
  const baseUrl = (body.baseUrl ?? existing?.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) return "baseUrl должен начинаться с http(s)://";
  const kind = body.kind ?? existing?.kind;
  if (kind !== "llm" && kind !== "image") return "kind: llm | image";
  // название = определённый провайдер: юзер его не пишет, оно следует из адреса
  const provider = detectProvider(baseUrl);
  const name = (body.name ?? existing?.name ?? "").trim() || provider;
  const protocol = (body.protocol ??
    existing?.protocol ??
    defaultProtocol(kind, baseUrl)) as Connection["protocol"];
  if (!["openai-chat", "task-poll", "imagening", "custom"].includes(protocol))
    return "неизвестный protocol";
  const models = body.models ?? existing?.models ?? [];
  // пустой список допустим: его либо затянут с API (pullModels), либо впишут позже —
  // но к моменту сохранения у llm должна быть хотя бы одна модель (проверка ниже)
  const id =
    existing?.id ??
    (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "conn");
  return {
    id,
    name,
    provider,
    kind,
    baseUrl,
    protocol,
    auth: body.auth ?? existing?.auth ?? { mode: "env", ref: "" },
    models,
    limit: body.limit ?? existing?.limit ?? { mode: "unknown" },
    enabled: body.enabled ?? existing?.enabled ?? true,
    priority: body.priority ?? existing?.priority ?? 5,
  };
}

// Ключ вставлен в форму: пишем его в .env этого компа и подключаемся по имени
// переменной — в settings.json секрет не попадает, а юзер больше ничего не настраивает.
function persistKey(c: Connection): Connection {
  if (c.auth.mode !== "local" || !c.auth.ref) return c;
  const name = `BUILDER_${c.id.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_KEY`;
  setEnvLocal(name, c.auth.ref);
  return { ...c, auth: { mode: "env", ref: name } };
}

/** GET {base}/api/v1/models у imagening: {models:[{id,name,mode,default}]} — id это UUID. */
async function fetchImageningModels(
  baseUrl: string,
  key: string | null,
): Promise<Array<{ id: string; label?: string }>> {
  const res = await fetch(`${baseUrl}/api/v1/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`API ответил ${res.status}`);
  const j = (await res.json()) as {
    models?: Array<{ id?: string; name?: string; kind?: string; mode?: string; default?: boolean }>;
  };
  // генератор картинок выбирает картинки: видеомодели (clip, upscale, faces) тут лишние
  const pics = (j.models ?? []).filter((m) => m.kind === "picture" && m.id);
  // имя не уникально (t2i/edit/compose называются одинаково) — подпись дополняем режимом
  const seen = new Map<string, number>();
  for (const m of pics) seen.set(m.name ?? "", (seen.get(m.name ?? "") ?? 0) + 1);
  const label = (m: (typeof pics)[number]) => {
    const n = m.name ?? m.id ?? "";
    if ((seen.get(n) ?? 0) < 2) return n;
    return m.mode === "t2i" ? `${n} · из слов` : `${n} · ${m.mode}`;
  };
  // дефолтную сервисную модель ставим первой: она и берётся без выбора юзера
  return pics
    .sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)))
    .map((m) => ({ id: m.id!, label: label(m) }));
}

// Among pulled ids there are often non-chat workers (ASR, TTS, embeddings, rerank):
// they accept a POST but answer nonsense, so we filter by `mode` when the API reports it.
const NON_CHAT_MODES = /transcri|audio|tts|speech|embed|rerank|moderation|image|dall|whisper/i;

async function fetchModelList(baseUrl: string, key: string | null): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`API ответил ${res.status}`);
    const j = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; mode?: string }>;
    };
    return (j.data ?? [])
      .filter((m) => !m.mode || !NON_CHAT_MODES.test(m.mode))
      .map((m) => m.id ?? m.name ?? "")
      .filter(Boolean)
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/connections", async (req, reply) => {
  const body = (req.body ?? {}) as ConnInput & { pullModels?: boolean };
  const norm = normalizeConn(body);
  if (typeof norm === "string") return reply.code(400).send({ error: norm });
  let c = persistKey(norm);
  // Models are optional by hand: with pullModels the list is fetched from  // GET {base}/models, so a colleague pastes URL + key and gets their own list
  // instead of typing model ids into settings.json. Off by default: the form may
  // already carry models and an unreachable endpoint must not block a save.
  if (body.pullModels && c.kind === "llm") {
    try {
      const ids = await fetchModelList(c.baseUrl, resolveKey(c));
      c.models = ids.map((id) => ({ id }));
    } catch (err) {
      return reply.code(502).send({
        error: `модели не загрузились (${(err as Error).message.slice(0, 80)}) — впиши id вручную`,
      });
    }
    if (c.models.length === 0)
      return reply.code(502).send({ error: "список моделей пуст — впиши id вручную" });
  }
  // imagening: своего списка картинок юзер не знает — тянем сами, ошибка не блоком
  if (c.kind === "image" && c.protocol === "imagening" && c.models.length === 0) {
    try {
      c = { ...c, models: await fetchImageningModels(c.baseUrl, resolveKey(c)) };
    } catch {
      /* список останется пустым — модель можно вписать позже */
    }
  }
  // task-API (kie): прайс провайдера включает видео — берём оттуда картинки
  if (c.kind === "image" && c.protocol === "task-poll" && c.models.length === 0) {
    try {
      c = { ...c, models: await fetchTaskImageModels(c.baseUrl, resolveKey(c)) };
    } catch {
      /* список останется пустым — его затянут кнопкой */
    }
  }
  if (s.connections.some((x) => x.id === c.id)) {
    // тот же провайдер другим ключом = замена ключа/списка, а не «уже есть»:
    // юзер мог подключиться раньше и позже захотить переставить ключ
    const force = Boolean((req.query as { replace?: string } | null)?.replace);
    if (!force) return reply.code(409).send({ error: `подключение ${c.id} уже есть` });
    const i = s.connections.findIndex((x) => x.id === c.id);
    const prev = s.connections[i]!;
    // новый probe не принёс списка, а старый был — оставляем старый: список
    // моделей переживает смену ключа, пока юзер сам его не поправил
    if (c.models.length === 0 && prev.models.length > 0) c.models = prev.models;
    s.connections[i] = { ...c, id: c.id };
    // роль не должна остаться на модели, которой больше нет в списке
    for (const k of ["codeCopy", "image"] as const)
      if (
        s.selection[k]?.connection === c.id &&
        s.selection[k]?.model &&
        !c.models.some((m) => m.id === s.selection[k].model)
      )
        s.selection[k] = { connection: c.id, model: null };
    saveSettings(s);
    return { ok: true, id: c.id, models: c.models.length, replaced: true };
  }
  // Пустой список моделей у llm БОЛЬШЕ не блоком: у self-hosted/свежих эндпоинтов
  // эндпоинта /models часто нет, а подключить модель и вписать её id руками
  // должно быть можно с первого раза (прогон скажет «нет рабочей модели» сам).
  s.connections.push(c);
  saveSettings(s);
  return { ok: true, id: c.id, models: c.models.length };
});

// ─── подключение по одному ключу ──────────────────────────────────────
// Юзер вставляет только ключ. Всё остальное — провайдер, адрес, назначение
// (код или картинки), список моделей и фактический лимит — берётся из самого
// ключа и из ответов его API. Адрес всплывает одним дополнительным полем лишь
// когда префикс ключа незнаком: ключ не несёт в себе хост, угадать его нечем.
app.post("/api/connections/detect", async (req, reply) => {
  const body = (req.body ?? {}) as { key?: string; baseUrl?: string; kind?: string };
  const key = (body.key ?? "").trim();
  const typedBase = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
  // Куда юзер вставляет ключ — то назначение и есть. Без этой подсказки ключ
  // незнакомого интегратора попадал бы в окно кода, потому что llm дефолт
  const kindHint: "llm" | "image" | null =
    body.kind === "llm" || body.kind === "image" ? body.kind : null;
  if (!key) return reply.code(400).send({ error: "нет ключа" });
  if (typedBase && !/^https?:\/\//i.test(typedBase))
    return reply.code(400).send({ error: "адрес должен начинаться с http(s)://" });

  // Порядок важнее самого факта совпадения: вписанный адрес > подсказка префикса >
  // перебор. Иначе ключ, принятый двумя эндпоинтами, попадал бы не туда, куда хотел юзер.
  const hinted = KEY_HINTS.find(([re]) => re.test(key))?.[1];
  const order: string[] = [];
  if (typedBase) order.push(typedBase);
  if (hinted) {
    const h = KNOWN_ENDPOINTS.find((e) => detectProvider(e.baseUrl) === hinted);
    if (h) order.push(h.baseUrl);
  }
  for (const e of KNOWN_ENDPOINTS) if (!order.includes(e.baseUrl)) order.push(e.baseUrl);

  // Все проверки параллельно: последовательный перебор девяти адресов по 8 c
  // превращал «вставил ключ» в минуту ожидания.
  const results = await Promise.all(order.map((baseUrl) => probeEndpoint(baseUrl, key)));
  const known = new Map(KNOWN_ENDPOINTS.map((e) => [e.baseUrl, e]));

  // Ключ могли принять два адреса (бывает у прокси и у бесплатных зеркал).
  // Тогда выбираем тот, который соответствует ОКНУ, куда ключ вставили, —
  // картиночный ключ не должен уезжать в окно кода только потому, что его
  // адрес стоит в списке выше
  let pick = -1;
  for (let i = 0; i < order.length; i++) {
    if (!results[i]!.ok) continue;
    if (pick < 0) pick = i;
    // в картиночное окно ставим на известный картиночный адрес, а не на
    // любой ответивший: «список похож на картинки» — не доказательство
    if (kindHint === "image" && known.has(order[i]!) && results[i]!.kind === "image") {
      pick = i;
      break;
    }
  }

  if (pick >= 0) {
    const i = pick;
    const baseUrl = order[i]!;
    const probe = results[i]!;
    // Назначение: известное окно важнее догадки. У незнакомого интегратора
    // «kind» выводится из формы ответа и может врать (картиночный список
    // выглядит как список строк) — тогда верим окну, куда вставили ключ.
    const kind = known.has(baseUrl) ? probe.kind : (kindHint ?? probe.kind);
    const provider = detectProvider(baseUrl);
    // Лимит констатируем сразу же: юзер должен увидеть тариф до того, как
    // нажмёт «подключить», а не после (ключ пока локальный — в .env не пишем)
    const draft: Connection = {
      id: provider.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "conn",
      name: provider,
      provider,
      kind,
      baseUrl,
      protocol: defaultProtocol(kind, baseUrl),
      auth: { mode: "local", ref: key },
      models: probe.models,
      limit: { mode: "unknown" },
      enabled: true,
      priority: 5,
    };
    const badge = await limitBadge(draft).catch(() => null);
    return {
      needAddress: false,
      provider,
      kind,
      // откуда взялось назначение: из знакомого адреса (верно) или из того,
      // что API просто ответил списком моделей (догадка — не основание отказывать)
      kindSource: known.has(baseUrl) ? "endpoint" : probe.models.length ? "models" : "unknown",
      baseUrl,
      byAddress: i === 0 && typedBase === baseUrl,
      models: probe.models.length,
      quota: badge ? { state: badge.state, display: badge.display } : null,
      draft,
    };
  }

  // Ни один известный адрес ключ не принял: это не обязательно ошибка — так
  // ведут себя self-hosted эндпоинты. Просим адрес, один раз.
  // Но если адрес УЖЕ вписан юзером и тоже не прошёл verify — не отвергаем:
  // чужой API может проверять живость другим эндпоинтом. Подключаем «как есть»
  // с честным warn: модель тогда вписывается руками, лимит может не считаться.
  if (typedBase) {
    const provider = detectProvider(typedBase);
    const ep = known.get(typedBase);
    const draft: Connection = {
      id: provider.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "conn",
      name: provider,
      provider,
      kind: ep?.kind ?? kindHint ?? "llm",
      baseUrl: typedBase,
      protocol: defaultProtocol(ep?.kind ?? "llm", typedBase),
      auth: { mode: "local", ref: key },
      models: [],
      limit: { mode: "unknown" },
      enabled: true,
      priority: 5,
    };
    return {
      needAddress: false,
      provider,
      kind: draft.kind,
      kindSource: known.has(typedBase) ? "endpoint" : "window",
      baseUrl: typedBase,
      byAddress: true,
      unverified: true,
      models: 0,
      quota: null,
      hint: `адрес приняли, но проверить ключом не удалось — возможно, API проверяет живость другим запросом. Окно осталось ${
        (ep?.kind ?? kindHint) === "image" ? "картиночным" : "кодовым"
      }; модели затянем с его API, а первый запрос прогона покажет, работает ли.`,
      draft,
    };
  }
  return reply.code(422).send({
    error:
      "ключ не подошёл ни одному известному API — если это свой эндпоинт (vLLM, прокси), впиши его адрес",
  });
});

app.patch("/api/connections/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const i = s.connections.findIndex((x) => x.id === id);
  if (i < 0) return reply.code(404).send({ error: "нет такого подключения" });
  const norm = normalizeConn(req.body as ConnInput, s.connections[i]);
  if (typeof norm === "string") return reply.code(400).send({ error: norm });
  const c = persistKey(norm);
  s.connections[i] = { ...c, id };
  saveSettings(s);
  return { ok: true, id };
});

app.delete("/api/connections/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const i = s.connections.findIndex((x) => x.id === id);
  if (i < 0) return reply.code(404).send({ error: "нет такого подключения" });
  s.connections.splice(i, 1);
  // роль не должна остаться на удалённом подключении
  for (const k of ["codeCopy", "image"] as const)
    if (s.selection[k]?.connection === id) s.selection[k] = { connection: "", model: null };
  saveSettings(s);
  return { ok: true };
});

// Забрать список моделей с подключения: GET {base}/models (openai-совместимый API).
// Смысл: коллега вставляет адрес + ключ и получает свои модели списком, вместо
// ручного вписывания id в settings.json.
app.post("/api/connections/:id/models", async (req, reply) => {
  const { id } = req.params as { id: string };
  const c = s.connections.find((x) => x.id === id);
  if (!c) return reply.code(404).send({ error: "нет такого подключения" });
  const key = resolveKey(c);
  try {
    const models =
      c.protocol === "task-poll"
        ? await fetchTaskImageModels(c.baseUrl, key)
        : (await fetchModelList(c.baseUrl, key)).map((mid) => ({ id: mid }));
    if (!models.length) return reply.code(502).send({ error: "список моделей пуст" });
    c.models = models;
    saveSettings(s);
    return { ok: true, count: models.length, models: c.models };
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message.slice(0, 120) });
  }
});

// Список картинок imagening: эндпоинт свой ({base}/api/v1/models, id — UUID),
// поэтому отдельная ветка того же роута.
app.post("/api/connections/:id/models/imagening", async (req, reply) => {
  const { id } = req.params as { id: string };
  const c = s.connections.find((x) => x.id === id);
  if (!c) return reply.code(404).send({ error: "нет такого подключения" });
  try {
    const models = await fetchImageningModels(c.baseUrl, resolveKey(c));
    if (!models.length) return reply.code(502).send({ error: "список моделей пуст" });
    c.models = models;
    saveSettings(s);
    return { ok: true, count: models.length, models };
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message.slice(0, 120) });
  }
});

// Модель руками: добавить/убрать конкретную модель у подключения.
// Списку с /models доверять нельзя: у self-hosted эндпоинтов в нём нет
// половины реальных моделей, а у imagening id вообще UUID, который руками не впишешь.
app.patch("/api/connections/:id/models", async (req, reply) => {
  const { id } = req.params as { id: string };
  const c = s.connections.find((x) => x.id === id);
  if (!c) return reply.code(404).send({ error: "нет такого подключения" });
  const body = (req.body ?? {}) as { add?: string; label?: string; remove?: string };
  const add = (body.add ?? "").trim();
  const remove = (body.remove ?? "").trim();
  if (add && remove) return reply.code(400).send({ error: "или add, или remove" });
  if (add) {
    if (add.length > 160 || /[\s\u0000-\u001f]/.test(add))
      return reply.code(400).send({ error: "id модели: без пробелов, до 160 знаков" });
    if (c.models.some((m) => m.id === add))
      return reply.code(409).send({ error: `модель «${add}» уже есть` });
    c.models.push({ id: add, label: body.label?.trim() || undefined });
  } else if (remove) {
    const i = c.models.findIndex((m) => m.id === remove || m.label === remove);
    if (i < 0) return reply.code(404).send({ error: "нет такой модели у подключения" });
    c.models.splice(i, 1);
    // роль не должна остаться на удалённой модели
    for (const k of ["codeCopy", "image"] as const)
      if (s.selection[k]?.connection === id && s.selection[k]?.model === remove)
        s.selection[k] = { connection: id, model: null };
  } else {
    return reply.code(400).send({ error: "нет add/remove" });
  }
  saveSettings(s);
  return { ok: true, count: c.models.length, models: c.models };
});

// назначение модели на роль (SPEC §4: роли code | copy | vision, плюс картинки)
app.put("/api/selection", async (req, reply) => {
  const body = req.body as Partial<typeof s.selection>;
  for (const k of ["codeCopy", "image"] as const) {
    const v = body[k];
    if (!v) continue;
    const c = s.connections.find((x) => x.id === v.connection);
    if (v.connection !== "none" && !c)
      return reply.code(400).send({ error: `нет подключения ${v.connection}` });
    // модель из опечатки не падает громко, а тихо ломает прогон на первом же запросе
    if (c && v.model && c.models.length && !c.models.some((m) => m.id === v.model))
      return reply
        .code(400)
        .send({ error: `модели «${v.model}» нет в ${c.name}: сначала «взять модели с API»` });
    s.selection[k] = v;
  }
  if (body.imageMode) s.selection.imageMode = body.imageMode;
  saveSettings(s);
  return { ok: true, selection: s.selection };
});

app.post("/api/connections/:id/check", async (req, reply) => {
  const { id } = req.params as { id: string };
  const c = s.connections.find((x) => x.id === id);
  if (!c) return reply.code(404).send({ error: "нет такого подключения" });
  const model =
    (req.body as { model?: string } | null)?.model ??
    c.models[0]?.id ??
    null;
  if (!model)
    return reply.code(400).send({ error: "не указана модель для проверки" });
  const badge = await limitBadge(c);
  const vision = c.kind === "llm" ? await probeVision(c, model) : undefined;
  c.vision = vision;
  return { ok: true, badge, vision };
});

// ─── Монитор связи (SPEC §9) ────────────────────────────────────────────
// Опрос идёт непрерывно на сервере (net/monitor.ts), а не по запросу страницы:
// индикатор должен показывать лаг в моменте и различать «тормозит вайфай» и
// «тормозит сторона провайдера/модели».
const netTargets = () => {
  const st = settings();
  // «назначено на роль» = то, что реально участвует в прогоне прямо сейчас
  const activeIds = new Set([st.selection.codeCopy?.connection, st.selection.image?.connection]);
  return st.connections
    .filter((c) => c.enabled)
    .map((c) => {
      let host = c.baseUrl;
      try {
        host = new URL(c.baseUrl).hostname;
      } catch {
        /* как пришло */
      }
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        host,
        baseUrl: c.baseUrl,
        hasKey: Boolean(resolveKey(c)),
        active: activeIds.has(c.id),
        // бесплатный эндпоинт того же API: список моделей ничего не стоит
        healthPath: c.protocol === "imagening" ? "/api/v1/me" : "/models",
        key: resolveKey(c),
      };
    });
};

startNetMonitor(netTargets);

// Последний снимок — мгновенно; stream — то же самое плюс подписка, чтобы UI
// жил сам, без интервалов и перезагрузок.
app.get("/api/net", async () => netSnapshot() ?? (await netRefresh(netTargets)));

app.post("/api/net/refresh", async () => netRefresh(netTargets));

app.get("/api/net/stream", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (sample: NetSample) => reply.raw.write(`data: ${JSON.stringify(sample)}\n\n`);
  const current = netSnapshot();
  if (current) send(current);
  else void netRefresh(netTargets).then(send);
  const off = subscribeNet(send);
  req.raw.on("close", off);
});

/**
 * Варианты выгрузки для брифа: где проект окажется после генерации, доступен ли
 * путь. «В генераторе» + сохранённая папка + последние; город на цель не влияет —
 * генератор не знает про чужие серверы, юзер переносит результат сам.
 */
app.get("/api/delivery", async (req) => {
  const q = req.query as { project?: string };
  // имя папки для выгрузки = имя проекта, которое даст запуск
  const project = (q?.project ?? "").trim() || "white";
  return {
    options: deliveryOptions(s, { project }),
    choice: s.delivery ?? { kind: "here" as const },
    quick: quickDirs(),
  };
});

/** Обозреватель папок: содержимое любой папки этой машины (для выбора цели). */
app.get("/api/fs/browse", async (req) => {
  const q = req.query as { path?: string };
  return browse(q?.path ?? "");
});

// ─── проект: создать папку с brief.json ────────────────────────────────
/**
 * Имя проекта — номер серии генератора: `white_001`, `white_002`, … Три знака,
 * номер берётся следующий за максимальным в projectsRoot. Чужие серверы и старые
 * имена (`white_dubai-24`) в расчёт не идут — это просто папки, нумерация
 * генератора начинается с чистой страницы и растёт только внутри projectsRoot.
 */
function nextWhiteId(root: string): string {
  const used = new Set<number>();
  const re = /^white_(\d{1,4})$/i;
  try {
    for (const name of fs.readdirSync(root)) {
      const m = re.exec(name);
      if (m) used.add(Number(m[1]));
    }
  } catch {
    /* папки ещё нет — первый проект */
  }
  // готовые из библиотеки тоже заняты: рабочую папку чистят без потерь,
  // а белый_001 из library/ не имеет права повториться новым прогоном
  for (const e of libraryIndex()) {
    const m = re.exec(e.projectId);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `white_${String(n).padStart(3, "0")}`;
}

/**
 * Preview для брифа: какое имя папки даст запуск (`white_001`). Юзер видит его
 * заранее, но руками не вводит; при повторном запуске сервер выдаст следующий.
 */
app.get("/api/series/white", async () => {
  return { projectId: nextWhiteId(s.projectsRoot) };
});

app.post("/api/projects", async (req, reply) => {
  const body = req.body as {
    projectId?: string;
    brief?: Brief;
    numbered?: boolean;
  };
  let projectId = (body?.projectId ?? "").trim();
  if (!/^[\w.-]{3,64}$/.test(projectId))
    return reply.code(400).send({ error: "имя проекта: 3–64 знака, без слэшей" });
  if (!body?.brief?.mode) return reply.code(400).send({ error: "нет brief.mode" });
  const force = Boolean((req.query as { force?: string } | null)?.force);
  // numbered: имя даём сами (`white_001`, `white_002`, …), юзер его не вводит.
  // force при этом значит лишь «перезаписать brief.json», имя всё равно наше.
  if (body.numbered) {
    projectId = nextWhiteId(s.projectsRoot);
  }
  const dir = path.join(s.projectsRoot, projectId);
  fs.mkdirSync(path.join(dir, "assets", "img"), { recursive: true });
  fs.mkdirSync(path.join(dir, "preview"), { recursive: true });
  const briefFile = path.join(dir, "brief.json");
  if (fs.existsSync(briefFile) && !force)
    return reply.code(409).send({ error: `проект ${projectId} уже есть — пересоздай или форкни` });
  fs.writeFileSync(briefFile, JSON.stringify(body.brief, null, 2));
  return { ok: true, projectId, dir };
});

// ─── запуск прогона ────────────────────────────────────────────────────
app.post("/api/runs", async (req, reply) => {
  const body = req.body as { projectId?: string };
  const projectId =
    body?.projectId ?? `run_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  const dir = path.join(s.projectsRoot, projectId);
  if (!fs.existsSync(path.join(dir, "brief.json")))
    return reply.code(400).send({ error: `Нет ${projectId}/brief.json` });
  const h = createRun(projectId);
  runs.set(projectId, h);
  return { projectId, status: h.status };
});

app.get("/api/runs/:id/events", (req, reply) => {
  const { id } = req.params as { id: string };
  const h = runs.get(id);
  if (!h) return reply.code(404).send({ error: "прогон не запущен" });
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const e of h.last) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  const off = h.subscribe((e) =>
    reply.raw.write(`data: ${JSON.stringify(e)}\n\n`),
  );
  req.raw.on("close", off);
});

/**
 * Скачать готовый проект zip'ом: export/ (или dist/, если экспорта ещё нет)
 * упаковывается рядом с проектом и отдаётся файлом. Архив кешируется: если
 * zip свежее index.html, пересборки нет. Это ответ на «забрать завтра из
 * генератора»: папка никуда не делась, кнопка просто упаковывает её.
 */
/** Чтение JSON с диска без падения на битом файле (для read-only ручек). */
function readJsonLocal<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Финальный промпт проекта — один Markdown, читаемый человеком: задание,
 * структура, оформление, картинки. Имя prompt_<id>.md; номер = номер проекта.
 */
const SECTION_TITLES: Record<string, string> = {
  hero: "Первый экран",
  benefits: "Преимущества",
  how: "Как мы работаем",
  gallery: "Галерея",
  proof: "Отзывы",
  pricing: "Цены",
  faq: "Вопросы и ответы",
  cta: "Призыв к действию",
  footer: "Подвал с контактами",
};
const ROLE_TITLES: Record<string, string> = {
  hero: "главный экран",
  content: "содержательная",
  avatar: "портрет",
  background: "фон-фактура",
};
app.get("/api/projects/:id/prompt.md", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const pdir = path.join(s.projectsRoot, id);
  // после чистки projects/ читаем снимок библиотеки: brief+plan лежат рядом с zip
  const ldir = path.join(libraryDir(), id);
  const rd = <T,>(f: string): T | null =>
    readJsonLocal<T>(path.join(pdir, f)) ?? readJsonLocal<T>(path.join(ldir, f));
  const brief = rd<Record<string, unknown>>("brief.json");
  const plan = rd<SitePlan>("site-plan.json");
  if (!brief || !plan) return reply.code(404).send({ error: `промпта проекта ${id} ещё нет — сначала план` });

  const t = (k: string): string => (typeof brief[k] === "string" ? (brief[k] as string) : "");
  const pair = brief["colorPair"] as { label?: string } | undefined;
  const pages = Number(brief["pageCount"] ?? 1);
  const locale = brief["locale"] === "ru" ? "русский" : brief["locale"] === "tr" ? "турецкий" : "английский";
  const wish = t("wishes").trim();
  const off = ((brief["sections"] as Array<{ type: string; enabled?: boolean }> | undefined) ?? [])
    .filter((x) => x.enabled === false)
    .map((x) => SECTION_TITLES[x.type] ?? x.type);

  const md = [
    `# Промпт проекта ${id}`,
    ``,
    `Собери светлый сайт в стиле серии whites: много воздуха, один акцент, читаемая типографика.`,
    `Тематика — ${t("niche") || t("theme") || "услуги"}. Город — ${t("city") || "не указан"}. Язык текста — ${locale}.`,
    pages > 1 ? `Страниц в сайте: ${pages} (главная + вложенные).` : `Страница одна.`,
    `Герой экрана: ${brief["heroMotion"] === "video" ? "видеофон без звука" : "статичная картинка"}, ${
      brief["heroWidth"] === "full" ? "на всю ширину окна" : "в контейнере страницы (--maxw)"
    }.`,
    pair?.label ? `Палитра — пара «${pair.label}».` : ``,
    wish ? `Пожелание заказчика (обязательно): ${wish}.` : ``,
    ``,
    `## Секции страницы`,
    ``,
    ...plan.sections.map((x, i) => `${i + 1}. ${SECTION_TITLES[x.type] ?? x.type} — заголовок «${x.heading}»`),
    off.length ? `\nБез секции: ${off.join(", ")}.` : ``,
    ``,
    `## Оформление`,
    ``,
    `Фон ${plan.palette["bg"]}, акцент ${plan.palette["accent"]}, текст ${plan.palette["text"]}.`,
    `Шрифты: заголовки ${plan.fonts.heading}, текст ${plan.fonts.body}.`,
    ``,
    `## Картинки (${plan.images.length})`,
    ``,
    ...(plan.images.length
      ? plan.images.map((im) => `- ${im.description} — ${ROLE_TITLES[im.role] ?? im.role}, ${im.aspect}`)
      : ["- картинок нет"]),
    ``,
  ].join("\n");

  return reply
    .header("content-type", "text/markdown; charset=utf-8")
    .header("content-disposition", `attachment; filename="prompt_${id}.md"`)
    .send(md);
});

app.get("/api/projects/:id/download", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  const built = (d: string) =>
    fs.existsSync(path.join(d, "index.html")) || fs.existsSync(path.join(d, "index.php"));
  const src = exportDirOf(dir);
  if (!built(src)) {
    // рабочей папки может уже не быть — проект выгрузили и почистили; снимок
    // библиотеки отдаём как есть, он и есть готовый результат
    const libZip = path.join(libraryDir(), id, "site.zip");
    if (fs.existsSync(libZip))
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${id}.zip"`)
        .send(fs.createReadStream(libZip));
    return reply.code(404).send({ error: `проекта ${id} со сборкой ещё нет` });
  }
  const entry = fs.existsSync(path.join(src, "index.html"))
    ? path.join(src, "index.html")
    : path.join(src, "index.php");
  const zp = path.join(dir, `${id}.zip`);
  const fresh = fs.existsSync(zp) && fs.statSync(zp).mtimeMs >= fs.statSync(entry).mtimeMs;
  if (!fresh) {
    // внутри архива папка = имя проекта (не служебное export/), чтобы распаковали
    // сразу то, что несут на сервер
    const err = makeZip(src, zp, id);
    if (err) return reply.code(500).send({ error: `zip: ${err}` });
  }
  return reply
    .header("content-type", "application/zip")
    .header("content-disposition", `attachment; filename="${id}.zip"`)
    .send(fs.createReadStream(zp));
});

app.get("/api/projects/:id/site", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  const built = (d: string) =>
    fs.existsSync(path.join(d, "index.html")) || fs.existsSync(path.join(d, "index.php"));
  const hasDist = built(path.join(dir, "dist"));
  const h = runs.get(id);
  // свежие машинные проверки и вердикт — чтобы карточка ревью объяснила,
  // на что смотреть, а не просто «готово»
  const lastRound = (n: string) => {
    try {
      return fs
        .readdirSync(path.join(dir, "preview"))
        .filter((f) => f.startsWith(n) && f.endsWith(".json"))
        .map((f) => Number(/r(\d+)\.json$/.exec(f)?.[1] ?? -1))
        .sort((a, b) => b - a)[0];
    } catch {
      return undefined;
    }
  };
  const rn = lastRound("verdict-");
  // картинки-заглушки: UI по этому числу показывает «Догенерить картинки»
  const manifest = readJsonLocal<{
    images?: Array<{ status: string }>;
    estimate?: { images: number; tokens: number; usd: number; minutes?: number };
  }>(path.join(dir, "manifest.json"));
  const imagesPending = (manifest?.images ?? []).filter(
    (i) => i.status === "failed" || i.status === "placeholder",
  ).length;
  const verdict =
    rn === undefined
      ? null
      : readJsonLocal<{
          critical?: number;
          summary?: string;
          defects?: Array<{ severity: string; message: string; selector?: string }>;
        }>(path.join(dir, "preview", `verdict-r${rn}.json`));
  const cn = lastRound("checks-");
  const checks =
    cn === undefined
      ? null
      : readJsonLocal<{
          consoleErrors?: string[];
          overflow?: string[];
          brokenImgs?: string[];
          brokenHrefs?: string[];
          lowContrast?: string[];
          screenshots?: Array<{ breakpoint: number; file: string }>;
        }>(path.join(dir, "preview", `checks-r${cn}.json`));
  // последний раунд правки человека: карточка ревью показывает «N из M» и
  // список пунктов даже после перезапуска сервера (SSE к тому моменту мёртв)
  const lastFix = readJsonLocal<{
    at: string;
    requested: number;
    applied: number;
    items: Array<{ text: string; done: boolean; note?: string }>;
    /** машинные проверки до/после раунда: «✓ все» при регрессии не должно
        выглядеть победой */
    checks?: { before: number; after: number };
  }>(path.join(dir, "human-fix.json"));
  /**
   * Штамп ТЕКУЩЕЙ сборки (mtime dist/index.html|php). Без него карточка ревью
   * не могла отличить «результат только что сделанной правки» от «история
   * вчерашнего раунда» и держала зелёную плашку «правки: 1 из 1 · 7 нояб.,
   * 18:20» как статус свежего действия. Плюс по нему перезагружается превью.
   */
  const distEntry = ["index.html", "index.php"]
    .map((f) => path.join(dir, "dist", f))
    .find((f) => fs.existsSync(f));
  const builtAt = distEntry ? Math.round(fs.statSync(distEntry).mtimeMs) : 0;
  /**
   * WHEN у вердикта и проверок (mtime их файлов). Без них вчерашний снимок
   * судьи подавался как нынешнее состояние («проверки чистые» при сборке,
   * снятой на час позже), а все строки карточки обязаны отвечать
   * действительности: правки меняют dist, но НЕ переснимают вердикт.
   */
  const mtime = (p: string) => {
    try {
      return Math.round(fs.statSync(p).mtimeMs);
    } catch {
      return 0;
    }
  };
  const verdictAt = verdict ? mtime(path.join(dir, "preview", `verdict-r${rn}.json`)) : 0;
  const checksAt = checks ? mtime(path.join(dir, "preview", `checks-r${cn}.json`)) : 0;
  return {
    projectId: id,
    built: hasDist,
    url: hasDist ? `/projects/${id}/dist/index.html` : "",
    exportReady: built(exportDirOf(dir)),
    // формат индексов готового экспорта: UI кнопок выгрузки показывает
    // переключатель по факту на диске, а не по чекбоксу брифа
    format: fs.existsSync(path.join(exportDirOf(dir), "index.php")) ? "php" : "html",
    // смета прогона: карточка ревью дописывает «машине ≈N мин» к своей строке,
    // чтобы «до» и «после» были в одном месте
    estimate: manifest?.estimate ?? null,
    placed: placement(dir),
    lastFix,
    builtAt,
    verdictAt,
    checksAt,
    imagesPending,
    status: h?.status ?? null,
    // фоновая правка/догенерация без живого прогона: карточка ревью по этим
    // полям крутит прогресс и показывает финал («готово» + что изменилось),
    // а не гадала по молчанию закрытого POST
    postOp: postOp.get(id) ?? null,
    postResult: postOpResult.get(id) ?? null,
    verdict: verdict
      ? {
          critical: verdict.critical ?? 0,
          summary: verdict.summary ?? "",
          // 6 было мало: критичное терялось за срезом, а решение «Выгрузить»
          // принималось по неполному списку
          defects: (verdict.defects ?? []).slice(0, 20),
        }
      : null,
    checks: checks
      ? {
          console: checks.consoleErrors?.length ?? 0,
          overflow: checks.overflow?.length ?? 0,
          brokenImgs: checks.brokenImgs?.length ?? 0,
          brokenHrefs: checks.brokenHrefs?.length ?? 0,
          lowContrast: checks.lowContrast?.length ?? 0,
          shots: (checks.screenshots ?? []).map((sh) => ({
            bp: sh.breakpoint,
            url: `/projects/${id}/preview/${path.basename(sh.file)}`,
          })),
        }
      : null,
  };
});

/**
 * Ручная выгрузка проекта (кнопка «Выгрузить» в ревью, и то же из панели
 * «Проекты»): копия export/ + zip в выбранное место. Тело: { path } или
 * { desktop: true }; без тела — выбор из брифа/settings.
 */
app.post("/api/projects/:id/place", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  if (!fs.existsSync(dir)) return reply.code(404).send({ error: `нет проекта ${id}` });
  const body = (req.body ?? {}) as { path?: string; desktop?: boolean };
  const choice = body.desktop
    ? ({ kind: "desktop" } as const)
    : body.path
      ? ({ kind: "folder", path: body.path } as const)
      : undefined;
  const events: OrchEvent[] = [];
  try {
    const res = tasksPlaceExport(dir, (e) => events.push(e), choice);
    return { ok: true, placed: placement(dir), noop: res === null, events };
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message, events });
  }
});

/**
 * Человеческая правка без живого прогона (сервер перезапустили в review):
 * тот же tasks.humanFix, все входы (brief/plan/build) — на диске.
 */
app.post("/api/projects/:id/human-fix", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  const brief = readJsonLocal<Brief & { delivery?: { kind?: string } }>(path.join(dir, "brief.json"));
  const plan = readJsonLocal<SitePlan>(path.join(dir, "site-plan.json"));
  if (!brief || !plan) return reply.code(404).send({ error: `нет брифа/плана проекта ${id}` });
  const body = (req.body ?? {}) as { comment?: string };
  const comment = (body.comment ?? "").trim();
  if (!comment) return reply.code(400).send({ error: "пустая правка" });
  if (fixing.has(id)) return reply.code(409).send({ error: "правка уже применяется" });
  fixing.add(id);
  postOp.set(id, { kind: "fix", stage: "модель пишет патч", startedAt: new Date().toISOString() });
  postOpResult.delete(id);
  const lastRound = (prefix: string) => {
    try {
      return fs
        .readdirSync(path.join(dir, "preview"))
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .map((f) => Number(/r(\d+)\.json$/.exec(f)?.[1] ?? -1))
        .sort((a, b) => b - a)[0] ?? 0;
    } catch {
      return 0;
    }
  };
  // Ответ сразу, работа в фоне: правка с пересъёмкой идёт ~минуту, и держать
  // POST открытым — значит оставить юзера без признаков жизни. Этапы пишет в
  // postOp, карточка ревью крутит их из /site (см. postOp в этом файле)
  void (async () => {
    try {
      const r = await tasksHumanFix(
        {
          dir,
          mode: brief.mode,
          brief,
          plan,
          round: Math.max(lastRound("verdict-"), lastRound("checks-")),
          defects: [],
          emit: (e) => {
            try {
              fs.appendFileSync(path.join(dir, "run.jsonl"), JSON.stringify(e) + "\n");
            } catch {
              /* журнала нет — не беда */
            }
          },
          signal: new AbortController().signal,
          progress: (stage) => {
            const cur = postOp.get(id);
            if (cur) postOp.set(id, { ...cur, stage });
          },
        },
        comment,
      );
      postOpResult.set(id, {
        kind: "fix",
        ok: r.ok,
        note: r.ok ? String(r.value ?? "") : (r.error?.message ?? "правка не применена"),
        at: new Date().toISOString(),
      });
    } catch (err) {
      postOpResult.set(id, { kind: "fix", ok: false, note: (err as Error).message, at: new Date().toISOString() });
    } finally {
      postOp.delete(id);
      fixing.delete(id);
    }
  })();
  return { ok: true, started: true };
});

/**
 * Принять сборку без выгрузки, если прогона в памяти уже нет (сервер
 * перезапускали, пока сайт ждал просмотра): состояние и снимок — прямо с диска.
 */
/**
 * Смена формата индексов готового экспорта: `php` (index.php, серия whites на
 * WAMP/OpenServer) или `html` (чистый HTML). Делается здесь, а не в брифе:
 * формат — свойство ТОГО СЕРВЕРА, куда несут сайт, и решать его человек
 * должен у кнопок выгрузки, глядя на собранный сайт, а не до генерации.
 * Конвертируется сам export/ (без перегенерации), а brief.php правится, чтобы
 * ближайшая пересборка (правка/догенерение картинок) не откатила формат назад.
 */
app.post("/api/projects/:id/format", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const body = (req.body ?? {}) as { format?: string };
  const to = body.format === "php" ? "php" : body.format === "html" ? "html" : null;
  if (!to) return reply.code(400).send({ error: "нужен format: php | html" });
  const dir = path.join(s.projectsRoot, id);
  const outDir = exportDirOf(dir);
  if (!fs.existsSync(outDir)) return reply.code(404).send({ error: "сборки ещё нет — формат меняется после генерации" });
  try {
    const changed = setExportFormat(dir, to);
    // бриф — источник истины для exportSite: без этой строки следующая
    // пересборка вернёт формат, выбранный до решения о выгрузке
    const bp = path.join(dir, "brief.json");
    if (fs.existsSync(bp)) {
      const b = readJsonLocal<Record<string, unknown>>(bp);
      if (b && b.php !== (to === "php")) {
        b.php = to === "php";
        fs.writeFileSync(bp, JSON.stringify(b, null, 2) + "\n");
      }
    }
    return { ok: true, format: to, changed, placed: placement(dir) };
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.post("/api/projects/:id/accept", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  const m = readJsonLocal<RunManifest>(path.join(dir, "manifest.json"));
  if (!m) return reply.code(404).send({ error: `нет проекта ${id}` });
  m.status = "done";
  m.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    fs.appendFileSync(
      path.join(dir, "run.jsonl"),
      JSON.stringify({ t: "run.state", state: "done", at: m.finishedAt }) + "\n",
    );
    librarySave(dir, id);
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
  return { ok: true, status: "done" };
});

/**
 * Догенерить картинки, оставшиеся заглушками (set `status: failed/placeholder`),
 * и ПЕРЕСОБРАТЬ сайт: без assemble новые файлы попали бы в assets/, но не в
 * <img src> страницы. Токенов на тексты/вёрстку это не тратит — только графика.
 */
async function rebuildAfterImages(
  id: string,
  dir: string,
  progress?: (stage: string) => void,
): Promise<{ ok: boolean; error?: string; generated: number }> {
  const brief = readJsonLocal<Brief>(path.join(dir, "brief.json"));
  const plan = readJsonLocal<SitePlan>(path.join(dir, "site-plan.json"));
  if (!brief || !plan) return { ok: false, error: `нет брифа/плана проекта ${id}`, generated: 0 };
  const lastRound = (prefix: string) => {
    try {
      return (
        fs
          .readdirSync(path.join(dir, "preview"))
          .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
          .map((f) => Number(/r(\d+)\.json$/.exec(f)?.[1] ?? -1))
          .sort((a, b) => b - a)[0] ?? 0
      );
    } catch {
      return 0;
    }
  };
  const ctx = {
    dir,
    mode: brief.mode,
    brief,
    plan,
    round: Math.max(lastRound("verdict-"), lastRound("checks-")),
    defects: [],
    emit: (e: OrchEvent) => {
      // событие прогона: панель ревью перечитает /site, журнал — для истории
      try {
        fs.appendFileSync(path.join(dir, "run.jsonl"), JSON.stringify(e) + "\n");
      } catch {
        /* журнала нет — не беда */
      }
    },
    signal: new AbortController().signal,
    progress,
  };
  progress?.("догоняю картинки");
  const generated = await tasksRegenImages(dir);
  progress?.("пересобираю сайт");
  const built = await tasksAssemble(ctx);
  if (!built.ok) return { ok: false, error: built.error?.message ?? "пересборка не удалась", generated };
  progress?.("фоткаю 375 / 768 / 1280");
  await tasksShoot(ctx).catch(() => null);
  await tasksExportSite(ctx).catch(() => null);
  return { ok: true, generated };
}

app.post("/api/projects/:id/regen-images", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  if (!fs.existsSync(dir)) return reply.code(404).send({ error: `нет проекта ${id}` });
  if (fixing.has(id)) return reply.code(409).send({ error: "проект уже доделывается" });
  fixing.add(id);
  // тот же фоновый механизм, что у правки: догенерение + пересъёмка идут
  // минуты, а карточка крутит этапы из /site
  postOp.set(id, { kind: "images", stage: "догоняю картинки", startedAt: new Date().toISOString() });
  postOpResult.delete(id);
  void (async () => {
    try {
      const r = await rebuildAfterImages(id, dir, (stage) => {
        const cur = postOp.get(id);
        if (cur) postOp.set(id, { ...cur, stage });
      });
      postOpResult.set(id, {
        kind: "images",
        ok: r.ok,
        note: r.ok ? `догенерировано: ${r.generated}, сайт пересобран` : (r.error ?? "пересборка не удалась"),
        at: new Date().toISOString(),
      });
    } catch (err) {
      postOpResult.set(id, { kind: "images", ok: false, note: (err as Error).message, at: new Date().toISOString() });
    } finally {
      postOp.delete(id);
      fixing.delete(id);
    }
  })();
  return { ok: true, started: true };
});

/**
 * Откат ПОСЛЕДНЕГО раунда правки: из overrides.css/html срезается последний
 * блок «правка человека», сайт пересобирается без него. Нужен потому, что
 * фиксер может «применить» пункт и добавить поломок (съёмка это видит в
 * checks до/после) — без отката юзеру оставалось только перегенерять всё.
 */
app.post("/api/projects/:id/undo-fix", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const dir = path.join(s.projectsRoot, id);
  const cssFile = path.join(dir, "overrides.css");
  const htmlFile = path.join(dir, "overrides.html");
  if (!fs.existsSync(cssFile) && !fs.existsSync(htmlFile))
    return reply.code(404).send({ error: "правок человека на этом проекте не было" });
  if (fixing.has(id)) return reply.code(409).send({ error: "проект сейчас доделывается" });
  // блок = метка + всё до конца файла (метки пишутся по порядку, последняя —
  // последняя правка); срез = текст ДО последней метки
  // блоки раундов помечены id (`правка человека #<id>`); старый формат без id
  // умеем только «последний блок» — для старых проектов это прежнее поведение
  const cutLast = (file: string, roundId: string | null): boolean => {
    const txt = fs.readFileSync(file, "utf8");
    const re = /(?:\/\*|<!--)\s?── правка человека(?: #(\w+))? ──/g;
    const hits = [...txt.matchAll(re)];
    if (!hits.length) return false;
    const last = hits[hits.length - 1]!;
    // с текущим форматом: режем раунд с этим id (он мог быть не в последнем
    // блоке этого файла — тогда файл не трогаем), без id — как умеем
    const target = roundId ? hits.find((h) => h[1] === roundId) : last;
    if (!target) return false;
    const end = hits[hits.indexOf(target) + 1];
    fs.writeFileSync(file, txt.slice(0, target.index) + (end ? txt.slice(end.index) : ""));
    return true;
  };
  // id последнего раунда берём из css/html: любой файл с самым свежим id
  const lastRoundId = (): string | null => {
    let id: string | null = null;
    for (const f of [cssFile, htmlFile]) {
      if (!fs.existsSync(f)) continue;
      for (const m of fs.readFileSync(f, "utf8").matchAll(/правка человека #(\w+) ──/g))
        if (!id || m[1] > id) id = m[1];
    }
    // раунд мог быть swap-only (замена картинок без css/html) — его id живет
    // только в img-swaps.json
    try {
      for (const m of (JSON.parse(fs.readFileSync(path.join(dir, "img-swaps.json"), "utf8")) as Array<{ roundId?: string }>))
        if (m.roundId && (!id || m.roundId > id)) id = m.roundId;
    } catch {
      /* файла нет */
    }
    return id;
  };
  const rid = lastRoundId();
  let cut = false;
  for (const f of [cssFile, htmlFile]) {
    if (!fs.existsSync(f)) continue;
    if (cutLast(f, rid)) cut = true;
  }
  // замены картинок раунда живут в img-swaps.json — откат обязан срезать и их,
  // иначе «отменённая» правка продолжит подменять src
  const swFile = path.join(dir, "img-swaps.json");
  if (rid && fs.existsSync(swFile)) {
    try {
      const list = JSON.parse(fs.readFileSync(swFile, "utf8")) as Array<{ roundId?: string }>;
      const rest = list.filter((x) => x.roundId !== rid);
      if (rest.length !== list.length) {
        fs.writeFileSync(swFile, JSON.stringify(rest, null, 2) + "\n");
        cut = true;
      }
    } catch {
      /* битый json — пусть решит сборка */
    }
  }
  if (!cut) return reply.code(404).send({ error: "меток правки человека в overrides не найдено" });
  fixing.add(id);
  postOp.set(id, { kind: "fix", stage: "пересобираю без последней правки", startedAt: new Date().toISOString() });
  postOpResult.delete(id);
  void (async () => {
    try {
      const r = await rebuildAfterImages(id, dir, (stage) => {
        const cur = postOp.get(id);
        if (cur) postOp.set(id, { ...cur, stage });
      });
      postOpResult.set(id, {
        kind: "fix",
        ok: r.ok,
        note: r.ok ? "последняя правка отменена, сайт пересобран" : (r.error ?? "пересборка не удалась"),
        at: new Date().toISOString(),
      });
    } catch (err) {
      postOpResult.set(id, { kind: "fix", ok: false, note: (err as Error).message, at: new Date().toISOString() });
    } finally {
      postOp.delete(id);
      fixing.delete(id);
    }
  })();
  return { ok: true, started: true };
});

app.post("/api/runs/:id/command", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { cmd?: RunCommand; detail?: string };
  const h = runs.get(id);
  if (!h) return reply.code(404).send({ error: "прогон не запущен" });
  if (!body?.cmd) return reply.code(400).send({ error: "нет cmd" });
  h.command(body.cmd, body.detail);
  return { ok: true, status: h.status };
});

// ─── правка плана в gate: пересчёт planHash, запись site-plan.json ─────
app.post("/api/runs/:id/plan", async (req, reply) => {
  const { id } = req.params as { id: string };
  const h = runs.get(id);
  if (!h) return reply.code(404).send({ error: "прогон не запущен" });
  const plan = req.body as SitePlan | null;
  if (!plan) return reply.code(400).send({ error: "нет тела плана" });
  const res = h.patchPlan(plan);
  if (!res.ok) return reply.code(422).send({ error: res.error });
  return { ok: true, planHash: res.planHash };
});

// Список прогонов с диска: UI «Прогоны» живёт после перезапуска сервера,
// а не только пока процесс жив (runs-Map теряется, manifest.json — нет).
/**
 * Удалить проект из генератора. Разные смыслы у «не подошёл»:
 *  - рабочий прогон (`projects/<id>`) удаляется всегда;
 *  - снимок в библиотеке (`library/<id>`: zip + brief + план) остаётся, если
 *    не просили `full=1` — иначе «удалить неудачный вайт» стирал бы и уже
 *    выгруженный результат.
 * Живой прогон сначала отменяется: удалять папку из-под крутящегося графа —
 * значит ловить ENOENT в середине задачи.
 */
app.delete("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[\w.-]{3,64}$/.test(id)) return reply.code(400).send({ error: "имя проекта" });
  const full = (req.query as { full?: string } | undefined)?.full === "1";
  const dir = path.join(s.projectsRoot, id);
  const slot = path.join(libraryDir(), id);
  const inProjects = fs.existsSync(dir);
  const inLib = fs.existsSync(slot);
  if (!inProjects && !inLib) return reply.code(404).send({ error: `проекта ${id} нет` });

  const h = runs.get(id);
  if (h) {
    try {
      h.command("cancel");
    } catch {
      /* прогон уже догорает — папку всё равно сносим */
    }
    runs.delete(id);
  }
  try {
    if (inProjects) fs.rmSync(dir, { recursive: true, force: true });
    if (inLib && full) fs.rmSync(slot, { recursive: true, force: true });
    if (inLib && full) {
      const idx = libraryIndex().filter((e) => e.projectId !== id);
      fs.writeFileSync(path.join(libraryDir(), "index.json"), JSON.stringify(idx, null, 2) + "\n");
    }
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
  return { ok: true, removedProject: inProjects, removedLibrary: inLib && full };
});

app.get("/api/runs", async () => {
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(s.projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { runs: [] }; // папки projects ещё нет — это не ошибка
  }
  const out = [];
  for (const name of dirs) {
    const dir = path.join(s.projectsRoot, name);
    const read = <T,>(f: string): T | null => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
      } catch {
        return null;
      }
    };
    const manifest = read<RunManifest>("manifest.json");
    const brief = read<Brief>("brief.json");
    if (!manifest && !brief) continue;
    let done = false;
    let exported = false;
    try {
      // сборка ищется и как index.html, и как index.php: с галочкой php экспорт
      // отдаётся без .html, и проверка только по .html теряла готовый проект
      const built = (d: string) =>
        fs.existsSync(path.join(d, "index.html")) || fs.existsSync(path.join(d, "index.php"));
      done = built(path.join(dir, "dist"));
      exported = built(exportDirOf(dir));
    } catch {
      /* разорванная папка — считаем, что превью нет */
    }
    const active = runs.get(name);
    // миниатюра для панели «Проекты»: самый свежий снимок съёмки (тот же файл,
    // что показывает карточка ревью). Отдельный рендер не нужен — кадры уже
    // лежат на диске после judge/human-fix; превью отдаётся тем же /projects/
    let thumb: string | null = null;
    try {
      const shots = fs
        .readdirSync(path.join(dir, "preview"))
        .filter((f) => /^r\d+-(1280|768|375)\.png$/i.test(f))
        .map((f) => ({ f, r: Number(/^r(\d+)-/.exec(f)?.[1] ?? -1), w: /1280/.test(f) ? 3 : /768/.test(f) ? 2 : 1 }))
        .sort((a, b) => b.r - a.r || b.w - a.w);
      if (shots[0]) thumb = `/projects/${name}/preview/${shots[0].f}`;
    } catch {
      /* превью нет — миниатюры нет, это не ошибка */
    }
    // причину сбоя читаем из журнала: без неё «сбой» в списке ничего не объясняет
    let error: string | null = null;
    let lastState: string | null = null;
    try {
      const lines = fs.readFileSync(path.join(dir, "run.jsonl"), "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0 && (!error || !lastState); i--) {
        try {
          const e = JSON.parse(lines[i]) as { t?: string; message?: string; state?: string };
          if (!error && e.t === "task.error") error = (e.message ?? "").slice(0, 160);
          // манифеста при сбое на планировании не бывает — состояние берём из журнала
          if (!lastState && e.t === "run.state" && e.state) lastState = e.state;
        } catch {
          /* битая строка журнала — идём выше */
        }
      }
    } catch {
      /* журнала нет — прогон ещё не начинался */
    }
    out.push({
      error,
      projectId: name,
      mode: manifest?.mode ?? brief?.mode ?? "white",
      // «running» в манифесте без живого прогона — след прошлого процесса
      // (упавший/перезапущенный сервер): итог берём из журнала, где последняя
      // run.state — правда, а не из залипшей записи
      status:
        active?.status ??
        (manifest?.status === "running" && !active ? lastState ?? manifest.status : manifest?.status) ??
        lastState ??
        "draft",
      createdAt: manifest?.createdAt ?? null,
      finishedAt: manifest?.finishedAt ?? null,
      defects: manifest?.defects?.length ?? 0,
      images: manifest?.images?.length ?? 0,
      imagesDegraded: Boolean(manifest?.imagesDegraded),
      hasPreview: done,
      hasExport: exported,
      live: Boolean(active),
      thumb,
      // есть ли снимок в библиотеке: удаление рабочей папки при true оставляет
      // проект доступным (zip + промпт), и модалка обязана это сказать честно
      inLibrary: libraryIndex().some((e) => e.projectId === name),
    });
  }
  // готовые из библиотеки, чьей рабочей папки уже нет (выгрузили и почистили),
  // всё равно видны в панели: снимок и есть результат
  for (const e of libraryIndex()) {
    if (dirs.includes(e.projectId)) continue;
    out.push({
      error: null,
      projectId: e.projectId,
      mode: e.mode,
      status: "done",
      createdAt: e.createdAt,
      finishedAt: e.createdAt,
      defects: 0,
      images: 0,
      imagesDegraded: false,
      hasPreview: false, // превью живёт в projects/ — папки уже нет, ссылка была бы 404
      hasExport: Boolean(e.zip),
      live: false,
    });
  }
  out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return { runs: out };
});

// ─── прослушаем раньше, чем что-то упадёт ──────────────────────────────
try {
  await app.listen({ port: s.port, host: "127.0.0.1" });
  app.log.info(`сайдкар генератора: http://127.0.0.1:${s.port}`);
  void connectionFor; // используется в tasks-слое; здесь — заглушка импорта
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
