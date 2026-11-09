import { useEffect, useRef, useState } from "react";

/**
 * Подсказка у поля: короткий `?`-маркер, текст раскрывается при наведении и фокусе.
 * Держимся native-механики (CSS-попап), без библиотеки: на локальной витрине
 * это один слой z-index и ноль зависимостей.
 *
 * Палец `:hover` не умеет, а `title` на тач не показывается вовсе — поэтому
 * маркер стал настоящей кнопкой: клик (и Enter/Space, которые даёт role)
 * переключает попап, повторный клик или Escape закрывают. Наружный клик тоже
 * закрывает: 10 открытых подсказок превращают форму в веер.
 */
export default function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const markRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!markRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return (
    <span
      className={`hint-mark${open ? " open" : ""}`}
      ref={markRef}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`Подсказка: ${text}`}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
    >
      ?
      <span className="hint-pop" role="tooltip">
        {text}
      </span>
    </span>
  );
}
