/**
 * Connections — ЕДИНСТВЕННОЕ место, где бывает сеть (SPEC §6).
 * Резолвит ключ, ставит заголовок, считает usage, ретраит транспорт,
 * дергает счётчик лимита. Протоколы спрятаны за «задачей со статусом».
 */
import fs from "node:fs";
import path from "node:path";
import type { Connection, LimitBadge } from "@builder/shared";
import { resolveKey, settings } from "../config.ts";
import { recordCall } from "../net/monitor.ts";
import type { ImageRequest, ModelRequest } from "../orchestrator/types.ts";

export class QuotaError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QuotaError";
  }
}

/** Ключа нет — это не поломка прогона, а «это подключение пропускаем». */
export class NoKeyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NoKeyError";
  }
}

export interface LlmAnswer {
  text: string;
  usage: { prompt: number; completion: number };
}

/** Выбор подключения под роль: селект из UI, иначе первое enabled нужного kind. */
export function connectionFor(
  kind: "llm" | "image",
  preferredId?: string,
): Connection | null {
  const s = settings();
  const pool = s.connections.filter((c) => c.kind === kind && c.enabled);
  if (preferredId) {
    const p = pool.find((c) => c.id === preferredId);
    if (p) return p;
  }
  pool.sort((a, b) => a.priority - b.priority);
  return pool[0] ?? null;
}

/**
 * Единственная точка выхода в сеть. Заодно пишет длительность запроса в
 * монитор связи: по ней индикатор отличает «лагает сеть» от «модель думает».
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 120_000,
  conn?: Connection,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const started = performance.now();
  let status = 0;
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
    });
    status = res.status;
    return res;
  } finally {
    clearTimeout(timer);
    // status=0 значит «ответа не было вовсе» (таймаут/DNS/обрыв) — для
    // индикатора модели это то же «плохо», что и 5xx
    if (conn) recordCall(conn.id, performance.now() - started, status);
  }
}

function authHeaders(c: Connection): Record<string, string> {
  const key = resolveKey(c);
  if (!key)
    throw new NoKeyError(
      `Нет ключа для «${c.name}»: заполни ${c.auth.mode === "env" ? `переменную ${c.auth.ref} в .env` : "локальный ключ в настройках"}`,
    );
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

// ─── Протокол openai-chat (OpenRouter и совместимые) ──────────────────
// Реальный потолок генерации у self-hosted эндпоинтов часто меньше того, что
// пишет GET /models (наша vLLM: 8192 вместо заявленных 262144). Потолок
// подсматриваем в тексте ошибки и запоминаем: второй раз шлём уже допустимый.
const outputCaps = new Map<string, number>();

function parseOutputCap(text: string): number | null {
  const m = /max_tokens=\d+\s+cannot be greater than\s+max_model_len=(\d+)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function chatOnce(
  c: Connection,
  model: string,
  req: ModelRequest,
  params: { temperature: number; maxTokens: number; timeoutMs?: number },
): Promise<LlmAnswer> {
  const messages: unknown[] = [];
  if (req.image) {
    const b64 = fs.readFileSync(req.image.path).toString("base64");
    messages.push({
      role: "user",
      content: [
        { type: "text", text: req.prompt },
        {
          type: "image_url",
          image_url: { url: `data:${req.image.mime};base64,${b64}` },
        },
      ],
    });
  } else {
    messages.push({ role: "user", content: req.prompt });
  }

  const headers = authHeaders(c);
  const capKey = `${c.baseUrl}::${model}`;
  let maxTokens = req.maxTokensOverride ?? params.maxTokens;
  const known = outputCaps.get(capKey);
  if (known) maxTokens = Math.min(maxTokens, known);

  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetchWithTimeout(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: params.temperature,
        max_tokens: maxTokens,
      }),
      // роль «code» генерирует всю страницу: на медленном self-hosted эндпоинте
      // она законно идёт дольше двух минут и на общем таймауте 120 с
      // обрывалась как «транспортная ошибка» (проверено на vLLM)
    }, params.timeoutMs ?? 120_000, c);
    if (res.status === 400 && attempt === 0) {
      const cap = parseOutputCap(await safeText(res));
      if (cap && cap < maxTokens) {
        outputCaps.set(capKey, cap);
        maxTokens = cap;
        continue; // одна повторная попытка уже с допустимым потолком
      }
    }
    break;
  }

  if (res.status === 429) throw new QuotaError(`${c.name}: 429 (квота/рейт)`);
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`${c.name}: ${res.status} — проверь ключ`), {
      klass: "fatal",
    });
  if (!res.ok)
    throw Object.assign(
      new Error(`${c.name}: HTTP ${res.status} ${await safeText(res)}`),
      { klass: "transport" },
    );

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text)
    throw Object.assign(new Error(`${c.name}: пустой ответ`), {
      klass: "transport",
    });
  return {
    text,
    usage: {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ─── Протокол task-poll (kie.ai и подобные) ────────────────────────────
// Задача создаётся POSTом, результат поллится по taskId. Адрес у kie —
// {хост}/api/v1, а пути и так содержат /api/v1: добавлять их к baseUrl значит
// получить /api/v1/api/v1/… и 404 на ровном месте.
function taskApi(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/**
 * Картинки у task-API лежат в общем прайсе со ВСЕМИ моделями провайдера
 * (kie отдаёт 229 строк, включая видео): формат свой —
 * { code, data: { models: [{ model, title, taskType[] }] } } при HTTP 200.
 * В окно картинок идут только текстовые/картинные задачи, видео отбрасываем:
 * картинка с taskType «Image to Video» лендинг не нарисует.
 */
export async function fetchTaskImageModels(
  baseUrl: string,
  key: string | null,
): Promise<Array<{ id: string; label?: string }>> {
  const res = await fetch(`${taskApi(baseUrl)}/api/v1/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => null)) as {
    code?: number;
    data?: { models?: Array<{ model?: string; title?: string; taskType?: string[] }> };
  } | null;
  if (!j || Number(j.code ?? 200) >= 400 || !j.data?.models) return [];
  return j.data.models
    .filter((m) => {
      const types = (m.taskType ?? []).join(" ").toLowerCase();
      if (!types) return false;
      if (!types.includes("image") || types.includes("video")) return false;
      // прайс kie помечает обложку для трека как «Text to Image» — по id
      // слышно, что это музыкальный эндпоинт, а не рисовалка
      return !/music|audio|voice|tts|speech/i.test(`${m.model} ${m.title ?? ""}`);
    })
    .map((m) => ({
      id: m.model!,
      // метка = название из прайса целиком: у kie «Nano Banana» и
      // «Nano Banana-… edit» различаются хвостом, обрезать его нельзя
      label: m.title?.trim().slice(0, 60) || m.model,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function runTask(
  c: Connection,
  req: ImageRequest,
  model: string,
  signal: AbortSignal,
  pollMs = 5_000,
  timeoutMs = 8 * 60_000,
): Promise<{ file: string }> {
  const create = await fetchWithTimeout(
    `${taskApi(c.baseUrl)}/api/v1/jobs/createTask`,
    {
      method: "POST",
      headers: authHeaders(c),
      // Соотношение стороны у task-API называют по-разному и игнорируют незнакомое
      // поле молча, поэтому кладём под обоими именами
      body: JSON.stringify({
        model,
        input: { prompt: req.prompt, aspect_ratio: req.aspect, image_size: req.aspect },
      }),
    },
    30_000,
    c,
  );
  if (create.status === 429) throw new QuotaError(`${c.name}: 429`);
  const created = (await create.json()) as {
    code?: number;
    msg?: string;
    data?: { taskId?: string; id?: string };
  };
  const taskId = created.data?.taskId ?? created.data?.id;
  if (!taskId)
    throw Object.assign(
      new Error(`${c.name}: createTask без taskId: ${created.msg ?? "?"}`),
      { klass: "transport" },
    );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw new Error("отменено");
    if (Date.now() > deadline)
      throw Object.assign(new Error(`${c.name}: задача ${taskId} не дождались`), {
        klass: "transport",
      });
    await sleep(pollMs);
    const st = await fetchWithTimeout(
      `${taskApi(c.baseUrl)}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: authHeaders(c) },
      30_000,
      c,
    );
    const info = (await st.json()) as {
      data?: {
        taskStatus?: string;
        state?: string;
        resultUrls?: string;
        resultJson?: string;
        outputs?: string[];
        failMsg?: string | null;
      };
    };
    // kie кладёт статус в `state`, а ссылки — строкой в `resultJson`
    // ({"resultUrls":[…]}); другие task-API пользуются taskStatus/resultUrls.
    const s = (info.data?.state ?? info.data?.taskStatus ?? "").toLowerCase();
    if (s === "success" || s === "completed") {
      const urls = parseResultUrls(info.data);
      if (!urls.length)
        throw Object.assign(new Error(`${c.name}: success без ссылок`), {
          klass: "contract",
        });
      const img = await fetchWithTimeout(urls[0]!, { headers: {} }, 60_000);
      if (!img.ok)
        throw Object.assign(new Error(`${c.name}: не скачал результат`), {
          klass: "transport",
        });
      fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
      fs.writeFileSync(req.outFile, Buffer.from(await img.arrayBuffer()));
      return { file: req.outFile };
    }
    if (s === "failed" || s === "error")
      throw Object.assign(
        new Error(`${c.name}: задача ${taskId} = ${s}${info.data?.failMsg ? ` · ${info.data.failMsg}` : ""}`),
        { klass: "transport" },
      );
  }
}

// ─── Протокол imagening (imagening.click: POST /api/v1/generations) ─────
// Свой, а не kie-подобный: создание возвращает id сразу, статус поллится по
// /api/v1/generations/{id}, файл качается по outputs[].file с тем же Bearer.
export async function runImagening(
  c: Connection,
  req: ImageRequest,
  model: string,
  signal: AbortSignal,
  pollMs = 4_000,
  timeoutMs = 8 * 60_000,
): Promise<{ file: string }> {
  const create = await fetchWithTimeout(
    `${c.baseUrl}/api/v1/generations`,
    {
      method: "POST",
      headers: authHeaders(c),
      body: JSON.stringify({
        prompt: req.prompt,
        // модель по умолчанию у сервиса есть; пустая строка = «бери дефолтную»
        ...(model ? { model } : {}),
        shape: req.aspect,
        count: 1,
      }),
    },
    30_000,
    c,
  );
  if (create.status === 429) throw new QuotaError(`${c.name}: 429 (очередь/квота)`);
  if (create.status === 401 || create.status === 403)
    throw Object.assign(new Error(`${c.name}: ${create.status} — проверь ключ`), {
      klass: "fatal",
    });
  const created = (await create.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
    message?: string;
  };
  if (!create.ok || !created.id)
    throw Object.assign(
      new Error(
        `${c.name}: generations HTTP ${create.status}: ${created.error?.message ?? created.message ?? "?"}`,
      ),
      { klass: create.status >= 500 ? "transport" : "contract" },
    );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw new Error("отменено");
    if (Date.now() > deadline)
      throw Object.assign(new Error(`${c.name}: генерация ${created.id} не дождались`), {
        klass: "transport",
      });
    await sleep(pollMs);
    const st = await fetchWithTimeout(
      `${c.baseUrl}/api/v1/generations/${created.id}`,
      { headers: authHeaders(c) },
      30_000,
      c,
    );
    const info = (await st.json().catch(() => ({}))) as {
      status?: string;
      outputs?: Array<{ status?: string; file?: string }>;
    };
    const status = info.status?.toLowerCase() ?? "";
    if (status === "completed") {
      const done = info.outputs?.find((o) => o.status === "completed" && o.file);
      if (!done?.file)
        throw Object.assign(new Error(`${c.name}: completed без файла`), {
          klass: "contract",
        });
      const img = await fetchWithTimeout(`${c.baseUrl}${done.file}`, {
        headers: authHeaders(c),
      }, 60_000, c);
      if (!img.ok)
        throw Object.assign(new Error(`${c.name}: не скачал результат`), {
          klass: "transport",
        });
      fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
      fs.writeFileSync(req.outFile, Buffer.from(await img.arrayBuffer()));
      return { file: req.outFile };
    }
    if (status === "failed" || status === "error" || status === "canceled")
      throw Object.assign(new Error(`${c.name}: генерация ${created.id} = ${status}`), {
        klass: "transport",
      });
  }
}

function parseResultUrls(d?: {
  resultUrls?: string;
  resultJson?: string;
  outputs?: string[];
}): string[] {
  if (!d) return [];
  if (d.outputs?.length) return d.outputs;
  for (const raw of [d.resultUrls, d.resultJson]) {
    if (typeof raw !== "string" || !raw) continue;
    try {
      const parsed = JSON.parse(raw);
      // kie: {"resultUrls":["https://…png"]}; где-то просто массив ссылок
      if (Array.isArray(parsed)) return parsed.map(String);
      const arr = (parsed as { resultUrls?: unknown }).resultUrls;
      if (Array.isArray(arr)) return arr.map(String);
      if (typeof arr === "string") return [arr];
    } catch {
      return [raw];
    }
  }
  return [];
}

// ─── Лимит: только констатация факта (SPEC §4) ──────────────────────────
// Мы не можем указать провайдеру, по какому тарифу ему работать, — поэтому
// ничего не «назначаем» галочкой. Спрашиваем у самого API и показываем то,
// что он ответил; не ответил — честно показываем «?» с причиной.
//
// Опрос идёт по протоколу/хосту подключения, а не по настройке юзера: новый
// провайдер добавляется одной строкой в QUOTA_PROBES, а не галкой в форме.
export async function limitBadge(c: Connection): Promise<LimitBadge> {
  const now = new Date().toISOString();
  const key = resolveKey(c);
  // безлимит мог быть объявлен вручную в settings.json (юзер знает свой аккаунт)
  if (c.limit.mode === "manual" && c.limit.unlimited)
    return { connectionId: c.id, state: "unlimited", display: "∞", updatedAt: now };
  if (!key)
    return {
      connectionId: c.id,
      state: "unknown",
      display: "? нет ключа",
      updatedAt: now,
    };

  try {
    // imagening: денег нет, есть очередь генераций — это и есть фактический лимит
    if (c.protocol === "imagening") {
      const res = await fetchWithTimeout(`${c.baseUrl}/api/v1/me`, { headers: authHeaders(c) }, 15_000);
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as {
        key?: string;
        queue?: { pictures?: { waiting?: number; max?: number } };
      };
      const q = j.queue?.pictures;
      const left = q?.max != null && q?.waiting != null ? Math.max(0, q.max - q.waiting) : null;
      return {
        connectionId: c.id,
        state: left === 0 ? "empty" : "ok",
        percent: left != null && q?.max ? Math.round((left / q.max) * 100) : undefined,
        display: q ? `очередь ${q.waiting}/${q.max} · ключ ${j.key ?? "?"}` : "ключ рабочий",
        updatedAt: now,
      };
    }

    // openai-совместимые агрегаторы: у каждого свой эндпоинт квоты
    for (const probe of QUOTA_PROBES) {
      if (!probe.match(c)) continue;
      // без conn: замер лимита — служебный запрос, он не должен портить
      // статистику «сколько думает модель»
      const res = await fetchWithTimeout(`${c.baseUrl}${probe.endpoint}`, {
        headers: authHeaders(c),
      }, 15_000);
      if (!res.ok) continue; // провайдер не отдаёт квоту — переходим к следующему формату
      // some providers split the truth over two endpoints: OpenRouter's /key is
      // the per-key CEILING ($5 guardrail), /credits is the actual balance —
      // reading only the first one showed «100% left» on a zero-balance account
      let extra: Record<string, unknown> | null = null;
      if (probe.also) {
        try {
          const r2 = await fetchWithTimeout(`${c.baseUrl}${probe.also}`, {
            headers: authHeaders(c),
          }, 15_000);
          if (r2.ok) extra = (await r2.json()) as Record<string, unknown>;
        } catch {
          /* нет второго ответа — вердикт без него */
        }
      }
      const fact = probe.read((await res.json()) as Record<string, unknown>, extra);
      if (fact) return { connectionId: c.id, updatedAt: now, ...fact };
    }
    return {
      connectionId: c.id,
      state: "unknown",
      display: "? провайдер не отдаёт лимит",
      updatedAt: now,
    };
  } catch {
    return { connectionId: c.id, state: "unknown", display: "? недоступно", updatedAt: now };
  }
}

interface QuotaFact {
  state: LimitBadge["state"];
  percent?: number;
  display: string;
  paidBlocked?: boolean;
}

interface QuotaProbe {
  name: string;
  match: (c: Connection) => boolean;
  endpoint: string;
  /** второй эндпоинт того же аккаунта, когда одного не хватает (см. openrouter) */
  also?: string;
  read: (j: Record<string, unknown>, extra?: Record<string, unknown> | null) => QuotaFact | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// OpenRouter /api/v1/key: { data: { usage, usage_daily, usage_weekly, usage_monthly,
// limit, limit_remaining, limit_reset, is_free_tier } }. Это факты аккаунта,
// а не наша догадка: limit=null значит «лимита нет», а не «мы не спросили».
const openrouterRead = (
  j: Record<string, unknown>,
  credits?: Record<string, unknown> | null,
): QuotaFact | null => {
  const d = (j.data ?? j) as Record<string, unknown>;
  // Баланс аккаунта: с нулём платные модели отвечают 402, а :free работают.
  // Это то, что юзер чувствует как «моделью нельзя воспользоваться».
  const cd = (credits?.data ?? credits ?? {}) as Record<string, unknown>;
  const balance = num(cd["total_credits"]);
  const spendOnAccount = num(cd["total_usage"]) ?? 0;
  const paidBlocked = balance != null && balance - spendOnAccount <= 0;
  const base = openrouterKeyRead(j);
  if (!base) return null;
  if (paidBlocked) {
    return {
      ...base,
      state: "empty",
      paidBlocked: true,
      display: `баланс $0 · платные недоступны · ${base.display}`,
    };
  }
  return base;
};

const openrouterKeyRead = (j: Record<string, unknown>): QuotaFact | null => {
  const d = (j.data ?? j) as Record<string, unknown>;
  const limit = num(d["limit"]);
  const remaining = num(d["limit_remaining"]);
  const usage = num(d["usage"]) ?? 0;
  const free = d["is_free_tier"] === true;
  if (limit && remaining != null) {
    const percent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
    return {
      state: percent === 0 ? "empty" : percent < 20 ? "low" : "ok",
      percent,
      // «из $5» — это планка ключа, а не баланс: называем это потолком, чтобы
      // 100% не читалось как «деньги есть»
      display: `планка ключа $${limit.toFixed(2)} · осталось $${remaining.toFixed(2)} · расход $${usage.toFixed(2)}`,
    };
  }
  // лимита на ключе нет: показываем наработанный факт (и free tier, если он есть)
  const reset = typeof d["limit_reset"] === "string" ? ` · ${d["limit_reset"]}` : "";
  return {
    state: free ? "low" : "ok",
    display: free ? `бесплатный тариф · расход $${usage.toFixed(2)}${reset}` : `без лимита · расход $${usage.toFixed(2)}`,
  };
};

const QUOTA_PROBES: QuotaProbe[] = [
  {
    name: "openrouter-key",
    match: (c) => /openrouter\.ai/i.test(c.baseUrl),
    endpoint: "/key",
    also: "/credits",
    read: openrouterRead,
  },
  {
    // kie: баланс аккаунта в кредитах одним числом (картинка ~4 кредита).
    // Констатируем факт: сколько есть, мы не знаем, на сколько это прогонов.
    name: "kie-credit",
    match: (c) => /kie\.ai/i.test(c.baseUrl),
    endpoint: "/chat/credit",
    read: (j) => {
      const left = num((j as { data?: unknown }).data);
      if (left == null) return null;
      return {
        state: left <= 0 ? "empty" : left < 20 ? "low" : "ok",
        display: `${left.toFixed(1)} кредитов`,
        paidBlocked: left <= 0,
      };
    },
  },
  {
    name: "openai-credits",
    match: (c) => /api\.openai\.com/i.test(c.baseUrl),
    endpoint: "/dashboard/billing/subscription",
    read: (j) => {
      const d = (j.data ?? j) as Record<string, unknown>;
      const limit = num(d["hard_limit_usd"]) ?? num(d["hard_limit"]);
      const usage = num((d["system_transactions"] as number) ?? d["usage_usd"]);
      if (!limit) return { state: "ok", display: "без жёсткого лимита" };
      const left = limit - (usage ?? 0);
      const percent = Math.max(0, Math.round((left / limit) * 100));
      return {
        state: percent === 0 ? "empty" : percent < 20 ? "low" : "ok",
        percent,
        display: `${percent}% · осталось $${left.toFixed(2)} из $${limit.toFixed(2)}`,
      };
    },
  },
  {
    // openai-совместимые прокси (в т.ч. LiteLLM) часто отдают /credits или /key/info;
    // форматы различаются, поэтому читаем только явно угаданные поля
    name: "generic-credits",
    match: (c) => c.protocol === "openai-chat",
    endpoint: "/key/info",
    read: (j) => {
      const d = (j.key ?? j.data ?? j) as Record<string, unknown>;
      const spend = num(d["spend"]);
      const limit = num(d["max_budget"]) ?? num(d["budget"]);
      if (spend == null && limit == null) return null;
      if (!limit) return { state: "ok", display: `без лимита · расход $${(spend ?? 0).toFixed(2)}` };
      const left = Math.max(0, limit - (spend ?? 0));
      const percent = Math.max(0, Math.round((left / limit) * 100));
      return {
        state: percent === 0 ? "empty" : percent < 20 ? "low" : "ok",
        percent,
        display: `${percent}% · осталось $${left.toFixed(2)} из $${limit.toFixed(2)}`,
      };
    },
  },
];

/** Пинг vision-способности: маленький png + «что на картинке?» */
export async function probeVision(c: Connection, model: string): Promise<boolean> {
  const png1px = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const tmp = `/tmp/builder-vision-${Date.now()}.png`;
  fs.writeFileSync(tmp, png1px);
  try {
    const a = await chatOnce(c, model, {
      role: "code",
      prompt: "Что изображено? Ответь одним словом.",
      image: { path: tmp, mime: "image/png" },
      maxTokensOverride: 20,
    }, { temperature: 0, maxTokens: 20 });
    return a.text.trim().length > 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
