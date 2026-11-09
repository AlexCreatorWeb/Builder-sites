// Самопроверка при старте (SPEC §10.1): живые ли подключения, есть ли ключи,
// назначена ли модель на каждую роль. Запускается до первого прогона и из CI.
// Выход 0 — можно работать; 1 — есть блокирующее (нет ключа/модели/эндпоинта).
//
// Ключи отсюда не печатаются: выводим только способ хранения (env/файл) и счётчик.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.json"), "utf8"));
// .env этого компа читаем ВСЕГДА: раньше он подхватывался только через
// BUILDER_ENV_FILE, и doctor кричал «нет ключа» там, где сервер ключ видел.
const envFiles = [
  path.join(ROOT, ".env"),
  ...(process.env.BUILDER_ENV_FILE ?? "").split(path.delimiter).filter(Boolean),
];
for (const m of envFiles) {
  try {
    for (const line of fs.readFileSync(m, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      if (k && process.env[k] === undefined) {
        process.env[k] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* нет файла — не беда */
  }
}

const ok = [];
const warn = [];
const fail = [];

function keyOf(c) {
  if (!c.auth) return null;
  return c.auth.mode === "env" ? process.env[c.auth.ref] ?? null : fs.existsSync(c.auth.ref) ? c.auth.ref : null;
}

// 1) ключи и модели по каждому подключению
for (const c of conf.connections ?? []) {
  if (!c.enabled) {
    warn.push(`подключение ${c.name}: выключено`);
    continue;
  }
  const key = keyOf(c);
  if (!key) {
    const how = c.auth?.mode === "env" ? `переменная ${c.auth.ref} не задана` : "локального ключа нет на диске";
    // отсутствие ключа не блокирует старт сервера — warn, а не fail. Но последствия
    // у llm и у картинки разные: llm уронит прогон, картинка деградирует в плейсхолдер
    warn.push(
      `${c.name}: ${how} — ` +
        (c.kind === "llm"
          ? "прогон упадёт на первом запросе к модели"
          : "картинки будут плейсхолдерами (SPEC §9)"),
    );
  } else {
    ok.push(`${c.name}: ключ есть (${c.auth.mode === "env" ? "env" : "файл"})`);
  }
  if (c.kind === "llm" && (c.models ?? []).length === 0) {
    fail.push(`${c.name}: ни одной модели — нажми «взять модели с API»`);
  } else if ((c.models ?? []).length) {
    ok.push(`${c.name}: моделей ${c.models.length}`);
  }
}

// 2) роли: code/copy обязаны иметь модель, image — только при imageMode=api
const sel = conf.selection ?? {};
const cc = sel.codeCopy ?? {};
if (cc.connection === "none" || !cc.model) {
  fail.push("роль code/copy: модель не выбрана (выбор в сайдбаре, блок «Модели»)");
} else {
  const c = (conf.connections ?? []).find((x) => x.id === cc.connection);
  if (!c) fail.push(`роль code/copy: подключения ${cc.connection} нет`);
  else if (c.models?.length && !c.models.some((m) => m.id === cc.model))
    fail.push(`роль code/copy: модели «${cc.model}» нет в ${c.name} — обнови список`);
  else ok.push(`роль code/copy: ${c.name} / ${cc.model}`);
}

if ((sel.imageMode ?? "api") === "api") {
  const ic = sel.image ?? {};
  const c = (conf.connections ?? []).find((x) => x.id === ic.connection);
  if (!c) warn.push("роль image: подключения нет (или переключись на ручной --photo)");
  else if (!keyOf(c)) warn.push("роль image: у подключения нет ключа (или переключись на --photo)");
  else ok.push(`роль image: ${c.name}`);
} else {
  ok.push("роль image: ручной режим (--photo), API не нужен");
}

// 3) живость эндпоинтов: GET {base}/models, только тем, у кого есть ключ
const checks = [];
for (const c of conf.connections ?? []) {
  if (!c.enabled || !keyOf(c) || c.kind !== "llm") continue;
  // у image-API эндпоинта /models обычно нет — дёргать его и пугать warn'ом бессмысленно
  const url = `${String(c.baseUrl).replace(/\/+$/, "")}/models`;
  const t = Date.now();
  checks.push(
    fetch(url, {
      headers: { authorization: `Bearer ${keyOf(c)}` },
      signal: AbortSignal.timeout(15_000),
    })
      .then((r) => {
        if (!r.ok) warn.push(`${c.name}: ${url} ответил ${r.status} (401 = ключ, 404 = адрес)`);
        else ok.push(`${c.name}: эндпоинт жив (${Date.now() - t} мс)`);
      })
      .catch((e) => warn.push(`${c.name}: ${url} недоступен — ${e.message.slice(0, 60)}`)),
  );
}
await Promise.all(checks);

// 4) лимит: без него прогон валидный, но вслепую
const lim = conf.limit ?? {};
if (lim.mode === "manual" && lim.unlimited) ok.push("лимит объявлен: безлимит");
else if (lim.mode === "manual")
  warn.push(`лимит ручной: ${lim.costCap ?? "?"} ${lim.currency ?? "USD"} — поставь его по своим деньгам`);
else warn.push("лимит неизвестен — укажи в сайдбаре или оставь безлимит");

const line = (s) => "\n" + s;
console.log("Проверка Builder:");
for (const m of ok) console.log(`  ok    ${m}`);
for (const m of warn) console.log(`  warn  ${m}`);
for (const m of fail) console.log(`  FAIL  ${m}`);
console.log(line(`${ok.length} ok · ${warn.length} warn · ${fail.length} fail`));
process.exit(fail.length ? 1 : 0);
