/**
 * settings.json + .env — единственный источник конфигурации (SPEC §2, §4).
 * Ключи генератора живут только в переменных с префиксом BUILDER_.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection, Selection } from "@builder/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..", "..");

// .env грузим сами — одной зависимостью меньше у коллеги при установке
/** Файл ключей этого компа: его сам пишет setEnvLocal, его читает loadEnv. */
const ENV_FILE = path.join(ROOT, ".env");

export function loadEnv(): void {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

/**
 * Записать ключ в .env и сразу в process.env.
 * Смысл: юзер вставил ключ в поле — и больше ничего не настраивает. Раньше форма
 * писала auth.mode=env с именем переменной, которой нигде не было, и подключение
 * считалось безключевым до ручной правки .env.
 */
export function setEnvLocal(name: string, value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("имя переменной: A-Z, 0-9, _");
  process.env[name] = value;
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const line = `${name}=${value}`;
  const next = new RegExp(`^${name}=`, "m").test(text)
    ? text.replace(new RegExp(`^${name}=.*$`, "m"), line)
    : (text ? (text.endsWith("\n") ? text : text + "\n") + line : line + "\n");
  fs.writeFileSync(ENV_FILE, next, { mode: 0o600 });
}

export interface Settings {
  projectsRoot: string;
  port: number;
  webPort: number;
  openBrowserOnStart: boolean;
  connections: Connection[];
  selection: Selection;
  /** «наша» пара подключений (дефолт генератора): к ней возвращаются из окна */
  defaults?: { codeCopy: Selection["codeCopy"]; image: Selection["image"] };
  roleParams: Record<string, { temperature: number; maxTokens: number; timeoutMs?: number }>;
  lanes: { llm: number; image: number; browser: number };
  gates: { afterPlan: boolean; afterCopy: boolean; afterImages: boolean };
  maxFixRounds: number;
  /**
   * Модель для ЭСКАЛАЦИИ правки: если выбранная дешёвая модель дважды
   * прислала патч, не изменивший страницу, третья попытка идёт сюда
   * (обычно сильная модель того же OpenRouter). Нет поля — эскалации нет.
   */
  fixEscalation?: { connection?: string; model: string };
  requireVision: "warn" | "block" | "off";
  /** куда выкладывать готовый проект после генерации (выбор в брифе) */
  delivery?: { kind: "here" | "desktop" | "folder" | "custom"; path?: string; zip?: boolean };
  /** папки, куда уже выкладывали: предлагаются пилюлями в следующем брифе */
  recentDirs?: string[];
}

let cached: Settings | null = null;

/** Путь к settings.json: BUILDER_SETTINGS позволяет гонять смоук-прогон на своих конфигах. */
function settingsFile(): string {
  const env = process.env["BUILDER_SETTINGS"];
  return env ? path.resolve(ROOT, env) : path.join(ROOT, "settings.json");
}

export function settings(): Settings {
  if (cached) return cached;
  const file = settingsFile();
  let s: Settings;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  } catch (err) {
    throw new Error(
      `settings.json повреждён или отсутствует (${file}): ${(err as Error).message}`,
    );
  }
  s.projectsRoot = path.resolve(ROOT, s.projectsRoot);
  cached = s;
  return s;
}

export function saveSettings(s: Settings): void {
  cached = s;
  // ПИСАТЬ ОБЯЗАТЕЛЬНО в settingsFile(): смоук гоняет на BUILDER_SETTINGS, и
  // запись в ROOT/settings.json затирала рабочий конфиг подключений
  // (проверено: после npm run smoke из реального settings.json пропадали
  // litellm/imagening и выбор ролей)
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2) + "\n");
}

/** Резолв ключа подключения. env — по имени, local — значение в ref. */
export function resolveKey(c: Connection): string | null {
  if (c.auth.mode === "local") return c.auth.ref || null;
  return process.env[c.auth.ref] || null;
}
