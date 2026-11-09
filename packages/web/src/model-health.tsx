/**
 * Индикатор конкретного подключения (в плашке модели, над названием).
 * Отвечает на один вопрос: «эта модель сейчас работает или нет».
 *
 * Лента событий — последние 5 обращений к провайдеру (~минута: бесплатные
 * проверки живости каждые ~12 с + рабочие запросы прогона между ними). По ней
 * считается ВЕРДИКТ, а индикатор показывает его как уровень, по принципу
 * индикатора сети: чем хуже, тем меньше палочек и тем тревожнее цвет.
 *
 *   ok   → 5 зелёных, последняя пульсирует (эквалайзер: 5 ⇄ 4) — «живой» сигнал
 *   warn → 3 жёлтые   (жив, но упирается: 4xx / 429)
 *   bad  → 2 красные  (5xx или ответа не было вовсе)
 *
 * Порог «больше трёх = зелёные» здесь, а не «число событий»: подключение
 * меряется одним запросом, и молчаливый провайдер — это вердикт всем делениям
 * сразу, а не одной. История самих событий остаётся в подсказке.
 *
 * Палочки пульсом только в зелёном состоянии: мигать при 429 — значит
 * перекрикивать соседа, у которого всё плохо по-настоящему.
 */
import type { NetSample } from "./api";

const TICKS = 5;

/** Сколько палочек рисует каждый вердикт (уровень, как у индикатора сети). */
const LEVEL: Record<"ok" | "warn" | "bad", number> = { ok: 5, warn: 3, bad: 2 };

/**
 * Палочки индикатора: первые `lit` в тоне вердикта, остальные — пустые.
 * `pulse` — зелёный сигнал: последняя палочка мигает, от чего полный
 * эквалайзер ходит 5 ⇄ 4.
 */
function Ticks({ tone, pulse = false }: { tone: "ok" | "warn" | "bad"; pulse?: boolean }) {
  const lit = LEVEL[tone];
  return (
    <span className="mh-ticks" aria-hidden>
      {Array.from({ length: TICKS }, (_, i) => (
        <i
          key={i}
          className={i < lit ? `t-${tone}${pulse && i === lit - 1 ? " pulse" : ""}` : "t-empty"}
        />
      ))}
    </span>
  );
}

/** Пять пустых делений: состояния «неизвестно» — проверять ещё нечем. */
function EmptyTicks() {
  return (
    <span className="mh-ticks" aria-hidden>
      {Array.from({ length: TICKS }, (_, i) => (
        <i key={i} className="t-empty" />
      ))}
    </span>
  );
}

function toneOf(code: number): "ok" | "warn" | "bad" {
  if (code === 0 || code >= 500) return "bad";
  if (code >= 400 && code < 500) return "warn";
  return "ok";
}

const CODE_LABEL: Record<number, string> = {
  401: "ключ не принят",
  403: "ключ не принят",
  404: "нет такого адреса",
  429: "квота/рейт",
  0: "нет ответа",
};

function codeLabel(code: number): string {
  return (
    CODE_LABEL[code] ??
    (code >= 500 ? "ошибка провайдера" : code >= 200 && code < 300 ? "ответ принят" : `код ${code}`)
  );
}

const KIND_LABEL = { call: "запрос модели", check: "проверка API" } as const;

export default function ModelHealth({
  id,
  sample,
  blocked,
}: {
  id: string;
  sample: NetSample | null;
  /** выбранная модель недоступна аккаунту (платная при нулевом балансе):
      провайдер живой, но ИМЕННО ей не воспользоваться — индикатор красный */
  blocked?: boolean;
}) {
  const conn = sample?.connections.find((c) => c.id === id);
  const events = (conn?.ribbon ?? []).slice(-TICKS);

  // Ключа нет (свежий шаринг генератора) — проверять нечем. Сервер такого
  // уже не пингует, но и подпись должна быть честной: «не подключено», а не
  // красное «ключ не принят»: 401 без приложенного ключа ничего не значит.
  if (conn && !conn.hasKey) {
    return (
      <span className="mh n-unknown" title="ключа нет — вставь его в окне модели">
        <EmptyTicks />
        <span className="mh-text">не подключено</span>
      </span>
    );
  }

  if (!events.length) {
    return (
      <span
        className="mh n-unknown"
        title={sample ? "ждём первую проверку подключения" : "ждём первый снимок связи"}
      >
        <EmptyTicks />
        <span className="mh-text">проверка…</span>
      </span>
    );
  }

  // Худший из ленты: один 500 важнее четырёх 200 — заметить надо именно его
  const worst = events.reduce<"ok" | "warn" | "bad">((acc, e) => {
    const t = toneOf(e.code);
    if (t === "bad" || acc === "bad") return "bad";
    if (t === "warn" || acc === "warn") return "warn";
    return "ok";
  }, "ok");

  // Вердикт подключению единый: ВСЕ деления одного цвета — тон = худший из ленты.
  // Одна красная среди четырёх зелёных читалась как «едва пошевеливается»,
  // а не как «модель лежит». Лента остаётся историей: когда провайдер
  // выздоровеет, новые зелёные проверки вытеснят красные сами (~минута).
  const tone = worst === "bad" ? "bad" : worst === "warn" ? "warn" : "ok";

  // Модель недоступна аккаунту: API-то отвечает (200 на проверке живости), но
  // генерация на ней встанет. Показываем красным и своей подписью — иначе
  // «работает» на выбранной платной модели при $0 врёт юзеру в лицо.
  if (blocked) {
    return (
      <span
        className="mh n-bad"
        title="провайдер отвечает, но баланс $0: платные модели он не отдаёт.\nВыбери модель с :free или пополни баланс"
      >
        <Ticks tone="bad" />
        <span className="mh-text">модель недоступна</span>
      </span>
    );
  }

  const shown = events.find((e) => toneOf(e.code) === worst) ?? events[events.length - 1]!;
  const dead = worst === "bad" && events.every((e) => e.code === 0);
  const label =
    worst === "bad"
      ? dead
        ? "нет ответа"
        : codeLabel(shown.code) === "ошибка провайдера"
          ? "не отвечает"
          : codeLabel(shown.code)
      : worst === "warn"
        ? codeLabel(shown.code)
        : "работает";

  const tip = [
    ...events.map((e) => `${KIND_LABEL[e.kind]}: HTTP ${e.code || "—"} — ${codeLabel(e.code)}`),
    conn?.health && conn.health.ms != null
      ? `последняя проверка: ${Math.round(conn.health.ms)} мс`
      : "",
    "лента ниже ≈ последняя минута: проверки каждые ~12 с, запросы прогона — поверх; индикатор показывает вердикт по ленте, а не её длину",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className={`mh n-${worst}`} title={tip}>
      <Ticks tone={tone} pulse={tone === "ok"} />
      <span className="mh-text">{label}</span>
    </span>
  );
}
