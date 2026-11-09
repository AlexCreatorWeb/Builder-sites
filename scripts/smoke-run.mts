/**
 * Смоук-прогон без внешних ключей: фейковая openai-chat модель отвечает заготовками
 * по очереди (plan → copy → image-prompts → page-code → judge), всё остальное живое:
 * планировщик, граф, браузер, сборка, вердикт. Запуск: npm run smoke -w packages/server
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const tmp = fs.mkdtempSync(path.join(ROOT, ".smoke-"));
const projRoot = path.join(tmp, "projects");
const projId = "smoke_white";
const dir = path.join(projRoot, projId);
fs.mkdirSync(path.join(dir, "assets", "img"), { recursive: true });

const planJson = {
  sections: [
    { type: "hero", heading: "Потолок натяжной за один день", slug: "hero", notes: "" },
    { type: "benefits", heading: "Почему нас выбирают", slug: "benefits", notes: "" },
    { type: "cta", heading: "Замер бесплатно", slug: "cta", notes: "" },
  ],
  palette: { bg: "#FFFFFF", accent: "#0F62FE", text: "#14161A", muted: "#5B6472" },
  fonts: { heading: "Manrope", body: "Inter" },
  images: [
    { slug: "hero", description: "светлая гостиная с натяжным потолком", aspect: "16:9", role: "hero" },
    { slug: "proof-1", description: "мастер за работой", aspect: "3:4", role: "content" },
  ],
  copyFormula: "AIDA",
  hardRules: ["светлая серия, много воздуха"],
};

const copyJson = {
  meta: { title: "Натяжные потолки в Казани", description: "Монтаж за один день" },
  sections: {
    hero: { heading: "Потолок за один день", sub: "Монтаж под ключ без пыли", bullets: ["Договор и гарантия 10 лет"], cta: "Вызвать замерщик" },
    benefits: { heading: "Почему нас выбирают", bullets: ["Без предоплаты", "Профиль без щелей"], body: "Работаем по городу с 2014 года." },
    cta: { heading: "Замер бесплатно", sub: "Позвоните", cta: "Позвонить" },
  },
};

const promptsJson = {
  images: [
    { slug: "hero", prompt: "bright living room with stretch ceiling, soft daylight, wide lens", negative: "text, watermark" },
    { slug: "proof-1", prompt: "installer mounting stretch ceiling, clean interior, natural light", negative: "text, watermark" },
  ],
};

const pageJson = {
  html: `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Натяжные потолки</title>
<link rel="stylesheet" href="assets/app.css">
</head><body>
<main>
<section id="hero"><h1>Потолок за один день</h1><p>Монтаж под ключ без пыли</p>
<ul><li>Договор и гарантия 10 лет</li></ul>
<img src="assets/img/hero.img" alt="Гостиная" width="1200" height="675">
<a class="btn" href="#cta">Вызвать замерщик</a></section>
<section id="benefits"><h2>Почему нас выбирают</h2><ul><li>Без предоплаты</li><li>Профиль без щелей</li></ul>
<img src="assets/img/proof-1.img" alt="Мастер" loading="lazy"></section>
<section id="cta"><h2>Замер бесплатно</h2><a class="btn" href="tel:+78430000000">Позвонить</a>
<p>Цена от 450 ₽/м²</p></section>
</main>
<footer>© 2026 Потолки</footer>
<script src="assets/app.js"></script>
</body></html>`,
  css: `:root{--bg:${"#FFFFFF"};--accent:#0F62FE;--text:#14161A}
*{box-sizing:border-box}body{margin:0;font-family:Inter,"DejaVu Sans",sans-serif;background:var(--bg);color:var(--text)}
section{padding:64px 24px;max-width:1120px;margin:0 auto}
img{max-width:100%;height:auto;aspect-ratio:16/9;display:block}
.btn{display:inline-block;min-height:44px;line-height:44px;padding:0 24px;background:var(--accent);color:#fff;border-radius:10px;text-decoration:none}
ul{padding-left:20px}`,
  js: `document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',e=>{
  const t=document.querySelector(a.getAttribute('href')); if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'});}}));`,
};

const verdictJson = { critical: 0, defects: [], summary: "всё чисто" };

// ответы по ПЕРВОЙ СТРОКЕ шаблона: все белые шаблоны включают один и тот же
// мастер-текст («Senior Product Designer … Frontend Developer»), поэтому
// неанкерованный подстроковый поиск возвращал план на каждый запрос
const answers: Array<[RegExp, unknown]> = [
  [/Что изображено\?/, { answer: "пиксель" }],
  [/^Ты — Senior Product Designer и UX Architect/, planJson],
  [/^Ты — копирайтер прямых продаж/, copyJson],
  [/^Ты — арт-директор/, promptsJson],
  [/^Ты — Frontend Developer/, pageJson],
  [/^Ты — ревизор лендинга/, verdictJson],
  // роль fix (human-fix в ревью): патч в CSS — проверяет overrides.css + пересборку
  [/^Ты чинишь один дефект/, { css: "h1{font-size:64px}", html: "", hide: "", note: "h1 крупнее" }],
];
let call = 0;
const answersLog: string[] = [];

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url?.endsWith("/credits")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ data: { total_credits: 10, total_usage: 3 } }));
    }
    let want: unknown = { critical: 0, defects: [], summary: "нет совпадения" };
    let promptText = "";
    try {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ content?: string | Array<{ text?: string }> }>;
      };
      const last = parsed.messages?.[parsed.messages.length - 1];
      promptText =
        typeof last?.content === "string"
          ? last.content
          : (last?.content?.[0]?.text ?? "");
    } catch {
      /* тело не JSON — останется дефолтный ответ */
    }
    for (const [i, [re, a]] of answers.entries()) if (re.test(promptText)) { want = a; answersLog.push(`#${i} ` + promptText.slice(0, 22).replace(/\n/g, " ")); break; }
    call++;
    if (!answersLog.length || !answersLog[answersLog.length - 1].startsWith("#"))
      answersLog.push("#-none " + promptText.slice(0, 22).replace(/\n/g, " "));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(want) } }],
        usage: { prompt_tokens: 900, completion_tokens: 500 },
      }),
    );
  });
});

await new Promise<void>((r) => fake.listen(8799, "127.0.0.1", r));

// картинка: фейковый task-poll — отдаём маленький png сразу
const fakeImg = http.createServer((req, res) => {
  if (req.url?.includes("createTask")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ code: 200, data: { taskId: "t1" } }));
  }
  if (req.url?.includes("recordInfo")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({
        data: {
          taskStatus: "success",
          resultUrls: JSON.stringify(["http://127.0.0.1:8798/img.png"]),
        },
      }),
    );
  }
  // скачивание результата
  res.writeHead(200, { "content-type": "image/png" });
  res.end(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
});
await new Promise<void>((r) => fakeImg.listen(8798, "127.0.0.1", r));

process.env["BUILDER_SMOKE_KEY"] = "test";
const settings = {
  projectsRoot: projRoot,
  port: 8711,
  webPort: 5173,
  openBrowserOnStart: false,
  connections: [
    {
      id: "fake",
      name: "Fake LLM",
      kind: "llm",
      baseUrl: "http://127.0.0.1:8799",
      protocol: "openai-chat",
      auth: { mode: "env", ref: "BUILDER_SMOKE_KEY" },
      models: [{ id: "fake-1" }],
      limit: { mode: "api", endpoint: "/credits" },
      enabled: true,
      priority: 1,
    },
    {
      id: "fakeimg",
      name: "Fake Image",
      kind: "image",
      baseUrl: "http://127.0.0.1:8798",
      protocol: "task-poll",
      auth: { mode: "env", ref: "BUILDER_SMOKE_KEY" },
      models: [{ id: "z-image" }],
      limit: { mode: "manual", unlimited: true },
      enabled: true,
      priority: 1,
    },
  ],
  selection: {
    codeCopy: { connection: "fake", model: "fake-1" },
    image: { connection: "fakeimg", model: "z-image" },
    imageMode: "api",
  },
  roleParams: {
    code: { temperature: 0.2, maxTokens: 16000 },
    copy: { temperature: 0.8, maxTokens: 4000 },
    plan: { temperature: 0.4, maxTokens: 4000 },
    fix: { temperature: 0.2, maxTokens: 4000 },
  },
  lanes: { llm: 2, image: 4, browser: 1 },
  gates: { afterPlan: process.argv.includes("--gate"), afterCopy: false, afterImages: false },
  maxFixRounds: 1,
  requireVision: "warn",
};
const NO_IMG = process.argv.includes("--noimg");
if (NO_IMG) {
  settings.connections = settings.connections.filter((c) => c.kind !== "image");
  settings.selection.image = { connection: "none", model: null };
}
const settingsPath = path.join(tmp, "settings.json");
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
process.env["BUILDER_SETTINGS"] = settingsPath;
// settings.cached уже мог быть reading ROOT/settings.json — резолв идём через env выше

fs.writeFileSync(
  path.join(dir, "brief.json"),
  JSON.stringify({
    mode: "white",
    language: "ru",
    brand: "Потолки",
    audience: "владельцы квартир",
    ctaPrimary: "Вызвать замерщик",
    tone: "деловой",
    sections: [],
    city: "Казань",
    niche: "натяжные потолки",
    headline: "Потолок за один день",
    palette: { bg: "#FFFFFF", accent: "#0F62FE" },
    php: false,
    phone: "+7 843 000-00-00",
  }),
);

const { createRun } = await import("../packages/server/src/orchestrator/run-manager.ts");
const events: string[] = [];
const handle = createRun(projId);
handle.subscribe((e) => events.push(`${e.t} ${"task" in e ? e.task : ""} ${"state" in e ? e.state : ""}`));

// --gate: прогон встаёт в awaiting-gate; закрываем его так же, как UI кнопкой
// «Поехали» (cmd=skip-gate), — иначе тест будет висеть до дедлайна.
if (process.argv.includes("--gate")) {
  handle.subscribe((e) => {
    if (e.t === "gate.open") setTimeout(() => handle.command("skip-gate"), 200);
  });
}

// новый терминальный путь: зелёный вердикт = review, а не done. Смоук прогоняет
// весь ревью-цикл: human-fix (та же фейковая модель, роль fix) → возврат в review
// → deliver (копия + zip во временную папку) → done
const OUT = path.join(tmp, "out");
let step: "first" | "fixed" | "done" = "first";
let fixNote = "";
handle.subscribe((e) => {
  if (e.t === "run.state" && e.state === "review") {
    if (step === "first") {
      step = process.argv.includes("--nohuman") ? "fixed" : step;
      setTimeout(
        () => handle.command(process.argv.includes("--nohuman") ? "deliver" : "human-fix", process.argv.includes("--nohuman") ? OUT : "Заголовок h1 сделай крупнее"),
        200,
      );
      return;
    }
    if (step === "fixed") {
      step = "done";
      setTimeout(() => handle.command("deliver", OUT), 200);
    }
    return;
  }
  const id = String((e as { task?: string }).task ?? "");
  if (!id.startsWith("human-fix")) return;
  if (e.t === "task.done") {
    step = "fixed";
    fixNote = `OK: ${JSON.stringify((e as { usage?: unknown }).usage ?? "")}`;
  }
  if (e.t === "task.error") {
    step = "fixed";
    fixNote = `✕ ${(e as { message?: string }).message}`;
  }
});

const deadline = Date.now() + 180_000;
const failReasons: string[] = [];
// preview/ после выгрузки чистится, поэтому снимок проверок копируем сразу
// после съёмки — иначе итоговая сверка видит «файла нет» у успешного прогона
const checksKept = path.join(tmp, "checks-r0.json");
const shotsSeen: number[] = [];
handle.subscribe((e) => {
  if (e.t === "task.error")
    failReasons.push(`${String((e as { task?: string }).task)}: ${(e as { message?: string }).message}`);
});
handle.subscribe((e) => {
  if (e.t === "task.done" && (e as { task?: string }).task === "shoot:r0") {
    try {
      fs.copyFileSync(path.join(dir, "preview", "checks-r0.json"), checksKept);
      const c = JSON.parse(fs.readFileSync(checksKept, "utf8")) as {
        screenshots?: Array<{ breakpoint: number }>;
      };
      shotsSeen.push(...(c.screenshots ?? []).map((s) => s.breakpoint));
    } catch {
      /* съёмка не оставила файла — будет видно в итоговой сверке */
    }
  }
});
while (Date.now() < deadline) {
  if (["done", "failed", "needs_human", "cancelled", "paused"].includes(handle.status)) break;
  await new Promise((r) => setTimeout(r, 500));
}
fake.close();
fakeImg.close();

console.log("=== статус:", handle.status);
if (failReasons.length) console.log("=== ошибки:\n  " + failReasons.join("\n  ").slice(0, 1500));
console.log("=== ответы модели:", call, answersLog.join(" | "));
console.log(
  "=== события:\n" +
    events
      .filter((l, i, a) => a.indexOf(l) === i)
      .map((l) => "  " + l)
      .join("\n"),
);

const dist = path.join(dir, "dist", "index.html");
// preview/ выгруженный проект чистит (тяжёлые артефакты), поэтому checks/вердикт
// фиксируются в момент прогона, а не в конце
const report = path.join(dir, "report.md");
for (const f of [dist, report]) {
  console.log(fs.existsSync(f) ? `OK  ${path.relative(ROOT, f)}` : `НЕТ ${f}`);
}
console.log(shotsSeen.length ? `OK  съёмка: ${shotsSeen.join(", ")} px` : "НЕТ проверок съёмки");
// ревью-цикл: overrides от human-fix, копия на «столе» смоука, zip внутри, placed.json
{
  const overrides = fs.existsSync(path.join(dir, "overrides.css")) || fs.existsSync(path.join(dir, "overrides.html"));
  const placed = path.join(OUT, projId);
  const placedJson = fs.existsSync(path.join(dir, "placed.json"));
  const copyOk = fs.existsSync(path.join(placed, "index.html"));
  const zipOk = fs.existsSync(path.join(placed, `${projId}.zip`));
  console.log(`=== human-fix: ${fixNote || "не запускался"}`);
  console.log(
    `=== ревью: overrides=${overrides ? "OK" : "нет (правка не применялась?)"} ` +
      `placed.json=${placedJson ? "OK" : "НЕТ"} копия=${copyOk ? "OK" : "НЕТ"} zip=${zipOk ? "OK" : "НЕТ"}`,
  );
  if (step !== "done") console.log("=== ⚠ ревью-цикл не доведён до deliver");
}
if (fs.existsSync(checksKept)) {
  let c: { screenshots?: Array<{ breakpoint: number }> } = {};
  try {
    c = JSON.parse(fs.readFileSync(checksKept, "utf8")) as typeof c;
  } catch (err) {
    console.log("checks-r0.json не читается:", (err as Error).message);
  }
  console.log("=== checks:", JSON.stringify(c, null, 1).slice(0, 1200));
  console.log(
    "скриншоты:",
    (c.screenshots ?? []).map((s) => s.breakpoint).join(","),
  );
}
if (fs.existsSync(dist)) {
  const html = fs.readFileSync(dist, "utf8");
  console.log("=== dist:", html.length, "байт; inline css:", /<style>/.test(html), "; assets:", (html.match(/assets\/img\/[\w.-]+/g) ?? []).join(","));
}
if (NO_IMG) {
  let man: {
    imagesDegraded?: boolean;
    images?: Array<{ status: string; file?: string }>;
  } = {};
  try {
    man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as typeof man;
  } catch (err) {
    console.log("manifest.json не читается:", (err as Error).message);
  }
  const allPlaceholder = (man.images ?? []).every(
    (i) => i.status === "placeholder" && i.file?.endsWith(".svg"),
  );
  console.log(
    "=== деградация графики:",
    man.imagesDegraded === true && allPlaceholder
      ? "OK (плейсхолдеры, прогон не встал)"
      : `ПРОБЛЕМА: ${JSON.stringify(man.images)}`,
  );
}
console.log("папка смоука:", tmp);
if (process.argv.includes("--keep")) console.log("не удаляем");
else fs.rmSync(tmp, { recursive: true, force: true });
