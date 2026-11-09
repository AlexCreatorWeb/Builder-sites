/**
 * image-runner: одна картинка по slug. Протокол (task-poll / imagening) скрыт в connections.
 * ретраи вариацией промпта делает планировщик; здесь — попытка + fallback-подключение.
 */
import path from "node:path";
import type { Connection } from "@builder/shared";
import { settings } from "../config.ts";
import { NoKeyError, QuotaError, runImagening, runTask } from "../connections/index.ts";
import { recordTask } from "../net/monitor.ts";
import type { ImageRequest } from "../orchestrator/types.ts";

export interface ImageOutcome {
  file: string;
  connectionId: string;
  model: string;
}

function imagePool(preferredId?: string): Connection[] {
  const s = settings();
  const pool = s.connections.filter((c) => c.kind === "image" && c.enabled);
  pool.sort((a, b) => a.priority - b.priority);
  if (preferredId)
    pool.sort((a, b) => (a.id === preferredId ? -1 : 0) - (b.id === preferredId ? -1 : 0));
  return pool;
}

/** Прогон без image-подключения — не ошибка, а режим (none/manual или деградация). */
export function imageAvailable(): boolean {
  const s = settings();
  if (s.selection.imageMode !== "api") return false;
  return imagePool(s.selection.image.connection).some((c) => c.models.length === 0 || true);
}

export async function callImage(
  req: ImageRequest,
  signal: AbortSignal,
): Promise<ImageOutcome> {
  const s = settings();
  const pool = imagePool(s.selection.image.connection);
  if (!pool.length)
    throw Object.assign(new Error("Нет подключения для графики"), { klass: "fatal" });

  let lastErr: unknown = null;
  for (const c of pool) {
    // у imagening пустая модель допустима: сервис берёт свою default
    const model = s.selection.image.model ?? c.models[0]?.id ?? (c.protocol === "imagening" ? "" : undefined);
    if (!model)
      throw Object.assign(
        new Error(`В подключении «${c.name}» не указана модель (settings.json → models)`),
        { klass: "fatal" },
      );
    try {
      // засекаем задачу целиком: у картинки это и есть те самые ~13 с, которые
      // юзер видит как «модель тормозит» (HTTP-запросы при этом по 50 мс)
      const started = performance.now();
      const r =
        c.protocol === "imagening"
          ? await runImagening(c, req, model, signal)
          : await runTask(c, req, model, signal);
      recordTask(c.id, performance.now() - started);
      return { file: path.normalize(r.file), connectionId: c.id, model };
    } catch (err) {
      lastErr = err;
      // квота или незагруженный ключ — переходим к следующему подключению
      if (err instanceof QuotaError || err instanceof NoKeyError) continue;
      throw err;
    }
  }
  if (lastErr instanceof QuotaError) throw lastErr;
  throw Object.assign(
    new Error(`Графика недоступна: ${(lastErr as Error)?.message ?? "нет ответа"}`),
    { klass: (lastErr as { klass?: string })?.klass ?? "transport" },
  );
}
