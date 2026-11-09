import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";

/**
 * Список проектов на диске: что генератор уже собрал и чем кончил. Нужен,
 * чтобы вернуть готовое не в момент прогона, а завтра: папка живёт в projects/,
 * превью открывается ссылкой,zip — кнопкой скачивания. Обновляется по таймеру
 * только пока что-то идёт (live), иначе — один раз при открытии.
 */
export default function ProjectsPanel() {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ReturnType<typeof map>[] | null>(null);
  /** проект, помеченный на удаление: вместо него открывается модалка */
  const [ask, setAsk] = useState<ReturnType<typeof map> | null>(null);
  /** «удаляю» — кнопка не должна позволявать двойной клик */
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** строка, под курсором которой висит миниатюра: { url, имя, rect } */
  const [peek, setPeek] = useState<{ url: string; projectId: string; x: number; y: number } | null>(null);
  /** задержка перед показом: курсор пробегает список по пути к корзине,
      и всплывать на каждом проходе — только дёргать глаз */
  const peekTimer = useRef<number | null>(null);
  const hidePeek = () => {
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = null;
    setPeek(null);
  };
  const showPeek = (row: { projectId: string; thumb?: string | null }, el: HTMLElement) => {
    if (!row.thumb) return;
    const r = el.getBoundingClientRect();
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(
      () => setPeek({ url: row.thumb!, projectId: row.projectId, x: r.right, y: r.top }),
      260,
    );
  };

  const load = useCallback(() => {
    api
      .projects()
      .then((r) => setRuns(r.runs.map(map)))
      .catch(() => setRuns([]));
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // активный прогон подкрашивает список сами по себе: без live-обновления
  // «готово» появилось бы только после перезагрузки страницы
  useEffect(() => {
    if (!open || !runs?.some((r) => r.live)) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [open, runs, load]);

  // Esc закрывает подтверждение: у карточки role="dialog", и с клавиатуры
  // отказ от удаления должен быть возможен без мыши (мышью промахнуться дороже)
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setAsk(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, busy]);

  // в панели — ЛЮБОЙ вайт, о котором знает генератор: собранный, ждущий
  // человека, отменённый или даже вчерашний черновик брифа (у него может не быть
  // ни сборки, ни экспорта — строка всё равно нужна, иначе список выглядит
  // пустым, хотя прогонов было десять). Раньше стоял фильтр «done | review», и
  // каждый новый прогон выглядел как перезатирание старого: в списке физически
  // жила одна строка, потому что предыдущие вайты скрывались фильтром, а не
  // потому что перезаписывалась папка
  const shown = runs ?? [];

  return (
    <div className={`panel projects${open ? " open" : ""}`}>
      <button type="button" className="panel-head" onClick={() => setOpen((o) => !o)}>
        Проекты
        {shown.length > 0 && <span className="count">{shown.length}</span>}
        <span className="caret" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path
              d="M3.5 4.5 6 7l2.5-2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && (
        <div className="projects-list">
          {!runs && <span className="hint">загружаю…</span>}
          {runs && shown.length === 0 && (
            <span className="hint">готовых проектов пока нет — здесь появятся собранные и принятые проверками</span>
          )}
          {shown.map((r) => (
            <div
              key={r.projectId}
              className={`project-row ${r.live ? "live" : ""}`}
              onMouseEnter={(e) => showPeek(r, e.currentTarget)}
              onMouseLeave={hidePeek}
            >
              {/* Пустой href — не «ссылка в никуда»: браузер открывает ТЕКУЩУЮ
                  страницу, и у отменённого до сборки вайта клик по имени открывал
                  генератор в новой вкладке. Без сборки имени вообще не ссылка */}
              {r.previewUrl ? (
                <a
                  className="project-id mono"
                  href={r.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="открыть превью"
                >
                  {r.projectId}
                </a>
              ) : (
                <span className="project-id mono dead" title="сборки нет — открывать нечего">
                  {r.projectId}
                </span>
              )}
              {/* Подпись = СОСТОЯНИЕ ПРОГОНА, и для двух состояний она ещё и
                  кнопка: «Просмотреть» и «Нужны действия» — это не констатация
                  факта, а просьба к человеку, поэтому клик открывает карточку
                  ревью этого проекта (вердикт, «Допилить», выгрузка). Без ссылки
                  подпись заставляла гадать, чем её «использовать».
                  «отменён»/«черновик» — не кликабельны: там делать нечего */}
              {r.label &&
                (r.reviewable ? (
                  <button
                    type="button"
                    className={`project-status link s-${r.tone}`}
                    title={r.status === "review" ? TOOLTIP.review : TOOLTIP.needs_human}
                    onClick={() => openReview(r.projectId)}
                  >
                    {r.label}
                  </button>
                ) : (
                  <span className={`project-status s-${r.tone}`} title={TOOLTIP[r.status] ?? ""}>
                    {r.label}
                  </span>
                ))}
              {/* один контейнер действий на строку: grid отдаёт под него одну
                  колонку, поэтому и скачивание, и корзина живут внутри —
                  иначе кнопка уезжала бы в автоставленную ячейку */}
              <span className="project-acts">
              {r.ready && (
                <>
                  <a
                    className="project-ico"
                    href={api.downloadUrl(r.projectId)}
                    title={`Скачать архив сайта — ${r.projectId}.zip`}
                    aria-label={`Скачать архив ${r.projectId}`}
                    download
                  >
                    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden>
                      <path
                        d="M6 1v7M2.8 5.2L6 8.4l3.2-3.2M1.5 10.5h9"
                        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
                      />
                    </svg>
                  </a>
                  <a
                    className="project-ico"
                    href={api.promptUrl(r.projectId)}
                    title={`Скачать промпт — prompt_${r.projectId}.md`}
                    aria-label={`Скачать промпт ${r.projectId}`}
                    download
                  >
                    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden>
                      <path
                        d="M2.2 1.5h5.3L10 4v6.5H2.2zM7.3 1.7V4.2H9.8M3.8 6.5h4.4M3.8 8.3h3"
                        fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                      />
                    </svg>
                  </a>
                </>
              )}

              {/* корзина рядом со скачиванием: «не подошёл» — это штатный итог,
                  и убирать такой проект должно быть отсюда, а не из файлового
                  менеджера. Модальное подтверждение обязательно: список в
                  сайдбаре узкий, промах по строке стоит целой сборки */}
              <button
                type="button"
                className="project-ico project-del"
                aria-label={`Удалить ${r.projectId}`}
                title="Удалить проект из генератора"
                disabled={r.live}
                onClick={() => {
                  setErr(null);
                  setAsk(r);
                }}
              >
                <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden>
                  <path
                    d="M2.4 3.2h7.2M4.9 3.2V1.9h2.2v1.3M3.4 3.2l.5 7h4.2l.5-7M5.2 5v3.6M6.8 5v3.6"
                    fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                  />
                </svg>
              </button>
              </span>
            </div>
          ))}

        </div>
      )}

      {/* Миниатюра по наведению: «что я сгенерил два дня назад» без новой
          вкладки. Картинка — снимок съёмки (r<N>-1280.png), он уже лежит на
          диске после judge, отдельный рендер не нужен. Портал в body — по той
          же причине, что и модалка: sticky-сайдбар создаёт stacking context и
          обрезал бы попоп. Справа от строки: слева панель упёрта в край экрана */}
      {peek &&
        createPortal(
          <div
            className="project-peek"
            role="presentation"
            style={{
              left: Math.min(peek.x + 10, window.innerWidth - 268),
              top: Math.min(peek.y - 10, window.innerHeight - 230),
            }}
          >
            <img src={peek.url} alt="" width={256} height={180} />
            <span className="project-peek-cap mono">{peek.projectId}</span>
          </div>,
          document.body,
        )}

      {/* Модалка — портал в body. Панель живёт в сайдбаре с position: sticky,
          а sticky создаёт stacking context: какой бы z-index ни поставили,
          карточка оставалась ПОД .brief (z-index: 1) соседней колонки и была
          видна лишь наполовину — подтверждение, которое не видно, хуже его отсутствия */}
      {createPortal(
        ask && (
          <div
            className="modal-scrim"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget && !busy) setAsk(null);
            }}
          >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="del-title">
            <h3 id="del-title">Удалить {ask.projectId}?</h3>
            <p className="modal-body">
              Проект собран под {new Date().getFullYear()}: папка прогона
              {ask.inLibrary
                ? " уйдёт целиком, а снимок (zip + промпт) останется в библиотеке — его можно скачать и отдать заказчику."
                : " уйдёт целиком, а снимка в библиотеке нет: после удаления вернуть сайт будет не из чего."}
            </p>
            <ul className="modal-facts">
              <li>{ask.hasPreview ? "сборка есть — её открывали как превью" : "сборки в папке нет"}</li>
              <li>{ask.inLibrary ? "в библиотеке: zip и промпт останутся" : "в библиотеке ничего нет"}</li>
              <li>токены на перегенерацию потратятся заново</li>
            </ul>
            {ask.live && <p className="modal-warn">прогон ещё идёт — он будет остановлен</p>}
            {err && <p className="modal-err">{err}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="linkbtn"
                disabled={busy}
                autoFocus
                title="Esc"
                onClick={() => setAsk(null)}
              >
                Отмена
              </button>
              {ask.inLibrary && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  title="стереть и рабочую папку, и снимок в библиотеке"
                  onClick={() => void remove(true)}
                >
                  Удалить совсем
                </button>
              )}
              <button
                type="button"
                className="btn primary sm danger"
                disabled={busy}
                onClick={() => void remove(false)}
              >
                {busy ? "Удаляю…" : "Удалить"}
              </button>
            </div>
          </div>
          </div>
        ),
        document.body,
      )}
    </div>
  );

  async function remove(full: boolean) {
    if (!ask || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteProject(ask.projectId, full);
      setAsk(null);
      load();
    } catch (e) {
      // модалку не закрываем: человек видит причину и может повторить или
      // выбрать «Удалить совсем»
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
}

/** Куда ведёт подпись: карточку ревью открывает BriefForm (владелец этого
 *  экрана), панели остаётся послать событие — компоненты соседи, а поднимать
 *  состояние ревью через весь App ради одной ссылки дороже, чем событие. */
function openReview(projectId: string) {
  window.dispatchEvent(new CustomEvent("builder:review", { detail: { projectId } }));
}

/** Чем подпись является, а не только как называется. */
const TOOLTIP: Record<string, string> = {
  review:
    "сайт собран и проверен, но вы его ещё не приняли: откройте карточку — там вердикт, правки и кнопки выгрузки (клик по подписи)",
  needs_human:
    "прогон дошёл до конца, но судья оставил критичный дефект: автофиксы их уже не берут. Откройте карточку — там список и кнопки «Допилить» / «Догенерить картинки» / «Выгрузить как есть» (клик по подписи)",
  cancelled: "прогон остановлен кнопкой «Отмена» — сайт не собран, забирать нечего",
  draft: "бриф заполнен, прогон не запускался",
  failed: "прогон упал с ошибкой",
};

type Row = {
  projectId: string;
  mode: string;
  status: string;
  hasPreview: boolean;
  hasExport: boolean;
  live: boolean;
  inLibrary?: boolean;
  /** снимок съёмки для миниатюры по наведению; null — съёмки ещё не было */
  thumb?: string | null;
};

function map(r: Row) {
  const busy = r.live || ["running", "planning", "awaiting-gate", "needs_human"].includes(r.status);
  const ready = r.hasExport || (r.hasPreview && !busy);
  return {
    ...r,
    ready,
    inLibrary: Boolean(r.inLibrary),
    previewUrl: r.hasPreview ? `/projects/${r.projectId}/dist/index.html` : "",
    // подпись-кнопка нужна там, где карточка ревью реально что-то предлагает
    reviewable: (r.status === "review" || r.status === "needs_human") && r.hasPreview,
    // цвет = что подпись просит: «нужны действия» — ОРАНЖЕВЫЙ (разбирайся,
    // но не авария), «отменён»/«сбой» — КРАСНЫЙ (сборки нет, забирать нечего),
    // зелёный остаётся только состояниям «готово». needs_human был красным и
    // читался как падение, хотя сайт собран и ждёт правок
    tone: r.live
      ? "live"
      : r.status === "failed" || r.status === "cancelled"
        ? "bad"
        : r.status === "needs_human"
          ? "act"
          : busy
            ? "busy"
            : "done",
    // подпись есть только там, где она что-то меняет: идёт работа, ждём юзера
    // или сбой; у готового проекта (с замечанием или без) — чистая строка
    label: r.live && r.status !== "review"
      ? "идёт…"
      : r.status === "review"
        ? "Просмотреть"
        : r.status === "running"
          ? "сборка…"
          : r.status === "planning"
            ? "план…"
            : r.status === "awaiting-gate"
              ? "ждёт план"
              : r.status === "failed"
                ? "сбой"
                : r.status === "needs_human"
                  ? "Нужны действия"
                  : r.status === "cancelled"
                    ? "отменён"
                    : r.status === "draft"
                      ? "черновик"
                      : "",
  };
}
