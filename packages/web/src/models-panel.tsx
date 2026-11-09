/**
 * Панель моделей в сайдбаре (SPEC §4, §9): две секции — «Модель для кода» и
 * «Модель для картинок». В каждой:
 *  · одно окно на назначение: внутри — активное подключение (провайдер
 *    определён фактом подключения и подставлен в заголовок, лимит — тот,
 *    что ответил его API);
 *  · список моделей: ВИДНО ВСЕГДА НЕ БОЛЬШЕ ПЯТИ (остальное за бортом коробки,
 *    до него доскроллить), плюс поле поиска по всему списку — так модель из
 *    сотен OpenRouter находится за два движения. Никакой ручной правки id:
 *    список берётся с API того же подключения, что и ключ;
 *  · «+ модель» живёт внутри окна: вставил ключ другого провайдера — он
 *    определился, стал активным и подменился в заголовке. Никаких кнопок
 *    «править» и строк «другой провайдер» между окнами: замена происходит
 *    только здесь.
 * Ниже этих двух окон — ничего: будущее (озвучка, музыка) прикрутим позже.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type ConnectionsInfo, type DetectResult, type NetSample } from "./api";
import ModelHealth from "./model-health";
import { subscribeNet } from "./net-stream";

type Badge = ConnectionsInfo["badges"][number];
type Kind = "llm" | "image";

/** Сколько пилюль видно в окне без прокрутки: пять — и ни одной больше
 *  (дальше только скролл), иначе сайдбар с сотнями моделей раздувается. */
const VISIBLE_MODELS = 5;

/** Потолок выдачи поиска: «qwen» у OpenRouter находит десятки — все рисовать
 *  незачем, ищущий уточнит запрос. */
const PICKER_CAP = 24;

/** Сообщение окна. Ключ — какое окно его породило: замечание «415 моделей»,
 *  показанное в обоих окнах, читалось как «картинки тоже OpenRouter».
 *  `global` — ошибка самого списка подключений, она касается обоих. */
type Msg = { kind: Kind | "global"; tone: "err" | "ok"; text: string } | null;

/**
 * Фактический лимит: то, что ответил API провайдера, а не то, что выбрал юзер.
 * Мы не можем назначить провайдеру тариф — можем только прочесть его.
 */
function LimitFact({ badge }: { badge?: Badge }) {
  const state = badge?.state ?? "unknown";
  const text = badge?.display ?? "?";
  return (
    <span className={`limit-fact n-${state}`} title={text}>
      {text}
    </span>
  );
}

/**
 * Подсказка плашки: чем именно подключен этот провайдер — адрес, протокол,
 * ключ и что на него назначено.
 */
function connTip(
  c: ConnectionsInfo["connections"][number],
  sel: ConnectionsInfo["selection"],
  last?: string,
): string {
  const parts = [
    c.provider ?? c.name,
    c.baseUrl,
    `протокол: ${c.protocol ?? "openai-chat"}`,
    c.auth?.mode === "env" ? `ключ: ${c.auth.ref}` : c.auth ? "ключ локальный" : "ключ не настроен",
  ];
  if (sel?.codeCopy.connection === c.id)
    parts.push(`сейчас пишет код: ${sel.codeCopy.model ?? "первая модель списка"}`);
  if (sel?.image.connection === c.id) {
    const chosen = c.models.find((m) => m.id === sel.image.model);
    parts.push(
      `сейчас рисует: ${chosen?.label ?? sel.image.model ?? "дефолтная модель сервиса"}`,
    );
  }
  // исход последнего действия окна — в подсказке, а не серой строкой над окном
  if (last) parts.push(last);
  return parts.join("\n");
}

export default function ModelsPanel() {
  const [info, setInfo] = useState<ConnectionsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // сообщение принадлежит окну, а не панели (см. Msg)
  const [msg, setMsg] = useState<Msg>(null);
  // само исчезает: окно показало результат, дальше юзер работает со списком
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 9_000);
    return () => clearTimeout(t);
  }, [msg]);
  // в какую секцию сейчас вставляем ключ (null — форма закрыта)
  const [addKind, setAddKind] = useState<Kind | null>(null);
  // поиск по моделям внутри одной плашки: {connId, q} | null (закрыт)
  const [picker, setPicker] = useState<{ connId: string; q: string } | null>(null);
  // от юзера — один API-ключ; адрес всплывает только если ключ его не подсказал
  const [key, setKey] = useState("");
  const [address, setAddress] = useState("");
  const [askAddress, setAskAddress] = useState(false);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  // ручная правка списка больше не нужна: модели берутся с API того же
  // подключения, чей ключ вставлен (см. «+ модель»)
  // Снимок связи общий на страницу (net-stream): от него берут health-индикаторы
  const [netSample, setNetSample] = useState<NetSample | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.connections();
      setInfo(next);
      setMsg((m) => (m?.tone === "err" && m.kind === "global" ? null : m));
    } catch (e) {
      setMsg({ kind: "global", tone: "err", text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeNet(setNetSample), []);

  const sel = info?.selection;
  const badgeFor = (id: string) => info?.badges.find((b) => b.connectionId === id);
  const rowsOf = (kind: Kind) =>
    (info?.connections ?? []).filter((c) => c.enabled && c.kind === kind);

  const closeAdd = () => {
    setAddKind(null);
    setKey("");
    setAddress("");
    setAskAddress(false);
    setDetected(null);
  };

  /**
   * Подключение по ключу внутри секции. Первый шаг — спросить у API, что это
   * за провайдер; если ключ не подсказывает хост, вторым полем появляется
   * адрес. Ключ от другой категории (image-ключ в секцию кода) не принимаем:
   * это тот же «брак», что модель не своего назначения.
   */
  async function submit(kind: Kind) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const det = await api.detectConnection(key.trim(), address.trim() || undefined, kind);
      if (det.needAddress) {
        setAskAddress(true);
        setDetected(det);
        return;
      }
      // назначение определилось фактом, а не догадкой: отказываем только когда
      // kind пришёл из заведомо известного API (endpoint); «как есть» и
      // «список моделей» — не основание спорить с окном, куда вставили ключ
      if (det.kindSource === "endpoint" && det.kind && det.kind !== kind) {
        setMsg({
          kind,
          tone: "err",
          text:
            `этот ключ — от ${det.kind === "image" ? "картинок" : "кода"}, а не сюда. ` +
            "Вставь его в соответствующую секцию.",
        });
        return;
      }
      // тот же провайдер другим ключом = замена ключа, а не «подключение уже есть»
      const created = await api.addConnection(det.draft ?? {}, true);
      // окно работает на одно подключение: вставленный ключ сразу становится
      // рабочим — отсюда и провайдер в заголовке меняется сам
      if (created.id) {
        await api.setSelection(
          kind === "llm"
            ? { codeCopy: { connection: created.id, model: null } }
            : { image: { connection: created.id, model: null } },
        );
      }
      setMsg({
        kind,
        tone: "ok",
        text: `${det.provider}: ${created.models ?? 0} моделей · ${det.quota?.display ?? "лимит неизвестен"}`,
      });
      closeAdd();
      await refresh();
    } catch (e) {
      setMsg({ kind, tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function pull(id: string, kind: Kind) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.pullModels(id);
      setMsg({ kind, tone: "ok", text: `забрано моделей: ${r.count}` });
      await refresh();
    } catch (e) {
      setMsg({ kind, tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // у imagening список картинок отдаёт свой эндпоинт (id там UUID — руками их не вписывают)
  async function pullImages(id: string, kind: Kind) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.pullImageModels(id);
      setMsg({ kind, tone: "ok", text: `забрано моделей: ${r.count}` });
      await refresh();
    } catch (e) {
      setMsg({ kind, tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function pick(connId: string, modelId: string) {
    if (!sel) return;
    await api.setSelection({ codeCopy: { connection: connId, model: modelId } });
    setPicker(null);
    await refresh();
  }

  async function pickImage(connId: string, modelId: string | null) {
    if (!sel) return;
    await api.setSelection({ image: { connection: connId, model: modelId } });
    setPicker(null);
    await refresh();
  }

  /** Одно окно: здоровье, провайдер (заголовок), лимит, поиск + список моделей. */
  function renderConn(
    c: ConnectionsInfo["connections"][number],
    kind: Kind,
    addHint: string,
  ) {
    if (!sel) return null;
    const q = (picker?.connId === c.id ? picker.q : "").trim().toLowerCase();
    const chosen = (modelId: string | null | undefined) =>
      kind === "llm"
        ? sel.codeCopy.connection === c.id && (sel.codeCopy.model ?? c.models[0]?.id) === modelId
        : sel.image.connection === c.id && (sel.image.model ?? c.models[0]?.id) === modelId;
    // Баланс не даёт брать платные модели (OpenRouter при нуле: 402 на платные,
    // 200 на :free). Тогда краснеет не весь провайдер — а именно выбранная
    // платная модель: бесплатной пользоваться можно.
    const badge = badgeFor(c.id);
    const blocked = Boolean(badge?.paidBlocked);
    const isFree = (m: { id: string; label?: string }) => m.id.endsWith(":free");
    const activeModelId =
      kind === "llm" ? sel.codeCopy.model : sel.image.model;
    const activeModel = c.models.find((m) => m.id === activeModelId) ?? c.models[0];
    const modelBlocked = blocked && !!activeModel && !isFree(activeModel);
    // Рабочая модель — первой, дальше весь список. Наружу выходят только
    // первые VISIBLE_MODELS: остальное за бортом коробки, до него скролл.
    // При нулевом балансе бесплатные поднимаются над платными: список из
    // одних красных пилюль читается как «тут всё недоступно», хотя :free
    // работают — юзер бы и не догадался пролистывать.
    const rank = (m: { id: string; label?: string }) =>
      chosen(m.id) ? 0 : blocked && isFree(m) ? 1 : blocked && !isFree(m) ? 3 : 2;
    const activeFirst = [...c.models].sort((a, b) => rank(a) - rank(b));
    const freeCount = c.models.filter(isFree).length;
    const found = q
      ? activeFirst.filter((m) => `${m.id} ${m.label ?? ""}`.toLowerCase().includes(q))
      : activeFirst;
    const list = found.slice(0, PICKER_CAP);
    // возврат на «нашу» пару подключений: пилюля появляется, когда окно ушло
    // на другое подключение, и ведёт ровно туда, откуда ушли
    const def = info?.defaults?.[kind === "llm" ? "codeCopy" : "image"];
    const canReturn = !!def && def.connection !== c.id;
    return (
      <li key={c.id} className={kind === "llm" ? sel.codeCopy.connection === c.id ? "active" : "" : sel.image.connection === c.id ? "active" : ""}>
        {/* здоровье провайдера — над названием: сначала оно, потом модель.
            Красным становится ТОЛЬКО когда выбранная модель реально недоступна
            (платная при нулевом балансе); провайдер живой, бесплатные работают */}
        <ModelHealth id={c.id} sample={netSample} blocked={modelBlocked} />
        <div className="models-row">
          {/* заголовок = автоматически определённый провайдер: ни редактировать,
              ни выбирать текстом юзеру не нужно */}
          <span
            className="models-name"
            title={connTip(
              c,
              sel,
              msg?.kind === kind && msg.tone === "ok" ? msg.text : undefined,
            )}
          >
            {c.provider || c.name}
          </span>
        </div>
        <LimitFact badge={badgeFor(c.id)} />
        {/* Подсказка о бесплатных: клик оставляет в списке только их */}
        {blocked && (
          <button
            className="models-hint"
            title={freeCount > 0 ? "показать в списке только бесплатные модели" : ""}
            onClick={() => setPicker({ connId: c.id, q: ":free" })}
          >
            {freeCount > 0
              ? `бесплатных: ${freeCount} — показать`
              : "бесплатных нет — нужен баланс"}
          </button>
        )}
        {/* Поиск — часть окна, а не отдельный режим:モデル из сотен ищутся,
            не прокликивая страницы. */}
        {c.models.length > VISIBLE_MODELS && (
          <input
            className="models-filter"
            placeholder={`поиск среди ${c.models.length}: claude, gpt, qwen…`}
            aria-label={`Поиск модели: ${c.provider || c.name}`}
            value={picker?.connId === c.id ? picker.q : ""}
            onFocus={() => setPicker({ connId: c.id, q: picker?.connId === c.id ? picker.q : "" })}
            onChange={(e) => setPicker({ connId: c.id, q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPicker(null);
            }}
          />
        )}
        {c.models.length > 0 && (
          <div className="models-scroll">
            {list.map((m) => (
              <span key={m.id} className="models-pill">
                <button
                  className={`${chosen(m.id) ? "on" : ""} ${blocked && !isFree(m) ? "blocked" : ""}`}
                  title={
                    (kind === "llm"
                      ? chosen(m.id)
                        ? "назначена на роли code/copy"
                        : "назначить на роли code/copy"
                      : chosen(m.id)
                        ? "назначена на генерацию картинок"
                        : "назначить для картинок") +
                    (blocked && !isFree(m)
                      ? " · платная: баланс $0, провайдер ответит отказом (выбери :free)"
                      : isFree(m)
                        ? " · бесплатная: работает без баланса"
                        : "")
                  }
                  onClick={() => void (kind === "llm" ? pick(c.id, m.id) : pickImage(c.id, m.id))}
                >
                  {m.label || m.id}
                </button>
              </span>
            ))}
            {list.length === 0 && <span className="more">ничего не найдено</span>}
            {found.length >= PICKER_CAP && (
              <span className="more" title="совпадений больше — уточни запрос">
                уточни запрос
              </span>
            )}
          </div>
        )}
        {c.models.length === 0 && (
          <button
            className="models-pull"
            title="Спросить список моделей у API этого подключения и записать его"
            onClick={() => void (c.kind === "llm" ? pull(c.id, kind) : pullImages(c.id, kind))}
          >
            взять модели с API
          </button>
        )}
        {/* Действие окна — одно: «+ модель». Ключ другого провайдера определится,
            станет активным и подменится в заголовке; возврат на «нашу» пару —
            соседней пилюлей, чтобы не вставлять прежний ключ заново */}
        {addKind !== kind && (
          <div className="models-tools">
            <button className="models-pull" title={addHint} onClick={() => setAddKind(kind)}>
              + модель
            </button>
            {canReturn && def && (
              <button
                className="models-pull"
                title={`вернуть наши модели: ${def.connection}${def.model ? ` · ${def.model}` : ""}`}
                onClick={() =>
                  void (kind === "llm"
                    ? api.setSelection({ codeCopy: { connection: def.connection, model: def.model } })
                    : api.setSelection({ image: { connection: def.connection, model: def.model } })
                  ).then(refresh)
                }
              >
                default
              </button>
            )}
          </div>
        )}
        {renderAddForm(kind)}
      </li>
    );
  }

  /** Форма «+ модель» секции: один ключ, всё остальное определится само. */
  function renderAddForm(kind: Kind) {
    if (addKind !== kind) return null;
    return (
      <div className="models-form">
        <input
          type="password"
          autoFocus
          placeholder="вставь API-ключ"
          title="Ключ попадёт в .env этого компа; провайдер, адрес, модели и лимит определятся сами"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !askAddress) void submit(kind);
          }}
        />
        {askAddress && (
          <input
            autoFocus
            placeholder="https://адрес-API/v1"
            title="Ключ не подсказал хост — впиши адрес API этого ключа"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit(kind);
            }}
          />
        )}
        {detected?.hint && <p className="models-note">{detected.hint}</p>}
        <div className="models-form-actions">
          <button
            className="btn primary"
            title="Спросить у API, что это за провайдер, и сразу показать лимит"
            onClick={() => void submit(kind)}
            disabled={busy || !key.trim()}
          >
            {busy ? "проверяю…" : askAddress ? "Подключить" : "Определить"}
          </button>
          <button className="linkbtn" onClick={closeAdd}>
            отмена
          </button>
        </div>
      </div>
    );
  }

  /** Пустое окно (ключей ещё нет): тот же каркас, что и рабочее, но с
   *  абстрактными подписями — юзер видит, ЧТО сюда попадёт, а не голую
   *  строчку «подключений нет». */
  function renderEmpty(kind: Kind, addHint: string) {
    const ghosts =
      kind === "llm"
        ? ["твоя текстовая модель", "резервная модель", "остальные — после ключа"]
        : ["твоя модель картинок", "резервная модель", "остальные — после ключа"];
    return (
      <ul className="models-list">
        <li className="ghost">
          <span className="mh n-unknown" title="проверка появится, когда вставишь ключ">
            <span className="mh-ticks" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <i key={i} className="t-empty" />
              ))}
            </span>
            <span className="mh-text">не подключено</span>
          </span>
          <div className="models-row">
            <span className="models-name">
              {kind === "llm" ? "Текстовая модель" : "Модель для картинок"}
            </span>
          </div>
          <span className="limit-fact">вставь API-ключ — провайдер определится сам</span>
          <div className="models-scroll">
            {ghosts.map((g) => (
              <span key={g} className="models-pill">
                <button className="ghost" disabled title="появится здесь, как только вставишь ключ">
                  {g}
                </button>
              </span>
            ))}
          </div>
          <button className="models-pull" title={addHint} onClick={() => setAddKind(kind)}>
            + модель
          </button>
          {renderAddForm(kind)}
        </li>
      </ul>
    );
  }

  function renderSection(kind: Kind, title: string, hint: string) {
    const rows = rowsOf(kind);
    // Одно окно = активное подключение назначения. Другой провайдер — не новое
    // окно и не строка под окном, а замена внутри этого же окна («+ модель»).
    const activeId = kind === "llm" ? sel?.codeCopy.connection : sel?.image.connection;
    const active = rows.find((c) => c.id === activeId) ?? rows[0];
    return (
      <div className="models-role">
        <div className="models-role-head">
          <span>{title}</span>
        </div>
        {/* над окном живёт только ошибка: «успех» (415 моделей · лимит) юзер
            видит в подсказке на названии провайдера, а не серой строкой */}
        {msg?.tone === "err" && (msg.kind === kind || msg.kind === "global") && (
          <p className="models-err">{msg.text}</p>
        )}
        {!active ? (
          renderEmpty(kind, hint)
        ) : (
          <ul className="models-list">{renderConn(active, kind, hint)}</ul>
        )}
      </div>
    );
  }

  return (
    <section className="models" aria-label="Модели и лимиты">
      {!info && !msg && <p className="models-note">проверка подключений…</p>}

      {renderSection(
        "llm",
        "Модель для кода",
        "Подключить ещё одну LLM: вставь ключ — провайдер, адрес, модели и лимит определятся сами",
      )}
      {renderSection(
        "image",
        "Модель для картинок",
        "Подключить ещё один генератор картинок: вставь ключ — всё остальное определится само",
      )}
    </section>
  );
}
