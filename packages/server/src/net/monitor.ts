/**
 * Живой мониторинг связи (SPEC §9).
 *
 * Зачем: индикатор придуман не для красоты, а чтобы во время генерации видеть,
 * ПОЧЕМУ модель отвечает медленно — лагает ли сеть/вайфай или тормозит сторона
 * провайдера. Снимок один раз при загрузке страницы для этого бесполезен.
 *
 * Что меряем и почему именно так (проверено на этой машине):
 *  · link    — TCP-handshake до 1.1.1.1:443. Чистый RTT до внешнего адреса:
 *              без DNS, без приложения, без чужих задержек генерации. Ровно то,
 *              что «плавает» при плохом вайфае. 12–25 мс в норме.
 *  · dns     — dns.lookup хоста провайдера. На WSL/домашних сетях это отдельный
 *              источник тормозов, который в HTTP-замере не виден по отдельности.
 *  · health  — свободный HTTP-запрос к тому же API (/models, /api/v1/me): он не
 *              тратит токены, но отвечает «провайдер жив / 500 / недоступен»,
 *              поэтому плашка модели живая и без запущенного прогона.
 *  · модель  — коды и длительности НАСТОЯЩИХ запросов (пишет connections-слой).
 *              Путь до провайдера в порядке, а ответ идёт 12 с → тормозит
 *              генерация, а не сеть: это видно только по фактическим запросам.
 *
 * Вайфай и интернет измерить раздельно нельзя: из WSL шлюз на TCP-порты не
 * отвечает, поэтому «путь до внешнего адреса» — единственная доступная точка,
 * и она покрывает оба участка сразу.
 *
 * Шлюз (default via …) мерить нельзя: из WSL он на TCP-порты не отвечает,
 * handshake даёт таймаут и выглядит как «сети нет».
 */
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

export interface RttSample {
  ms: number | null;
  ok: boolean;
}

export interface ConnectionProbe {
  id: string;
  name: string;
  kind: "llm" | "image";
  host: string;
  hasKey: boolean;
  active: boolean;
  /** путь до хоста провайдера */
  rtt: RttSample;
  /** резолв его имени */
  dns: RttSample;
  /** свободный health-пинг того же API: жив ли провайдер и каким кодом */
  health: { status: number; ms: number | null; at: number } | null;
  /**
   * Лента последних кодов СОБЫТИЙ связи: и рабочих запросов, и регулярных
   * проверок. Раньше показывались только запросы — без прогона плашка была
   * наполовину пустая даже при идеальном соединении, и это читалось как
   * «что-то не так».
   */
  ribbon: RibbonEvent[];
  /** последние настоящие запросы: длительность + коды ответов (0 = ответа не было) */
  calls: {
    count: number;
    lastMs: number | null;
    p50Ms: number | null;
    slowMs: number;
    codes: number[];
  };
  /** задачи целиком (генерация картинки, ответ модели): вот что юзер видит как «тормозит» */
  tasks: { count: number; lastMs: number | null; p50Ms: number | null; slowMs: number };
}

export interface NetSample {
  at: string;
  /** браузер/машина видит ли сеть вообще */
  online: boolean;
  /** link RTT до внешнего адреса: «вайфай» */
  link: RttSample;
  /** окно последних замеров link, старые первыми — по нему видно дрожание */
  linkWindow: number[];
  connections: ConnectionProbe[];
}

const WINDOW = 40; // ~2 минуты при шаге 3 с
const CALLS_KEPT = 12;
// health-пинг каждые 4 снимка (~12 с): провайдер должен быть виден и без прогона,
// но долбить его каждые 3 с незачем
const HEALTH_EVERY = 4;
let sampleNo = 0;
const healthCache = new Map<string, { status: number; ms: number | null; at: number }>();
const RIBBON_KEPT = 5;
export interface RibbonEvent {
  code: number;
  /** call — рабочий запрос модели, check — бесплатная проверка живости */
  kind: "call" | "check";
}
const ribbon = new Map<string, RibbonEvent[]>();

function pushRibbon(id: string, code: number, kind: RibbonEvent["kind"]): void {
  const arr = ribbon.get(id) ?? [];
  arr.push({ code, kind });
  if (arr.length > RIBBON_KEPT) arr.shift();
  ribbon.set(id, arr);
}
const PROBES: Array<{ name: string; host: string }> = [
  { name: "Cloudflare", host: "1.1.1.1" },
  { name: "Google", host: "8.8.8.8" },
];

/** Один TCP-handshake: быстрее и честнее HTTP-пинга, не трогает приложение. */
function tcpRtt(host: string, port = 443, timeoutMs = 2_500): Promise<RttSample> {
  const started = performance.now();
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, ms: Math.round((performance.now() - started) * 10) / 10 });
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function dnsRtt(host: string): Promise<RttSample> {
  const started = performance.now();
  try {
    await lookup(host);
    return { ok: true, ms: Math.round((performance.now() - started) * 10) / 10 };
  } catch {
    return { ok: false, ms: null };
  }
}

// ─── фактические запросы и задачи (пишут connections-слой и runners) ─────
interface CallStat {
  ms: number;
  at: number;
  /** HTTP-код ответа; 0 = ответа не было (таймаут, DNS, обрыв) */
  status: number;
}
const callLog = new Map<string, CallStat[]>();
const taskLog = new Map<string, CallStat[]>();

function push(map: Map<string, CallStat[]>, id: string, ms: number, status = 0): void {
  const arr = map.get(id) ?? [];
  arr.push({ ms: Math.round(ms), at: Date.now(), status });
  if (arr.length > CALLS_KEPT) arr.shift();
  map.set(id, arr);
}

function stats(map: Map<string, CallStat[]>, id: string): ConnectionProbe["calls"] {
  const arr = map.get(id) ?? [];
  if (!arr.length) return { count: 0, lastMs: null, p50Ms: null, slowMs: 0, codes: [] };
  const sorted = [...arr].sort((a, b) => a.ms - b.ms);
  return {
    count: arr.length,
    lastMs: arr[arr.length - 1]!.ms,
    p50Ms: sorted[Math.floor(sorted.length / 2)]!.ms,
    slowMs: sorted[sorted.length - 1]!.ms,
    // новые коды в конце: UI рисует их слева направо как ленту истории
    codes: arr.map((c) => c.status),
  };
}

/**
 * Длительность одного HTTP-запроса: чистая сеть, без ожидания генерации.
 * У поллинг-протоколов она маленькая всегда, и в этом смысл сравнения с tasks.
 */
export function recordCall(connectionId: string, ms: number, status = 0): void {
  push(callLog, connectionId, ms, status);
  pushRibbon(connectionId, status, "call");
}

/**
 * Длительность задачи целиком — от запроса до готового ответа/файла. Для
 * картинки это и 13 с генерации: именно это юзер называет «модель тормозит».
 */
export function recordTask(connectionId: string, ms: number): void {
  push(taskLog, connectionId, ms);
}

// ─── состояние монитора ─────────────────────────────────────────────────
type Target = {
  id: string;
  name: string;
  kind: "llm" | "image";
  host: string;
  /** полный адрес: health-пинг ходит туда же, куда и работа */
  baseUrl: string;
  hasKey: boolean;
  /** назначено ли подключение на роль прямо сейчас — вердикт смотрит на него,
      а не на самое медленное из всех включённых */
  active: boolean;
  /** бесплатный эндпоинт для проверки живости (не тратит токены) */
  healthPath: string;
  /** тот же ключ, что и у работы: без него провайдер отвечает 401, и это
      выглядело бы как «ключ плохой», хотя ключ просто не приложили */
  key: string | null;
};

let linkWindow: number[] = [];
let lastLink: RttSample = { ok: false, ms: null };
let lastSample: NetSample | null = null;
let timer: NodeJS.Timeout | null = null;
const subscribers = new Set<(s: NetSample) => void>();

/**
 * Живость провайдера: GET на его бесплатный эндпоинт. Код ответа важнее тела —
 * 200 = жив, 401 = жив, но ключ плохой, 429 = жив и переполнен, 5xx = его проблема.
 */
async function healthProbe(
  target: Target,
): Promise<{ status: number; ms: number | null; at: number }> {
  const started = performance.now();
  try {
    const res = await fetch(`${target.baseUrl}${target.healthPath}`, {
      signal: AbortSignal.timeout(6_000),
      redirect: "follow",
      headers: target.key ? { authorization: `Bearer ${target.key}` } : {},
    });
    return {
      status: res.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
      at: Date.now(),
    };
  } catch {
    // 0 = ответа не было: DNS не дал адрес, коннект упал или таймаут
    return { status: 0, ms: null, at: Date.now() };
  }
}

async function sample(targets: Target[]): Promise<NetSample> {
  sampleNo += 1;
  // Все точки мерятся параллельно: последовательный обход добавлял бы секунды
  // к каждому снимку и сам выглядел бы как «лаг».
  const [link, ...perConn] = await Promise.all([
    tcpRtt(PROBES[0]!.host),
    ...targets.map(async (t): Promise<ConnectionProbe> => {
      const [rtt, dns] = await Promise.all([tcpRtt(t.host), dnsRtt(t.host)]);
      // Без ключа проверять нечем: пинг без Authorization вернёт 401, и лента
      // покраснела бы «ключ плохой» там, где ключ просто ещё не вставили
      // (свежий шаринг генератора). Такое подключение — «не подключено», серый.
      if (!t.hasKey) {
        return {
          ...t,
          rtt,
          dns,
          health: null,
          ribbon: [],
          calls: stats(callLog, t.id),
          tasks: stats(taskLog, t.id),
        };
      }
      // health каждые HEALTH_EVERY снимков, остальные берут прошлый код: лента
      // истории кодов при этом остаётся полной, потому что реальные запросы пишутся всегда
      if (sampleNo % HEALTH_EVERY === 1 || !healthCache.has(t.id)) {
        const h = await healthProbe(t);
        healthCache.set(t.id, h);
        // Каждый пинг — событие ленты: полная зелёная лента = последнюю минуту
        // провайдер отвечал хорошо на каждой проверке. Пустая — ещё ничего не
        // проверяли; неполная — только что стартанули, лента наполнится за минуту
        pushRibbon(t.id, h.status, "check");
      }
      return {
        ...t,
        rtt,
        dns,
        health: healthCache.get(t.id) ?? null,
        ribbon: [...(ribbon.get(t.id) ?? [])],
        calls: stats(callLog, t.id),
        tasks: stats(taskLog, t.id),
      };
    }),
  ]);

  lastLink = link;
  if (link.ok && link.ms != null) {
    linkWindow.push(link.ms);
    if (linkWindow.length > WINDOW) linkWindow.shift();
  }

  lastSample = {
    at: new Date().toISOString(),
    online: link.ok,
    link,
    linkWindow: [...linkWindow],
    connections: perConn,
  };
  for (const cb of subscribers) {
    try {
      cb(lastSample);
    } catch {
      /* подписчик умер — чистит себя сам при close */
    }
  }
  return lastSample;
}

/**
 * Запускает непрерывный опрос. Интервал короткий намеренно: «вайфай просел»
 * должно стать видно раньше, чем юзер решит, что зависла генерация.
 */
export function startNetMonitor(getTargets: () => Target[], intervalMs = 3_000): void {
  if (timer) return;
  void sample(getTargets());
  timer = setInterval(() => void sample(getTargets()), intervalMs);
  timer.unref?.();
}

/** Последний снимок без замера: UI должен получать его мгновенно. */
export function netSnapshot(): NetSample | null {
  return lastSample;
}

/** Принудительный замер по клику на индикатор. */
export async function netRefresh(getTargets: () => Target[]): Promise<NetSample> {
  return sample(getTargets());
}

export function subscribeNet(cb: (s: NetSample) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Дрожание link за окно: то, что отличает «стабильно медленно» от «рывками». */
export function linkJitter(): { p50: number | null; p95: number | null; jitter: number | null } {
  const xs = [...linkWindow].sort((a, b) => a - b);
  if (!xs.length) return { p50: null, p95: null, jitter: null };
  const p50 = xs[Math.floor(xs.length / 2)]!;
  const p95 = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;
  return { p50, p95, jitter: Math.round((p95 - p50) * 10) / 10 };
}
