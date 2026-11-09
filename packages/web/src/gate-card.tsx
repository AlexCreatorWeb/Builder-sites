/**
 * Единственный шлюз — после плана (SPEC §7).
 * Карточка: секции-карточки (тип, H2, slug) · палитра-плашки · картинки «slug → описание»
 * · смета. Кнопки: Поехали (Enter) · Править · Перегенерить с комментарием · JSON ▾.
 * Правки уходят на сайдкар целиком (patchPlan), там sanitizePlan + пересчёт planHash.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunManifest, SitePlan } from "@builder/shared";

export default function GateCard({
  plan: incoming,
  estimate,
  pageCount,
  onGo,
  onBack,
  onRegen,
  onPatch,
  busy,
}: {
  plan: SitePlan;
  estimate?: RunManifest["estimate"];
  /** страниц в брифе — чтобы в шлюзе честно объяснить, что собираем главную */
  pageCount?: number;
  onGo: () => void;
  onBack: () => void;
  onRegen: (comment: string) => void;
  onPatch: (plan: SitePlan) => Promise<string | null>;
  busy: boolean;
}) {
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<SitePlan>(incoming);
  const [comment, setComment] = useState("");
  const [showJson, setShowJson] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  // новый план из прогона (например, после «перегенерить») — сбрасываем черновик
  useEffect(() => {
    setDraft(incoming);
    setEdit(false);
  }, [incoming]);

  // Enter = «Поехали» (SPEC §7), но не когда печатают в поле
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      onGo();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onGo]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(incoming), [draft, incoming]);

  function patchSection(i: number, patch: Partial<SitePlan["sections"][number]>) {
    setDraft((p) => ({ ...p, sections: p.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  }
  function patchImage(i: number, patch: Partial<SitePlan["images"][number]>) {
    setDraft((p) => ({ ...p, images: p.images.map((im, j) => (j === i ? { ...im, ...patch } : im)) }));
  }

  async function save() {
    const err = await onPatch(draft);
    setNote(err ?? "план сохранён, planHash пересчитан");
    if (!err) setEdit(false);
  }

  return (
    <div className="gate" ref={box} role="region" aria-label="Шлюз: план сборки">
      <div className="gate-head">
        <div>
          <p className="eyebrow">шлюз · план готов, токены ещё не потрачены</p>
          <h3>Проверь план</h3>
        </div>
        <dl className="estimate">
          <div>
            <dt>картинок</dt>
            <dd>{estimate?.images ?? draft.images.length}</dd>
          </div>
          <div>
            <dt>токенов ≈</dt>
            <dd>{(estimate?.tokens ?? 0).toLocaleString("ru-RU")}</dd>
          </div>
          <div>
            <dt>секций</dt>
            <dd>{draft.sections.length}</dd>
          </div>
          {/* машина, а не человек: минуты без оговорки «без вас» звучали как
              обещание, а white_001 с сетевым штормом шёл вдвое дольше сметы */}
          {estimate?.minutes ? (
            <div>
              <dt>машине ≈</dt>
              <dd>{estimate.minutes} мин</dd>
            </div>
          ) : null}
        </dl>
      </div>

      {(pageCount ?? 1) > 1 && (
        <p className="gate-scope" role="note">
          В брифе {pageCount} страницы — генератор соберёт <b>все</b>:
          {(incoming.pages ?? []).length > 0
            ? ` ${(incoming.pages ?? []).map((pg) => pg.slug + ".html").join(", ")} + главная.`
            : " главная + вложенные по структуре серии."}
          {/* JSX склеивает соседние текстовые узлы в один: без этого на самой
              важной карточке читалось «…по структуре серии.Тонкие блоки» */}{" "}
          Тонкие блоки (цены, вопросы) на главной — короткими карточками со ссылками на
          вложенные страницы. Что-то не так с выбором страниц? Жми «Назад в бриф» —
          бриф правится без запуска генерации.
        </p>
      )}

      {(incoming.pages ?? []).length > 0 && (
        <div className="gate-pages">
          <span className="gate-label">страницы сайта</span>
          <ol className="gate-pages-list">
            <li>
              <b>index</b>
              <em>главная · {incoming.sections.length} секции</em>
            </li>
            {incoming.pages!.map((pg) => (
              <li key={pg.slug}>
                <b>{pg.slug}</b>
                <em>
                  {pg.heading} · {pg.sections.length} секции
                </em>
              </li>
            ))}
          </ol>
        </div>
      )}

      <ol className="gate-sections">
        {draft.sections.map((s, i) => (
          <li key={s.slug}>
            <span className="gate-type mono">{s.type}</span>
            {edit ? (
              <input
                value={s.heading}
                aria-label={`Заголовок секции ${s.slug}`}
                onChange={(e) => patchSection(i, { heading: e.target.value })}
              />
            ) : (
              <span className="gate-heading">{s.heading}</span>
            )}
            <span className="gate-slug mono">{s.slug}</span>
          </li>
        ))}
      </ol>

      <div className="gate-row">
        <div className="gate-palette">
          <span className="gate-label">палитра</span>
          {Object.entries(draft.palette).map(([k, v]) => (
            <label className="gate-chip" key={k}>
              {edit ? (
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#000000"}
                  aria-label={`Цвет ${k}`}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, palette: { ...p.palette, [k]: e.target.value.toUpperCase() } }))
                  }
                />
              ) : (
                <i style={{ background: v }} />
              )}
              <em>{k}</em>
              <b className="mono">{v}</b>
            </label>
          ))}
        </div>
        <p className="gate-label">
          шрифты: <b className="mono">{draft.fonts.heading}</b> / <b className="mono">{draft.fonts.body}</b>
        </p>
      </div>

      <ul className="gate-images">
        {draft.images.map((im, i) => (
          <li key={im.slug}>
            <span className="gate-slug mono">{im.slug}</span>
            {edit ? (
              <input
                value={im.description}
                aria-label={`Описание картинки ${im.slug}`}
                onChange={(e) => patchImage(i, { description: e.target.value })}
              />
            ) : (
              <span>{im.description}</span>
            )}
            <span className="gate-aspect mono">
              {im.aspect} · {im.role}
            </span>
          </li>
        ))}
        {draft.images.length === 0 && <li className="gate-none">картинок в плане нет — сборка без графики</li>}
      </ul>

      {draft.hardRules.length > 0 && (
        <p className="gate-rules">
          {draft.hardRules.map((r) => (
            <span className="gate-rule" key={r}>
              {r}
            </span>
          ))}
        </p>
      )}

      {edit && (
        <div className="gate-json-head">
          <span className="gate-label">slug — контракт имён файлов: менять осторожно</span>
        </div>
      )}

      {showJson && <pre className="gate-pre mono">{JSON.stringify(draft, null, 2)}</pre>}

      <div className="gate-actions">
        <button
          type="button"
          className="btn primary"
          title="Запустить генерацию: тексты, картинки, код. Enter делает то же самое."
          onClick={onGo}
          disabled={busy}
        >
          Поехали
        </button>
        {edit ? (
          <>
            <button type="button" className="btn ghost" onClick={() => void save()} disabled={busy || !dirty}>
              Сохранить правки
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setDraft(incoming);
                setEdit(false);
              }}
            >
              Отменить
            </button>
          </>
        ) : (
          <button type="button" className="btn ghost" title="Поправить заголовки секций, палитру и описания картинок" onClick={() => setEdit(true)}>
            Править
          </button>
        )}
        <input
          className="gate-comment"
          value={comment}
          placeholder="комментарий для перегенерации плана"
          aria-label="Комментарий для перегенерации плана"
          onChange={(e) => setComment(e.target.value)}
        />
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => onRegen(comment.trim() || "сделай план иначе, сохранив Brief")}
        >
          Перегенерить
        </button>
        <button type="button" className="linkbtn" onClick={() => setShowJson((v) => !v)}>
          {showJson ? "JSON ▴" : "JSON ▾"}
        </button>
        <button
          type="button"
          className="btn ghost gate-back"
          title="Выйти из плана в бриф: прогон отменяется, ничего не тарифицируется, папка проекта очищается под новый запуск"
          onClick={onBack}
          disabled={busy}
        >
          ← Назад в бриф
        </button>
      </div>
      <p className="gate-hint">
        Enter — тоже «Поехали». «Назад в бриф» — отменить запуск и вернуться править бриф.
        {dirty && !edit ? " Есть несохранённые правки: нажми Править → Сохранить." : ""}
        {note ? ` ${note}` : ""}
      </p>
    </div>
  );
}
