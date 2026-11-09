/**
 * Вызов модели за JSON-ответом: шаблон → кэш → сеть → парсер → 1 самокоррекция.
 * Классы ошибок (SPEC §6): transport/fatal летят наверх (планировщик ретраит),
 * contract = ответ не парсится → один повтор с текстом ошибки.
 */
import fs from "node:fs";
import path from "node:path";
import type { ErrorClass, Mode } from "@builder/shared";
import { callLlm, type LlmOutcome } from "../runners/llm.ts";
import { settings } from "../config.ts";
import {
  cacheKey,
  promptVars,
  readCache,
  renderPrompt,
  scopeOf,
  writeCache,
  type PromptTask,
  type Scope,
} from "../prompts/render.ts";
import type { ModelRequest } from "../orchestrator/types.ts";

export interface JsonCallArgs {
  dir: string;
  mode: Mode;
  task: PromptTask;
  role: ModelRequest["role"];
  /** именованные данные для шаблона: vars({ brief, plan }) → {{json.brief}} */
  vars: Record<string, unknown>;
  signal: AbortSignal;
  /** скриншот для vision-роли */
  image?: { path: string; mime: string };
  /** additional: дописать к уже отрендеренному шаблону (самокоррекция, комментарий gate) */
  suffix?: string;
  /** сместить ключ кэша (раунд фиксов, комментарий юзера) */
  salt?: string;
  /** эскалация: принудительная модель вместо выбранной в UI (входит в кэш) */
  modelOverride?: { connection?: string; model: string };
}

export interface JsonCallResult<T> {
  value: T;
  raw: string;
  usage: { prompt: number; completion: number };
  model: string;
  connectionId: string;
  cached: boolean;
}

/** Ошибка контракта: модель ответила, но ответ непригоден. */
export class ContractError extends Error {
  klass: ErrorClass = "contract";
  constructor(msg: string) {
    super(msg);
    this.name = "ContractError";
  }
}

export function briefScope(brief: unknown): Scope {
  return scopeOf((brief ?? {}) as Record<string, unknown>);
}

export async function callJson<T>(args: JsonCallArgs): Promise<JsonCallResult<T>> {
  const rendered = renderPrompt(args.mode, args.task, promptVars(args.vars));
  const text = rendered.text + (args.suffix ? `\n\n${args.suffix}` : "");

  // Ответ модели кладём в промпт-кэш: правка промпта или Brief сбрасывает его сама.
  // В ключе обязана быть АКТИВНАЯ модель: без неё переключение на другую модель
  // (бесплатная, другой провайдер, fallback по квоте) молча возвращало ответ
  // прежней — выглядело как «новая модель не отвечает», а на самом деле кэш.
  const sel = settings().selection.codeCopy;
  const active = args.modelOverride
    ? `${args.modelOverride.connection ?? sel.connection}/${args.modelOverride.model}`
    : `${sel.connection}/${sel.model ?? ""}`;
  const net: ModelRequest = {
    role: args.role,
    prompt: text,
    image: args.image,
    modelOverride: args.modelOverride,
  };
  const key = cacheKey({
    kind: args.task,
    role: args.role,
    promptVersion: rendered.version,
    input: rendered.text,
    image: args.image?.path ? 1 : 0,
    salt: args.salt ?? "",
    model: active,
  });
  const hit = readCache(args.dir, key);
  if (hit) {
    try {
      return {
        value: parseModelJson<T>(hit),
        raw: hit,
        usage: { prompt: 0, completion: 0 },
        model: "cache",
        connectionId: "cache",
        cached: true,
      };
    } catch {
      // испорченный кэш — затираем живым запросом
    }
  }

  const first = await callLlm(net, args.signal);
  recordPrompt(args.dir, `${args.task}${args.salt ? `.${args.salt}` : ""}`, net.prompt, first);
  try {
    const value = parseModelJson<T>(first.text);
    writeCache(args.dir, key, first.text);
    return { ...meta(first), value, raw: first.text, cached: false };
  } catch (err) {
    // contract: один самокорректирующий повтор с текстом ошибки
    const second = await callLlm(
      {
        ...net,
        prompt: `${net.prompt}\n\n## Важно\nПредыдущий ответ не распарсился как JSON: ${
          (err as Error).message
        }. Ответь ТОЛЬКО одним JSON-объектом, без markdown-ограждения и без пояснений.`,
      },
      args.signal,
    );
    recordPrompt(args.dir, `${args.task}.${args.salt ?? "retry"}.rendered.md`.replace(/\.md$/, ""), net.prompt, second);
    const value = parseModelJson<T>(second.text); // вторая неудача = contract-ошибка планировщику
    writeCache(args.dir, key, second.text);
    return { ...meta(second), value, raw: second.text, cached: false };
  }
}

function meta(o: LlmOutcome) {
  return { usage: o.usage, model: o.model, connectionId: o.connectionId };
}

/**
 * Снисходительный парсер: ответ обязан быть JSON, но модели срезают обещания —
 * режем ```json, ведущий/ведомый текст и висячие запятые.
 */
export function parseModelJson<T>(raw: string): T {
  const attempts: string[] = [];
  const trimmed = raw.trim();
  attempts.push(trimmed);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const start = trimmed.search(/[[{]/);
  const endObj = trimmed.lastIndexOf("}");
  const endArr = trimmed.lastIndexOf("]");
  const end = Math.max(endObj, endArr);
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  attempts.push(...attempts.map((s) => s.replace(/,\s*([}\]])/g, "$1")));

  let lastErr: Error = new ContractError("пустой ответ модели");
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw new ContractError(
    `ответ не является JSON (${lastErr.message}): ${trimmed.slice(0, 160)}…`,
  );
}

/** Сохраняет фактически отправленный промпт в артефакты прогона (SPEC §10). */
export function recordPrompt(
  dir: string,
  name: string,
  prompt: string,
  o: { model: string; connectionId: string },
): void {
  const f = path.join(dir, "prompts", `${name}.rendered.md`);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      `<!-- модель: ${o.connectionId}/${o.model} · ${new Date().toISOString()} -->\n\n${prompt}\n`,
    );
  } catch {
    /* артефакт не критичен для прогона */
  }
}
