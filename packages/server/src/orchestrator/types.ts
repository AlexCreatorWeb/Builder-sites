/**
 * Контракты оркестрации (SPEC §6). Runner не знает про конкретных провайдеров,
 * Connections — единственный сетевой слой.
 */
import type { ErrorClass, ModelKind, OrchEvent } from "@builder/shared";

export interface TaskCtx {
  projectId: string;
  /** путь папки проекта — всё, что видит runner на диске */
  dir: string;
  signal: AbortSignal;
  emit: (e: OrchEvent) => void;
}

export interface RunResult<T = unknown> {
  ok: boolean;
  value?: T;
  /** артефакт на диске (относительный путь) — по нему восстановим после падения */
  artifact?: string;
  /** хэш входа+промпта+модели+версии — для пропуска выполненного при рестарте */
  inputHash?: string;
  usage?: { prompt: number; completion: number; usdEstimate?: number };
  error?: { klass: ErrorClass; message: string };
}

export interface Task<T = unknown> {
  id: string; // "plan" | "copy" | "image:<slug>" | "code" | "assemble" | ...
  lane: "llm" | "image" | "browser" | "fs";
  run: (ctx: TaskCtx) => Promise<RunResult<T>>;
  dependsOn: string[];
  /** условное ребро (цикл фиксов) */
  enabled?: (state: unknown) => boolean;
}

export interface ModelRequest {
  role: "plan" | "code" | "copy" | "fix";
  prompt: string;
  /** картинка для vision-запроса */
  image?: { path: string; mime: string };
  maxTokensOverride?: number;
  /** потолок ожидания ответа; у роли «code» он больше общего (страница генерируется долго) */
  timeoutMs?: number;
  /**
   * Принудительная модель (эскалация после провалов дешёвой): пул стартует с
   * неё, при её недоступности — обычный порядок. Только для ролей, где мы
   * готовы заплатить за послушность (fix после двух «патч не меняет страницу»).
   */
  modelOverride?: { connection?: string; model: string };
}

export interface ImageRequest {
  prompt: string;
  aspect: string;
  outFile: string; // абсолютный путь, куда сохранить
}

export type Runner = {
  llm: (req: ModelRequest, ctx: TaskCtx) => Promise<RunResult<string>>;
  image: (req: ImageRequest, ctx: TaskCtx) => Promise<RunResult<string>>;
  browser: unknown;
  fs: unknown;
};

export type { ModelKind };
