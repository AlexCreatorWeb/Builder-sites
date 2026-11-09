/**
 * llm-runner: роль → (подключение + модель + параметры + шаблон) → ответ строкой.
 * Сети отсюда не видно: только connections/*.
 */
import type { Connection } from "@builder/shared";
import { settings } from "../config.ts";
import {
  chatOnce,
  connectionFor,
  NoKeyError,
  QuotaError,
  type LlmAnswer,
} from "../connections/index.ts";
import { recordTask } from "../net/monitor.ts";
import type { ModelRequest } from "../orchestrator/types.ts";

export interface LlmOutcome {
  text: string;
  usage: { prompt: number; completion: number };
  connectionId: string;
  model: string;
}

/** Модель для роли: явный выбор из UI, иначе первая из реестра подключения. */
export function pickModel(c: Connection, preferred?: string | null): string | null {
  if (preferred) return preferred;
  return c.models[0]?.id ?? null;
}

/** Подключение + модель, пригодные для роли; fallback по квоте — следующий по priority. */
export function resolveLlm(role: string): { c: Connection; model: string } {
  const s = settings();
  const preferred = s.selection.codeCopy;
  const primary = connectionFor("llm", preferred.connection);
  const model = primary ? pickModel(primary, preferred.model) : null;
  if (primary && model) return { c: primary, model };
  throw Object.assign(new Error("Нет рабочей LLM-модели: выбери подключение в сайдбаре"), {
    klass: "fatal",
    role,
  });
}

/**
 * Основной вызов. Квота на активной модели → fallback на следующее enabled-подключение
 * того же kind (SPEC §6); нет fallback — бросаем QuotaError, решит RunManager.
 */
export async function callLlm(
  req: ModelRequest,
  signal: AbortSignal,
): Promise<LlmOutcome> {
  const s = settings();
  const params = s.roleParams[req.role] ?? { temperature: 0.3, maxTokens: 4000 };
  const used: string[] = [];

  const pool = s.connections
    .filter((c) => c.kind === "llm" && c.enabled)
    .sort((a, b) => a.priority - b.priority);
  const preferredId = s.selection.codeCopy.connection;
  pool.sort((a, b) => (a.id === preferredId ? -1 : 0) - (b.id === preferredId ? -1 : 0));
  // эскалация: запрос стартует с принудительной модели (её подключение —
  // первое в пуле), а не с обычной; при её квоте/сбое порядок обычный
  if (req.modelOverride) {
    const ovConn = req.modelOverride.connection
      ? pool.findIndex((c) => c.id === req.modelOverride!.connection)
      : -1;
    if (ovConn >= 0) pool.unshift(...pool.splice(ovConn, 1));
    else {
      const c = connectionFor("llm", req.modelOverride.connection);
      if (c && c.enabled) pool.unshift(c);
    }
  }

  let lastErr: unknown = null;
  for (const c of pool) {
    if (signal.aborted) throw new Error("отменено");
    // override действует ТОЛЬКО на своё подключение: при его отказе (квота)
    // остальные идут со своей моделью, а не ловят «unknown model»
    const useOv =
      req.modelOverride &&
      (!req.modelOverride.connection || req.modelOverride.connection === c.id) &&
      c.models.some((m) => m.id === req.modelOverride!.model);
    const model = useOv
      ? req.modelOverride!.model
      : c.id === preferredId
        ? pickModel(c, s.selection.codeCopy.model)
        : pickModel(c);
    if (!model) continue;
    used.push(`${c.id}/${model}`);
    try {
      const started = performance.now();
      const a: LlmAnswer = await chatOnce(c, model, req, params);
      recordTask(c.id, performance.now() - started);
      return { text: a.text, usage: a.usage, connectionId: c.id, model };
    } catch (err) {
      lastErr = err;
      // подключение без ключа — не ошибка прогона: оно просто не настроено,
      // раньше он сжигал попытку и валил прогон вместо перехода к следующему
      if (err instanceof QuotaError || err instanceof NoKeyError) continue;
      throw err; // transport/fatal — пусть ретраит планировщик
    }
  }
  if (lastErr instanceof QuotaError) throw lastErr;
  throw Object.assign(
    new Error(
      `LLM недоступна для роли «${req.role}» (перебрано: ${used.join(", ") || "ничего"}): ` +
        ((lastErr as Error)?.message ?? "нет подключений"),
    ),
    { klass: (lastErr as { klass?: string })?.klass ?? "fatal" },
  );
}
