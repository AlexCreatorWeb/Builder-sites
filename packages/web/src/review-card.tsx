import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "@builder/shared";
import { api } from "./api";
import type { DestInfo } from "./api";

/**
 * Ревью собранного сайта — между «сборка готова» и «выгружено».
 *
 * Смысл карточки: не выгружать вслепую. Сайт открывается на локальном сервере
 * генератора (не file:// — тот же корень, что у реального хостинга), человек
 * смотрит и либо просит модель допилить правку, либо выгружает, либо принимает
 * без выгрузки. Правка — не перегенерация: патч в overrides.* + пересборка +
 * съёмка, токенов на тексты/картинки не уходит.
 */
export default function ReviewCard({
  projectId,
  mode,
  shipRef,
  destOpts,
  chosenPath,
  onOpenPicker,
  onLog,
  onFinished,
}: {
  projectId: string;
  /** режим нужен ради формата индексов: php — болячка только белых серий на WAMP */
  mode: Mode;
  /** пилюли выгрузки из брифа (тот же список, что под кнопкой генерации) */
  destOpts: DestInfo[];
  /** цель, набранная руками в брифе: её нет в пилюлях, но выгрузить в неё можно */
  chosenPath?: string;
  /** открыть обозреватель папок (общий с брифом) */
  onOpenPicker?: () => void;
  onLog: (text: string, tone: "ok" | "bad" | "info") => void;
  /** прогон ушёл в done (после выгрузки/accept) — UI сворачивает ревью */
  onFinished?: () => void;
  /**
   * Родитель (липкая панель) дёргает ЭТУ ЖЕ выгрузку с целью по умолчанию:
   * главный CTA финала живёт в панели, а логика live/offline — одна на карточку,
   * вторая копия разъехалась бы при первой же правке
   */
  shipRef?: { current: (() => void) | null };
}) {
  const [site, setSite] = useState<Awaited<ReturnType<typeof api.site>> | null>(null);
  /** строка выгрузки: при входе в ревью она единственное действие, и под сгибом
      её не видели (замер: top 887–925 при vh 900) — крутим к центру */
  const footRef = useRef<HTMLDivElement | null>(null);
  const [comment, setComment] = useState("");
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  /** формат индексов меняется на месте: кнопка не должна поймать двойной клик */
  const [formatting, setFormatting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** сервер сообщает о фоновом этапе (правка/картинки) — после F5 локальные
      fixing/busy пусты, но работа идёт: включаем опрос и блокировки по postOp */
  useEffect(() => {
    if (!site?.postOp) return;
    if (site.postOp.kind === "fix") setFixing(true);
    else setBusy(true);
  }, [site?.postOp]);
  /**
   * Прогон жив (оркестратор в памяти, status пришёл с сервера) → команды идут
   * ему; прогона нет (сервер перезапускали, пока сайт ждал просмотра) → те же
   * действия дисковыми роутами.
   */
  const live = Boolean(site?.status);

  const reload = useCallback(() => {
    api
      .site(projectId)
      .then(setSite)
      .catch(() => setSite(null));
  }, [projectId]);

  useEffect(reload, [reload]);

  // live-прогон ушёл из review (accept/deliver) — сворачиваем карточку сами:
  // SSE мог быть уже закрыт, а состояние пришло на диск
  useEffect(() => {
    if (site?.status === "done") onFinished?.();
  }, [site?.status, onFinished]);

  /** POST принят сервером (работа зарегистрирована) — с этого момента
      «этапа нет» означает «работа кончилась», а не «ещё не началась» */
  const opPostedRef = useRef(false);

  // пока модель допиливает, прогон в «running»: опрос раз в 2 с до возвращения
  // в review (тогда же перечитываем проверки и stamp выгрузки).
  // Офлайн-правка и догенерение картинок теперь ФОНОВЫЕ: POST отвечает сразу,
  // поэтому тот же опрос крутит site.postOp (этап), а финалом считает
  // site.postResult — раньше карточка молчала минуту закрытого POST и юзер
  // считал генератор уснувшим, а «правка применена» приходила вслепую
  useEffect(() => {
    if (!fixing && !busy) return;
    const t = setInterval(async () => {
      try {
        const s = await api.site(projectId);
        setSite(s);
        if (live) {
          if (s.status !== "running") {
            setFixing(false);
            setBusy(false);
          }
          return;
        }
        if (!s.postOp) {
          if (s.postResult) {
            // финал с цифрами от самой пересъёмки, а не «модель сказала done»
            if (s.postResult.ok) setNote(s.postResult.note);
            else setErr(s.postResult.note);
            onLog(s.postResult.note, s.postResult.ok ? "ok" : "bad");
          } else if (opPostedRef.current) {
            // POST зарегистрировал работу, а через пару тиков её нет ни в этапах,
            // ни в результатах → сервер перезапустился посреди правки
            setErr("операция пропала — похоже, сервер перезапустился; проверьте превью");
          }
          setFixing(false);
          setBusy(false);
        }
      } catch {
        /* сайт недоступен на долю секунды при перезапуске — следующий тик */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [fixing, busy, live, projectId, onLog]);

  async function fix() {
    const text = comment.trim();
    if (!text || fixing) return;
    setFixing(true);
    setErr(null);
    setNote(null);
    onLog(`правка: ${text.slice(0, 70)}`, "info");
    try {
      if (live) {
        await api.command(projectId, "human-fix", text);
        // поле освобождаем сразу: список ушёл модели, следующая партия правок
        // пишется заново (раньше текст висел и провоцировал повторный клик)
        setComment("");
      }
      else {
        // ответ приходит сразу («взято в работу»); финал — из postResult в опросе
        opPostedRef.current = false;
        const r = await api.humanFixOffline(projectId, text);
        opPostedRef.current = r.started;
        setComment("");
        reload();
      }
    } catch (e) {
      setFixing(false);
      setErr((e as Error).message);
      onLog(`правка не применена: ${(e as Error).message}`, "bad");
    }
  }

  // доступ для липкой панели: та же deliver() с целью по умолчанию
  useEffect(() => {
    if (!shipRef) return;
    shipRef.current = () => void deliver();
    return () => {
      shipRef.current = null;
    };
  });

  // вход в review: строка выгрузки по центру. Первый заход — сразу, второй —
  // когда доехал /site: карточка раздувается вердиктом и проверки сдвигают
  // футер за сгиб, если крутить только по монтажу
  useEffect(() => {
    footRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [projectId]);
  const hadSite = useRef(false);
  useEffect(() => {
    if (!site) return;
    const first = !hadSite.current;
    hadSite.current = true;
    if (first) footRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [site]);

  async function deliver(target?: { path?: string; desktop?: boolean }) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (live) {
        const r = await api.command(projectId, "deliver", target?.desktop ? "desktop" : target?.path);
        if (!r.ok) throw new Error("прогон не принимает команду");
      } else {
        const r = await api.place(projectId, target);
        if (!r.placed && !r.noop) throw new Error("выгрузка не удалась");
        // deliver = выгрузить и завершить: состояние тоже переводим на диске
        await api.acceptOffline(projectId).catch(() => {});
        if (r.placed) onLog(`выложено: ${r.placed.dir}${r.placed.zip ? " + zip" : ""}`, "ok");
        else onLog("выгрузка не нужна: проект остаётся в генераторе", "info");
        onFinished?.();
      }
    } catch (e) {
      setErr((e as Error).message);
      onLog(`выгрузка: ${(e as Error).message}`, "bad");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Формат индексов у готового экспорта. Конвертирует export/ на месте
   * (без перегенерации) и правит brief.php, чтобы следующая пересборка —
   * правка или догенерение картинок — не откатила выбор.
   */
  async function pickFormat(to: "php" | "html") {
    if (formatting || busy) return;
    if ((site?.format ?? "html") === to) return;
    setFormatting(true);
    setErr(null);
    try {
      const r = await api.setFormat(projectId, to);
      onLog(
        r.changed
          ? `формат: index.${r.format} (${r.changed} стр.)`
          : `формат: index.${r.format} (уже так)`,
        "ok",
      );
      reload();
    } catch (e) {
      setErr((e as Error).message);
      onLog(`формат: ${(e as Error).message}`, "bad");
    } finally {
      setFormatting(false);
    }
  }

  async function accept() {
    if (busy) return;
    setBusy(true);
    try {
      if (live) await api.command(projectId, "accept");
      else await api.acceptOffline(projectId);
      onFinished?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const c = site?.checks ?? null;
  const problems = c
    ? [
        c.console ? `console: ${c.console}` : "",
        c.overflow ? `переполнение: ${c.overflow}` : "",
        c.brokenImgs ? `битых картинок: ${c.brokenImgs}` : "",
        c.brokenHrefs ? `битых ссылок: ${c.brokenHrefs}` : "",
        c.lowContrast ? `низкий контраст: ${c.lowContrast}` : "",
      ].filter(Boolean)
    : [];
  /**
   * dev-only: ?pending=N показывает баннер «картинок-заглушек: N» на обычной
   * сборке — иначе этот случай (провайдер картинок лёг посреди прогона) виден
   * только после настоящей аварии (тот же приём, что ?review / ?gate).
   */
  const devPending = import.meta.env.DEV
    ? Number(new URLSearchParams(location.search).get("pending") ?? 0)
    : 0;
  const pending = (site?.imagesPending ?? 0) || devPending;
  /** последний раунд правок: «сколько заказано / сколько сделано» по пунктам */
  const lastFix = site?.lastFix ?? null;
  /**
   * Правка считается ПОДТВЕРЖДЁННОЙ только если её раунд и есть текущая
   * сборка: builtAt отчёта == builtAt диска. Иначе плашка — история (после неё
   * был откат/догенерение/ещё одна правка) и зелёным светиться не должна.
   */
  const fixFresh = Boolean(lastFix?.builtAt && site?.builtAt && lastFix.builtAt === site.builtAt);
  /**
   * Вердикт и машинные проверки относятся к ТОЙ съёмке, что лежит на диске:
   * human-fix пересобирает dist, но судом не переснимает. Без подписи «снимок
   * от …» вчерашний «критичных 1» выглядел нынешним — та же ложь временем,
   * что и зелёная плашка правок без даты.
   */
  const hhmm = (ms?: number) =>
    ms
      ? new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "?";
  const staleAt = (ms?: number) => Boolean(ms && site?.builtAt && site.builtAt > ms + 1000);
  /**
   * Сколько пунктов юзер написал прямо сейчас. Разделители те же, что разбирает
   * сервер (splitEdits), — счётчик над полем честный: «внесу все 3», а не «одно
   * и остановлюсь», как было, пока промпт держал формулировку «чинишь один дефект».
   */
  const pendingItems = comment
    .split(/\r?\n|;|•|\s[-–—]\s+(?=\S)|\d+[).]\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1).length;

  /** откат последнего раунда правки: сервер срезает последний блок из
      overrides.css/html и пересобирает — фон, как у самой правки */
  async function undoFix() {
    if (busy || fixing) return;
    setBusy(true);
    setErr(null);
    try {
      opPostedRef.current = false;
      const r = await api.undoFix(projectId);
      opPostedRef.current = r.started;
      reload();
    } catch (e) {
      setBusy(false);
      setErr((e as Error).message);
      onLog(`откат: ${(e as Error).message}`, "bad");
    }
  }

  /** догенерить заглушки: графика + пересборка, без токенов на тексты/вёрстку.
      Тоже фон: ответ «взято», этап и финал — из postOp/postResult */
  async function regenImages() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      opPostedRef.current = false;
      const r = await api.regenImages(projectId);
      opPostedRef.current = r.started;
      reload();
    } catch (e) {
      setBusy(false);
      setErr((e as Error).message);
      onLog(`картинки: ${(e as Error).message}`, "bad");
    }
  }
  const here = destOpts.find((o) => o.kind === "here");

  return (
    <div className="review-card">
      <div className="review-head">
        <b>Сайт собран — посмотрите перед выгрузкой</b>
        <a
          className="btn ghost sm"
          href={`${site?.url || `/projects/${projectId}/dist/index.html`}?v=${site?.builtAt ?? 0}`}
          target="_blank"
          rel="noreferrer"
          title="открыть в новой вкладке: страница сама перезагрузится, когда сборка изменится"
        >
          ▶ Смотреть
        </a>
      </div>

      <p className="review-sub">
        {problems.length ? (
          <>машинные проверки: {problems.join(" · ")}</>
        ) : c ? (
          <>машинные проверки чистые</>
        ) : (
          <>проверок нет — смотрите глазами</>
        )}
        {/* строки карточки обязаны отвечать действительности: проверки сняты
            со СТАРОЙ сборки, после правок они не переснимаются */}
        {c ? <span className="rs-at"> · снимок {hhmm(site?.checksAt)}{staleAt(site?.checksAt) ? " · сборка новее" : ""}</span> : null}
        {/* смета не только «до», но и «после»: юзер сверяет обещанное с фактом
            и понимает, что правка ниже — минуты, а не новый прогон */}
        {site?.estimate?.minutes ? <> · машине ≈{site.estimate.minutes} мин</> : null}
        {/* «вердикт судьи: критичных 1» рядом с «проверки чистые» читалось как
            противоречие: это разные проверки. Теперь названы обе, а список
            дефектов раскрыт ДО решения «Выгрузить» */}
        {site?.verdict
          ? ` · vision-судья: ${site.verdict.critical === 0 ? "критичных нет" : `критичных ${site.verdict.critical}`}`
          : ""}
        {site?.verdict ? (
          <span className="rs-at">
            {" · съёмка суда "}
            {hhmm(site.verdictAt)}
            {staleAt(site.verdictAt) ? " · НЕ переснималась после правок" : ""}
          </span>
        ) : null}
      </p>

      {site?.verdict && site.verdict.defects.length > 0 && (
        <details className="review-defects" open={site.verdict.critical > 0}>
          <summary>
            замечания судьи: {site.verdict.defects.length}
            {site.verdict.critical > 0 ? ` · критичных ${site.verdict.critical}` : ""}
          </summary>
          {site.verdict.summary && <p className="review-verdict-sum">{site.verdict.summary}</p>}
          <ul>
            {site.verdict.defects.map((df, i) => (
              <li key={i} className={`sev-${df.severity}`}>
                <span className="sev mono">{df.severity}</span>
                {df.message}
                {df.selector ? <code className="mono"> {df.selector}</code> : null}
                {/* заказ модели рождается ЗДЕСЬ: клик по замечанию кладёт его
                    коротким текстом в поле правки — вкладка остаётся пультом,
                    а не лентой чужих отчётов (текст правится перед отправкой) */}
                <button
                  type="button"
                  className="linkbtn d-fix"
                  disabled={fixing}
                  title="подставить коротким заказом в поле правки — можно поправить и отправить"
                  onClick={() => {
                    setComment(toOrder(df));
                    document.querySelector<HTMLTextAreaElement>(".review-fix textarea")?.focus();
                  }}
                >
                  → в правку
                </button>
              </li>
            ))}
          </ul>
          <p className="review-hint">
            {site.verdict.critical > 0
              ? "критичное правится кнопкой «Допилить» — выгружать можно и так, но это видно на сайте"
              : "выгружать можно: критичного нет"}
          </p>
        </details>
      )}

      {site?.placed?.stale && (
        <p className="review-stale">
          на столе лежит копия от {new Date(site.placed.at).toLocaleString("ru-RU")} — сборка
          менялась позже, выгрузите заново
        </p>
      )}
      {site?.placed && !site.placed.stale && (
        <p className="review-placed mono">выложено: {site.placed.dir}</p>
      )}
      {pending > 0 && (
        <p className="review-stale">
          картинок-заглушек: {pending} — вместо них нет сгенерированных фото (провайдер
          не ответил). <button type="button" className="linkbtn" disabled={busy} onClick={() => void regenImages()}>Догенерить картинки</button> —
          пересоберёт сайт, тексты и вёрстка не перезаписываются
        </p>
      )}
      {/* Итог правок человека по пунктам. Раньше карточка показывала только
          последнюю строку «патч применён», и из трёх заказанных правок было
          непонятно, сделали ли все. Теперь сервер считает `done` по каждому
          пункту и кладёт отчёт в проект — он виден и после перезапуска сервера */}
      {lastFix && (
        <div
          className={`review-fixes${
            !fixFresh
              ? " hist"
              : lastFix.changed === false
                ? " regress"
                : lastFix.applied === lastFix.requested
                  ? lastFix.checks && lastFix.checks.after > lastFix.checks.before
                    ? " regress"
                    : " all"
                  : ""
          }`}
        >
          {/* Плашка обязана различать РЕЗУЛЬТАТ и ИСТОРИЮ. Пока у раунда не было
              штампа сборки, вчерашний «правки: 1 из 1» горел зелёным как статус
              свежего действия («зачем вылезла плашка, если ничего не применили»).
              now: builtAt отчёта == builtAt диска → это текущий кадр превью */}
          <b>
            {fixFresh ? "правка применена" : "правок в истории"}: {lastFix.applied} из{" "}
            {lastFix.requested}
            <span className="rf-at">
              {" · "}
              {new Date(lastFix.at).toLocaleString("ru-RU", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </b>
          {/* Заметка модели по ОДНОМУ пункту: без неё правка «применена», а что
              именно сделано — непонятно, и юзер не мог сверить с кадром */}
          {lastFix.requested === 1 && lastFix.items[0]?.note ? (
            <p className="rf-note">{lastFix.items[0].note}</p>
          ) : null}
          {fixFresh && lastFix.changed === false && (
            <p className="rf-regress">
              ⚠ собранный файл не изменился: в превью тот же вид, что и до правки.
              Обычно так бывает, когда просят то, что уже сделано, — уточните правку
              или отмените этот раунд:
              <button type="button" className="linkbtn" disabled={busy || fixing} onClick={() => void undoFix()}>
                отменить последнюю правку
              </button>
            </p>
          )}
          {/* «✓ все внесены» — про патч, а не про результат: съёмка после патча
              может насчитать ПОЛОМОК БОЛЬШЕ (модель звала картинки, которых нет).
              Без этой строки плашка «✓ все (1)» + «сломанного: 0 → 7» читалась
              как недостоверная дичь */}
          {lastFix.checks && lastFix.checks.after > lastFix.checks.before && (
            <p className="rf-regress">
              ⚠ после правки поломок больше: {lastFix.checks.before} → {lastFix.checks.after}. Можно
              отменить последний раунд и собрать прежний вид:
              <button type="button" className="linkbtn" disabled={busy || fixing} onClick={() => void undoFix()}>
                отменить последнюю правку
              </button>
            </p>
          )}
          {lastFix.requested > 1 && (
            <ul>
              {lastFix.items.map((it, i) => (
                <li key={i} className={it.done ? "ok" : "bad"}>
                  <span className="mk">{it.done ? "✓" : "✕"}</span> {it.text}
                  {!it.done && it.note ? <span className="why"> — {it.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {note && <p className="review-note">{note}</p>}
      {err && <p className="review-err">{err}</p>}
      {(fixing || busy) &&
        (site?.postOp ? (
          <StageLine stage={site.postOp.stage} startedAt={site.postOp.startedAt} />
        ) : live ? (
          <p className="review-progress"><i aria-hidden /> работает…</p>
        ) : null)}

      <div className="review-fix">
        <textarea
          value={comment}
          rows={2}
          maxLength={600}
          disabled={fixing}
          placeholder="что поправить — своими словами: «заголовок крупнее», «телефон в шапку», «форму ниже»"
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void fix();
          }}
        />
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => void fix()}
          disabled={!comment.trim() || fixing || busy}
          title="модель применяет все перечисленные пункты за один заход и пересобирает сайт — картинки и тексты не перегенерируются"
        >
          {fixing ? `Допиливаю${pendingItems > 1 ? ` ${pendingItems}` : ""}…` : "Допилить всё"}
        </button>
      </div>
      {/* счётчик над полем: юзер видит, что список будет применён ВЕСЬ, а не
          первым пунктом — ровно то, на что жаловался аудит */}
      {!fixing && pendingItems > 1 && (
        <p className="review-hint">
          правок в списке: {pendingItems} — все будут применены одним заходом
          (перевод строки или «;» = новый пункт)
        </p>
      )}
      {fixing && (
        <p className="review-hint">
          правлю сборку{pendingItems > 1 ? ` — все ${pendingItems} пунктов` : ""} (~20–60 с), сайт в это время прежний
        </p>
      )}

      <div className="review-foot" ref={footRef}>
        {/* Формат индексов — здесь, а не в брифе: он нужен серверу, куда несут
            сайт (WAMP/OpenServer просят *.php, статический хостинг — .html),
            и решать его нужно глядя на собранный сайт, перед выгрузкой */}
        {mode === "white" && site?.exportReady && (
          <div className="fmt" role="group" aria-label="Формат файлов index">
            {(["html", "php"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={(site.format ?? "html") === f ? "on" : ""}
                aria-pressed={(site.format ?? "html") === f}
                disabled={busy || fixing || formatting}
                title={
                  f === "php"
                    ? "index.php — для серверов, которые отдают только *.php (WAMP, OpenServer, серия whites)"
                    : "index.html — чистый HTML: хостинг, GitHub Pages, любой статический сервер"
                }
                onClick={() => void pickFormat(f)}
              >
                index.{f}
              </button>
            ))}
          </div>
        )}
        {!here || here.kind !== "here" ? null : (
          <span className="hint">выгрузка: {here.label}</span>
        )}
        {/* ОДНА кнопка выгрузки: пользователь выбирает цель до генерации (пилюли
            в брифе), и здесь повторять её трижды пилюлями + «в папку…» —
            плодить декорации. Правило юзера: кнопка либо работает, либо её нет.
            Целевая папка — та же, что у шлюзовой кнопки панели (deliver()) */}
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy || fixing}
          title={
            chosenPath
              ? `выгрузить в ${chosenPath}` : "выгрузить в папку, выбранную в брифе"
          }
          onClick={() => void deliver(chosenPath ? { path: chosenPath } : undefined)}
        >
          ⤓ Выгрузить
        </button>
        <button
          type="button"
          className="linkbtn"
          disabled={busy || fixing}
          onClick={() => void accept()}
          title="снять в библиотеку готовых, ничего не копируя за пределы мастерской"
        >
          принять без выгрузки
        </button>
      </div>
    </div>
  );
}

/**
 * Строка этапа фоновой правки: что генератор делает прямо сейчас и сколько
 * это уже длится. Таймер тикает сам — без него «модель пишет патч» через
 * минуту выглядит так же, как через секунду, и юзер не отличает работу от
 * зависания (на это и был отзыв «не вижу прогресса, думаю что уснул»).
 */
/**
 * Замечание машины/судьи → короткий заказ модели. Строка вида
 * «картинка не загрузилась: assets/img/x.jpg» или «console: error: …» — это
 * отчёт, а не приказ: вставляешь её в поле как есть, и модель чинит бог знает
 * что. Здесь — короткая русская формулировка ровно по названному объекту.
 */
function toOrder(df: { message: string; selector?: string }): string {
  const msg = df.message.replace(/\s+/g, " ").trim();
  const img = /картинка не загрузилась:\s*(\S+)/i.exec(msg)?.[1];
  if (img) return `замени битую картинку ${img.split("/").pop()} на рабочую из assets/img/`;
  if (/ERR_FILE_NOT_FOUND|Failed to load resource/i.test(msg)) return "найди и почини битые ссылки на файлы";
  const href = /ссылка[^:]*:\s*(\S+)/i.exec(msg)?.[1];
  if (href) return `почини битую ссылку ${href}`;
  if (/переполнен|overflow/i.test(msg)) return `убери переполнение${df.selector ? ` у ${df.selector}` : ""}`;
  if (/пуст/i.test(msg)) return `убери пустой блок${df.selector ? ` (${df.selector})` : ""} или наполни его`;
  if (/контраст/i.test(msg)) return `подними контраст текста${df.selector ? ` у ${df.selector}` : ""}`;
  // свободный текст судьи: берём первое предложение — оно и есть заказ,
  // остальное модель прочтёт по карте страницы
  const first = msg.split(/[.?!]/)[0] ?? msg;
  return (first || msg).slice(0, 90);
}

function StageLine({ stage, startedAt }: { stage: string; startedAt: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  return (
    <p className="review-progress" role="status">
      <i aria-hidden />
      {stage}
      <span className="rp-time">{secs} с</span>
    </p>
  );
}
