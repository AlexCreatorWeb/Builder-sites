/**
 * Рендер шаблонов промптов (SPEC §2): prompts/<mode>/<task>.md.jte.
 * Хэш шаблона входит в кэш запроса — правка промпта сбрасывает кэш сама.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";

/**
 * Значения для подстановки выводятся в доменный тип на границе: шаблон
 * не видит «anything», а видит строку/число/список/запись/пустоту.
 */
export type RenderValue =
  | { kind: "text"; value: string }
  | { kind: "list"; items: RenderValue[] }
  | { kind: "record"; fields: Scope }
  | { kind: "empty" };

export type Scope = Record<string, RenderValue> & { this?: RenderValue };

/** Приводит данные Brief/плана к RenderValue. */
export function toRender(v: unknown): RenderValue {
  if (v === null || v === undefined) return { kind: "empty" };
  if (typeof v === "string") return { kind: "text", value: v };
  if (typeof v === "number" || typeof v === "boolean")
    return { kind: "text", value: String(v) };
  if (Array.isArray(v)) return { kind: "list", items: v.map(toRender) };
  if (typeof v === "object") {
    const fields: Scope = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      fields[k] = toRender(val);
    return { kind: "record", fields };
  }
  return { kind: "text", value: String(v) };
}

/** Brief -> область видимости шаблона. */
export function scopeOf(obj: Record<string, unknown>): Scope {
  const out = toRender(obj);
  return out.kind === "record" ? out.fields : {};
}

/**
 * Область видимости для вызова шаблона с именованными данными.
 * Каждое имя доступно и как {{json.<name>}} (как принято в шаблонах),
 * и как {{<name>.поле}} — флэтта верхнего уровня нет, поэтому имена
 * sections/palette у brief и plan не сталкиваются.
 */
export function promptVars(named: Record<string, unknown>): Scope {
  const fields: Record<string, RenderValue> = {};
  for (const [k, v] of Object.entries(named)) fields[k] = toRender(v);
  return { json: { kind: "record", fields }, ...fields };
}

function render(v: RenderValue): string {
  switch (v.kind) {
    case "text":
      return v.value;
    case "empty":
      return "";
    case "list":
      return v.items.map(render).join(", ");
    case "record":
      return JSON.stringify(plain(v), null, 2);
    default:
      return "";
  }
}

/** Развёртка обратно в JSON-подобное значение (для {{json}}-блоков). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function plain(v: RenderValue): JsonValue {
  switch (v.kind) {
    case "text":
      return v.value;
    case "empty":
      return null;
    case "list":
      return v.items.map(plain);
    case "record": {
      const o: { [k: string]: JsonValue } = {};
      for (const [k, val] of Object.entries(v.fields))
        if (k !== "this") o[k] = plain(val);
      return o;
    }
  }
}

function step(cur: RenderValue, part: string): RenderValue | undefined {
  if (cur.kind === "record") return cur.fields[part];
  if (cur.kind === "list") {
    if (part === "length")
      return { kind: "text", value: String(cur.items.length) };
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0) return cur.items[n];
  }
  return undefined;
}

function lookup(scope: Scope, keyPath: string): RenderValue | undefined {
  const root: RenderValue = { kind: "record", fields: scope };
  let cur: RenderValue | undefined = root;
  for (const part of keyPath.split(".")) {
    if (!cur) return undefined;
    cur = step(cur, part);
  }
  return cur;
}

export type PromptTask =
  | "plan"
  | "copy"
  | "image-prompts"
  | "page-code"
  | "fix"
  /** список правок человека одним вызовом: патч + отметка `done` на каждый пункт */
  | "fix-list"
  | "judge";

export interface RenderedPrompt {
  text: string;
  file: string;
  /** версия = короткий хэш содержимого — попадает в ключ кэша */
  version: string;
}

const cache = new Map<string, string>();

export function renderPrompt(
  mode: "white" | "black",
  task: PromptTask,
  vars: Scope,
): RenderedPrompt {
  const file = path.join(ROOT, "prompts", mode, `${task}.md.jte`);
  let tpl: string;
  try {
    tpl = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `Нет шаблона промпта ${mode}/${task}.md.jte — проверь папку prompts/`,
    );
  }
  // {{>include name}} — подстановка куска MASTER_PROMPT (prompts/<mode>/sections/<name>.md):
  // мастер-промпт живёт в одном файле, шаблоны ссылаются на нужные разделы
  tpl = tpl.replace(/\{\{>include (\w+)\}\}/g, (_m, name: string) => {
    const inc = path.join(ROOT, "prompts", mode, "sections", `${name}.md`);
    try {
      return fs.readFileSync(inc, "utf8");
    } catch {
      throw new Error(`Нет включаемого раздела промпта: ${name} (${inc})`);
    }
  });
  const version = shortHash(tpl);
  const text = interpolate(tpl, vars);
  return { text, file, version };
}

/**
 * Мини-интерполяция: {{ path.to.value }} и {{#each list}}…{{/each}}.
 * Намеренно своя, а не jte-рантайм: ноль рантайм-зависимостей у коллеги.
 */
function interpolate(tpl: string, vars: Scope): string {
  let out = tpl;
  out = out.replace(
    /\{\{#each ([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_m, keyPath: string, body: string) => {
      const list = lookup(vars, keyPath);
      if (!list || list.kind !== "list") return "";
      return list.items
        .map((item) =>
          interpolate(body, {
            ...vars,
            this: item,
            ...(item.kind === "record" ? item.fields : {}),
          }),
        )
        .join("");
    },
  );
  out = out.replace(/\{\{([\w.]+)\}\}/g, (_m, keyPath: string) => {
    const v = lookup(vars, keyPath);
    if (!v || v.kind === "empty") return "";
    return render(v);
  });
  return out;
}



export function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Кэш ответа модели: promptVersion + role + model + input + seed (SPEC §6). */
export function cacheKey(parts: Record<string, unknown>): string {
  const stable = JSON.stringify(parts, Object.keys(parts).sort());
  const hit = cache.get(stable);
  if (hit) return hit;
  const k = shortHash(stable);
  cache.set(stable, k);
  return k;
}

export function cachePath(projectDir: string, key: string): string {
  return path.join(projectDir, ".cache", `${key}.txt`);
}

export function readCache(projectDir: string, key: string): string | null {
  try {
    return fs.readFileSync(cachePath(projectDir, key), "utf8");
  } catch {
    return null;
  }
}

export function writeCache(projectDir: string, key: string, value: string): void {
  const p = cachePath(projectDir, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value);
}
