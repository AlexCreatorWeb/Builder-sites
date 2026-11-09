/**
 * Индикатор СЕТИ (верх сайдбара). Только сеть и ничего больше: путь до
 * внешнего адреса покрывает и вайфай, и выход в интернет — раздельно изнутри
 * WSL измерить нельзя (шлюз на TCP не отвечает), поэтому и подпись одна.
 * Здоровье конкретных моделей — у каждой модели свой индикатор (model-health).
 *
 * Текст нарочно короткий и меняется редко: мигающие числа глаз читает как
 * поломку. Числа — в подсказке; деления = уровень, цвет = вердикт.
 */
import { useCallback, useEffect, useState } from "react";
import { netRefresh, subscribeNet } from "./net-stream";
import type { NetSample } from "./api";

const BARS = 10;

// Пороги по замерам этой машины: путь 12–25 мс в норме, 60–90 мс бывает при
// загрузке канала, единицы сотен — сел вайфай.
const WARN_MS = 150;
const BAD_MS = 400;

export default function NetIndicator() {
  const [sample, setSample] = useState<NetSample | null>(null);
  const browserOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

  useEffect(() => subscribeNet(setSample), []);

  // Ровность делений следит за масштабом окна: Ctrl+колесо меняет dpr на лету
  const [geo, setGeo] = useState(() => tickGeometry());
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const update = () => setGeo(tickGeometry());
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [geo.dpr]);

  const retry = useCallback(() => netRefresh(), []);

  const now = sample?.link.ok ? (sample.link.ms ?? 0) : null;
  // Оцениваем последние ~20 с: одинокий пик не должен держать красную подпись
  // две минуты, когда путь уже восстановился
  const recent = (sample?.linkWindow ?? []).slice(-7);
  const worst = recent.length ? Math.max(...recent) : 0;

  const verdict = (() => {
    if (!browserOnline) return { label: "нет сети", tone: "bad" as const, v: 0 };
    if (!sample) return { label: "проверка…", tone: "warn" as const, v: 0.4 };
    if (!sample.online || now == null) return { label: "нет интернета", tone: "bad" as const, v: 0.12 };
    if (now >= BAD_MS) return { label: "сеть лагает", tone: "bad" as const, v: 0.25 };
    if (now >= WARN_MS || worst >= BAD_MS)
      return { label: "сеть плавает", tone: "warn" as const, v: 0.6 };
    // «сеть есть» звучало как «ну, работает» — а это лучший из возможных
    // ответов индикатора: путь стабилен, задержки нет. «Устойчивая» честнее
    // «отличной»: отличный порог у нас 150 мс, а не 15
    return { label: "сеть устойчивая", tone: "ok" as const, v: 1 };
  })();

  const lit =
    verdict.tone === "ok"
      ? BARS
      : verdict.tone === "warn"
        ? Math.max(4, Math.round(verdict.v * BARS))
        : 2;
  const zone = verdict.tone === "ok" ? "g" : verdict.tone === "warn" ? "y" : "r";

  const tip = [
    now != null ? `путь сейчас: ${Math.round(now)} мс` : "путь: нет ответа",
    worst ? `худший за 20 с: ${Math.round(worst)} мс` : "",
    "вайфай и интернет меряются вместе — отдельного замера шлюза из WSL нет",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      className={`sigmark ${verdict.tone}`}
      onClick={retry}
      aria-label={`Сеть: ${verdict.label}`}
      title={`${verdict.label}. Клик — измерить сейчас.\n${tip}`}
      style={
        {
          "--tick-w": `${geo.w}px`,
          "--tick-gap": `${geo.gap}px`,
          "--tick-h": `${geo.h}px`,
        } as React.CSSProperties
      }
    >
      <span className="sigmark-bars" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} className={i < lit ? `on z-${zone}` : ""} />
        ))}
      </span>
      <span className="sigmark-text">{verdict.label}</span>
    </button>
  );
}

/**
 * Размеры деления, кратные целому числу физических пикселей: желаемые CSS-пиксели
 * округляются до целого числа физических, а потом пересчитываются обратно.
 * Иначе на масштабе 125% деления в 3px растеклись бы то в 3, то в 4 пикселя.
 */
function tickGeometry(): { w: number; gap: number; h: number; dpr: number } {
  const dpr = Math.max(1, Math.round((window.devicePixelRatio || 1) * 100) / 100);
  const px = (cssWanted: number) => Math.round(cssWanted * dpr) / dpr;
  return { w: px(3), gap: px(2), h: px(12), dpr };
}
