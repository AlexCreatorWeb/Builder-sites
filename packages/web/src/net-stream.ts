/**
 * Единственный поток связи на страницу. Серверный монитор (net/monitor.ts)
 * шлёт снимок каждые ~3 с; несколько компонентов (индикатор сети в сайдбаре и
 * health-индикаторы у моделей) подписываются на ОДИН EventSource, а не заводят
 * по своему — иначе сайдкар держал бы три одинаковых соединения.
 */
import type { NetSample } from "./api";

type Sub = (s: NetSample) => void;

let es: EventSource | null = null;
let last: NetSample | null = null;
const subs = new Set<Sub>();

function ensureStream(): void {
  if (es) return;
  es = new EventSource("/api/net/stream");
  es.onmessage = (e) => {
    try {
      emit(applySim(JSON.parse(e.data) as NetSample));
    } catch {
      /* событие не JSON */
    }
  };
  // Поток мог пережить перезапуск сайдкара: просим снимок напрямую, чтобы
  // индикаторы не залипли на последнем значении.
  es.onerror = () => {
    void fetch("/api/net")
      .then((r) => (r.ok ? (r.json() as Promise<NetSample>) : null))
      .then((s) => {
        if (!s) return;
        emit(applySim(s));
      })
      .catch(() => undefined);
  };
}

/**
 * Имитация «провайдер картинок отвалился» для просмотра интерфейса: только
 * вид, состояние и подсказки, как при настоящей аварии. Только в dev: лечится
 * адресом ?net=bad, живёт до перезагрузки.
 *
 * Подменять приходится сам снимок, а не компонент: health-индикатор, плашка
 * подключения и очередь прогона читают ОДИН поток, и подмена в одном месте
 * разъехалась бы с остальными.
 */
export type NetSim = "bad" | "warn" | null;

function simFromLocation(): NetSim {
  if (typeof location === "undefined" || !import.meta.env.DEV) return null;
  const q = new URLSearchParams(location.search).get("net");
  return q === "bad" || q === "warn" ? q : null;
}

let sim: NetSim = simFromLocation();

/**
 * Как выглядит плохое подключение к провайдеру картинок: картинка — это
 * длинный запрос, поэтому ретраи сжигаются молча (провайдер не отвечает,
 * кода нет), а health-пинг кончается 503. Лента строится как РЕАЛЬНЫЙ
 * обрыв: два успешных события в истории, потом отказы — иначе картина
 * «его никогда не было» вместо «он был и лёг».
 */
function applySim(s: NetSample): NetSample {
  if (!sim) return s;
  const code = sim === "bad" ? 0 : 429;
  const ribbon = [
    { code: 200, kind: "call" as const },
    { code: 200, kind: "call" as const },
    { code, kind: "call" as const },
    { code, kind: "call" as const },
    { code, kind: "check" as const },
  ];
  return {
    ...s,
    connections: s.connections.map((c) =>
      c.kind !== "image"
        ? c
        : {
            ...c,
            health: c.health ? { ...c.health, status: code || 503, ms: null } : c.health,
            ribbon,
            calls: { ...c.calls, codes: Array.from({ length: 5 }, () => code) },
          },
    ),
  };
}

function emit(s: NetSample): void {
  last = s;
  for (const cb of subs) cb(s);
}

export function subscribeNet(cb: Sub): () => void {
  subs.add(cb);
  ensureStream();
  if (last) cb(applySim(last));
  return () => {
    subs.delete(cb);
  };
}

/** Принудительный замер (клик по индикатору): сервер меряет сейчас же. */
export function netRefresh(): void {
  void fetch("/api/net/refresh", { method: "POST" })
    .then((r) => (r.ok ? (r.json() as Promise<NetSample>) : null))
    .then((s) => {
      if (!s) return;
      emit(applySim(s));
    })
    .catch(() => undefined);
}
