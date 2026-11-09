/**
 * Куда попадать готовому проекту после генерации (выбор в брифе).
 *
 * Модель простая: у юзера может быть любой сервер (WAMP, OpenServer, nginx,
 * хостинг) или никакой. Поэтому генератор не знает про чужие серверы — он
 * складывает результат в папку, выбранную юзером, и кладёт рядом zip. Дальше
 * юзер сам переносит папку/архив на свой сервер.
 *
 * Вариантов два:
 *  - "here"   — остаться в мастерской (projects/<id>/export/), копия не нужна;
 *  - "folder" — любая папка на этой машине: выбрать в обозревателе (/api/fs),
 *               путь запоминается и в следующий раз предлагается пилюлей.
 * Пути живуть в settings.delivery — на другом компе их поправит конфиг, не код.
 * Windows-путь (`C:\dir`) принимается и переводится в mounted-путь WSL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Settings } from "./config.ts";

export type DeliveryKind = "here" | "desktop" | "folder" | "custom";

export interface DeliveryChoice {
  kind: DeliveryKind;
  /** для kind === "folder": папка (любая ОС-запись пути) */
  path?: string;
  /** класть рядом zip (по умолчанию да) */
  zip?: boolean;
}

export interface DestInfo {
  kind: DeliveryKind;
  /** ключ пилюли для UI: here | desktop | folder|<путь> */
  value?: string;
  label: string;
  /** куда реально попадёт проект; пусто — «остаться в projects/<id>/export» */
  dir: string;
  /** имя папки проекта, которое создадим в dir */
  sub: string;
  writable: boolean;
  note: string;
}

const MOUNT = "/mnt";

/** `C:\Users\User\Desktop` → `/mnt/c/Users/User/Desktop`; остальное как есть. */
export function winPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p.trim());
  if (!m) return p.trim();
  return path.posix.join(MOUNT, m[1].toLowerCase(), m[2].replace(/\\/g, "/").replace(/\/+$/, ""));
}

/**
 * Рабочий стол этой машины: Windows (через /mnt/c/Users), Linux (XDG-user-dirs,
 * в т.ч. локализованные «Рабочий стол»), macOS (~/Desktop). Пусто — не найден;
 * тогда пилюли «на рабочий стол» в UI просто не будет.
 */
export function desktopDir(): string {
  const home = os.homedir();
  // WSL: /mnt/c/Users/<user>/Desktop (единственный реальный юзер, не Public)
  try {
    const users = path.join(MOUNT, "c", "Users");
    const hit = fs
      .readdirSync(users, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^(public|default|default user|all users)$/i.test(e.name))
      .map((e) => path.join(users, e.name, "Desktop"))
      .find((d) => fs.existsSync(d));
    if (hit) return hit;
  } catch {
    /* не WSL */
  }
  const cands = new Set<string>();
  try {
    // Linux: XDG говорит настоящее имя, даже «Робочий стіл» / «Рабочий стол»
    const xdg = fs.readFileSync(path.join(home, ".config", "user-dirs.dirs"), "utf8");
    const m = /XDG_DESKTOP_DIR="?\$HOME\/([^"]+)"?/.exec(xdg);
    if (m) cands.add(path.join(home, m[1]));
  } catch {
    /* файла нет — пробуем типовые имена */
  }
  for (const n of ["Desktop", "Рабочий стол", "Робочий стіл"]) cands.add(path.join(home, n));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return "";
}

/**
 * Быстрые места для обозревателя: дом, рабочий стол, загрузки, диски.
 * Ничего из них не обязательно существует — наружу отдаём только существующие.
 */
export function quickDirs(): { label: string; dir: string }[] {
  const home = os.homedir();
  const out: { label: string; dir: string }[] = [];
  const seen = new Set<string>();
  const push = (label: string, dir: string) => {
    if (dir && fs.existsSync(dir) && !seen.has(dir)) {
      seen.add(dir);
      out.push({ label, dir });
    }
  };
  push("Домой", home);
  const desk = desktopDir();
  if (desk) push("Рабочий стол", desk);
  for (const sub of ["Downloads", "Загрузки", "Documents", "Документы"]) push(sub, path.join(home, sub));
  try {
    for (const name of fs.readdirSync(MOUNT, { withFileTypes: true })) {
      if (name.isDirectory() && /^[a-z]$/i.test(name.name)) push(`Диск ${name.name.toUpperCase()}:`, path.join(MOUNT, name.name));
    }
  } catch {
    /* не WSL — смонтированных дисков нет */
  }
  return out;
}

/** Содержимое папки для обозревателя: только подпапки + можно ли писать. */
export function browse(dir: string): {
  dir: string;
  parent: string | null;
  dirs: { name: string; writable: boolean }[];
  error?: string;
} {
  const resolved = winPath(dir || os.homedir());
  try {
    const dirs = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "ru"))
      .map((name) => ({ name, writable: isWritable(path.join(resolved, name)) }));
    return {
      dir: resolved,
      parent: path.dirname(resolved) === resolved ? null : path.dirname(resolved),
      dirs,
    };
  } catch (err) {
    return { dir: resolved, parent: null, dirs: [], error: (err as Error).message.slice(0, 160) };
  }
}

export function isWritable(dir: string): boolean {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Куда лечь: по выбору юзера. project — имя проекта (папка внутри выбранной). */
export function resolveDest(
  choice: DeliveryChoice,
  ctx: { project: string },
): DestInfo {
  const base: DestInfo = {
    kind: choice.kind,
    label: "",
    dir: "",
    sub: ctx.project,
    writable: true,
    note: "",
  };
  if (choice.kind === "desktop") {
    const d = desktopDir();
    base.label = "на рабочий стол";
    base.dir = d;
    base.writable = !!d && isWritable(d);
    base.note = d ? `${d}/${ctx.project}/ (проект + zip внутри)` : "рабочий стол не найден";
    return base;
  }
  if (choice.kind === "folder" || choice.kind === "custom") {
    const d = choice.path ? winPath(choice.path) : "";
    base.label = "выбранная папка";
    base.dir = d;
    base.writable = !!d && isWritable(d);
    base.note = d
      ? `${d}/${ctx.project}/ (проект + zip внутри)`
      : "выберите папку";
    return base;
  }
  base.kind = "here";
  base.label = "в генераторе";
  base.note = "проект остаётся в projects/" + ctx.project + "/export";
  return base;
}

/**
 * Список для UI: «в генераторе», «на рабочий стол» (если найден), сохранённая
 * папка и последние. Ключ value — чем UI различает пилюли: here, desktop,
 * folder|<путь>.
 */
export function deliveryOptions(
  s: Settings,
  ctx: { project: string },
): DestInfo[] {
  const opts: DestInfo[] = [resolveDest({ kind: "here" }, ctx)];
  const desk = desktopDir();
  if (desk) opts.push(resolveDest({ kind: "desktop" }, ctx));
  const seen = new Set<string>();
  const savedDir =
    s.delivery && (s.delivery.kind === "folder" || s.delivery.kind === "custom")
      ? winPath(s.delivery.path ?? "")
      : "";
  if (savedDir && savedDir !== desk && isWritable(savedDir)) {
    opts.push(resolveDest({ kind: "folder", path: savedDir }, ctx));
    seen.add(savedDir);
  }
  for (const d of (s.recentDirs ?? []).map(winPath)) {
    if (!d || seen.has(d) || d === desk) continue;
    if (!isWritable(d)) continue;
    seen.add(d);
    opts.push(resolveDest({ kind: "folder", path: d }, ctx));
    if (opts.length >= 5) break;
  }
  for (const o of opts) o.value = destValue(o);
  return opts;
}

/** value пилюли: здесь, на десктопе, или в конкретной папке. */
export function destValue(o: DestInfo): string {
  return o.kind === "folder" ? `folder|${o.dir}` : o.kind;
}

/** Запомнить папку: она становится сохранённой и попадает в recent. */
export function rememberDir(s: Settings, dir: string): void {
  const d = winPath(dir);
  if (!d) return;
  const recent = [d, ...(s.recentDirs ?? []).filter((x) => winPath(x) !== d)].slice(0, 6);
  s.recentDirs = recent;
}

/** Копия дерева (синхроном: прогон и так последовательный). */
export function copyTree(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * zip рядом с папкой: `zip` если есть, иначе python3 (его отсутствие — норма,
 * а архив для переноса на сервер нужен всегда).
 */
export function makeZip(dir: string, zipPath: string, rootName?: string): string | null {
  // перед сборкой стираем всё, что могло остаться по целевому пути: прошлый
  // сбойный прогон оставлял ПАПКУ с именем .zip.tmp, а rmSync без recursive
  // на директории бросает EISDIR и ронял весь экспорт
  fs.rmSync(zipPath, { recursive: true, force: true });
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  // rootName: внутри архива папка называется проектом, а не служебным export/
  const staged = rootName && rootName !== name ? path.join(parent, rootName) : "";
  if (staged) {
    fs.rmSync(staged, { recursive: true, force: true });
    fs.cpSync(dir, staged, { recursive: true });
  }
  const srcName = staged ? rootName! : name;
  const zip = spawnSync("zip", ["-qr", zipPath, srcName], { cwd: parent, encoding: "utf8" });
  // make_archive ВСЕГДА дописывает .zip: раньше для имени «x.zip.tmp» он
  //резал «.zip» в середине не там, где надо, и на столе вырастал хвост
  // «x.zip.tmp.zip». Основание = путь без финального .zip — ровно наш zipPath.
  const pyBase = /\.zip$/i.test(zipPath) ? zipPath.replace(/\.zip$/i, "") : zipPath;
  const py = spawnSync(
    "python3",
    ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1],'zip',sys.argv[2],sys.argv[3])",
      pyBase, parent, srcName],
    { encoding: "utf8" },
  );
  if (staged) fs.rmSync(staged, { recursive: true, force: true });
  // подстраховка от старых хвостов прошлых сбоев («...zip.tmp.zip»)
  fs.rmSync(`${zipPath}.zip`, { force: true });
  if (fs.existsSync(zipPath)) return null;
  return (py.stderr || py.stdout || py.error?.message || "zip не собран").trim().slice(0, 200);
}
