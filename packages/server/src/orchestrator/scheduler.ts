/**
 * Scheduler — «тот, кто управляет запросами» (IDEAS раунд 9).
 * Знает граф задач, лимиты дорожек, шлюзы и цикл фиксов.
 * НЕ знает про OpenRouter/kie.ai — только про задачи и дорожки.
 */
import type { ErrorClass, OrchEvent } from "@builder/shared";
import type { RunResult, Task, TaskCtx } from "./types.ts";

export interface SchedulerOpts {
  lanes: { llm: number; image: number; browser: number; fs?: number };
  emit: (e: OrchEvent) => void;
  signal: AbortSignal;
  /** транспортные ретраи (класс transport — retry ×3, SPEC §6) */
  transportRetries?: number;
  /** самокоррекция contract-ошибки: 1 повтор с текстом ошибки */
  contractRetries?: number;
}

type TaskState = {
  task: Task<unknown>;
  done: boolean;
  result?: RunResult;
  started: boolean;
};

/** 500-шторм: 3 ошибки роли подряд по всей дорожке → пауза (глобальное правило юзера) */
const STORM_LIMIT = 3;

export class Scheduler {
  private states = new Map<string, TaskState>();
  private running = new Map<string, number>(); // lane → занятости
  private waiters: (() => void)[] = [];
  private consecutiveTransportErrors = 0;
  public stormPaused = false;
  /** пауза пережидается, а не убивает прогон: resume будит expectation ниже */
  private stormGate: Promise<void> = Promise.resolve();
  private stormRelease: (() => void) | null = null;

  constructor(private opts: SchedulerOpts) {}

  addAll(tasks: Task<unknown>[]): void {
    for (const task of tasks)
      this.states.set(task.id, { task, done: false, started: false });
  }

  /**
   * Отметить выполненной задачу, чей артефакт уже валиден, ИЛИ точку графа,
   * которая не является задачей (gate:plan пройден до сборки раунда).
   */
  markDone(id: string, result: RunResult): void {
    const st = this.states.get(id);
    if (st) {
      st.done = true;
      st.result = result;
      return;
    }
    this.states.set(id, { task: { id, lane: "fs", run: async () => result, dependsOn: [] }, done: true, result, started: true });
  }

  result(id: string): RunResult | undefined {
    return this.states.get(id)?.result;
  }

  /** «resume» из UI: снять шторм-паузу и вернуть отбракованные задачи в очередь. */
  resume(): void {
    if (!this.stormPaused) return;
    this.stormPaused = false;
    this.consecutiveTransportErrors = 0;
    // задачи, упавшие в шторм, уже «started» и больше не запускались бы:
    // снимаем флаг у всех неуспешных — после выздоровления сети они идут заново
    for (const st of this.states.values())
      if (!st.done && st.started && st.result?.ok === false) st.started = false;
    const release = this.stormRelease;
    this.stormRelease = null;
    release?.();
    this.wake();
  }

  private ready(): TaskState[] {
    const out: TaskState[] = [];
    for (const st of this.states.values()) {
      if (st.done || st.started) continue;
      const depsOk = st.task.dependsOn.every((d) => this.states.get(d)?.done);
      if (!depsOk) continue;
      if (st.task.enabled && !st.task.enabled(this)) continue;
      out.push(st);
    }
    // приоритет критического пути: у кого id без "image:" — выше
    return out.sort((a, b) => (a.task.id.startsWith("image:") ? 1 : 0) - (b.task.id.startsWith("image:") ? 1 : 0));
  }

  private laneFree(lane: string): boolean {
    const cap = (this.opts.lanes as Record<string, number>)[lane] ?? 1;
    return (this.running.get(lane) ?? 0) < cap;
  }

  /** Запускает всё готовое; резолвится, когда граф пуст или отменён. */
  async run(ctx: TaskCtx): Promise<{ completed: boolean; storm: boolean }> {
    for (;;) {
      if (ctx.signal.aborted) return { completed: false, storm: false };
      if (this.stormPaused) {
        // шторм больше не сворачивает прогон: ждём «resume», разморозив дорожки,
        // иначе незавершённые задачи оставались бы вечно занятые (зависание)
        await this.waitStormRelease(ctx.signal);
        if (ctx.signal.aborted) return { completed: false, storm: false };
        if (this.stormPaused) return { completed: false, storm: false }; // отмена паузы
        continue;
      }

      // условные рёбра: задача с готовыми зависимостями, но выключенная, — пропуск,
      // иначе граф встанет в тупик (export при красном вердикте прошлого раунда)
      for (const st of this.states.values()) {
        if (st.done || st.started) continue;
        if (!st.task.enabled) continue;
        if (!st.task.dependsOn.every((d) => this.states.get(d)?.done)) continue;
        if (st.task.enabled(this)) continue;
        st.done = true;
        st.result = { ok: true, value: undefined };
        this.opts.emit({
          t: "task.skip",
          task: st.task.id,
          at: new Date().toISOString(),
          reason: "условие выключено (условное ребро графа)",
        });
      }

      let launched = false;
      for (const st of this.ready()) {
        if (!this.laneFree(st.task.lane)) continue;
        st.started = true;
        launched = true;
        this.running.set(st.task.lane, (this.running.get(st.task.lane) ?? 0) + 1);
        void this.exec(st, ctx);
      }

      const anyRunning = (this.running.get("llm") ?? 0) + (this.running.get("image") ?? 0) + (this.running.get("browser") ?? 0) + (this.running.get("fs") ?? 0) > 0;
      const allDone = [...this.states.values()].every((s) => s.done);
      if (allDone) return { completed: true, storm: false };
      if (!launched && !anyRunning) {
        // тупик: готовности нет, работать некому (отключённая задача или цикл без enabled)
        return { completed: false, storm: false };
      }
      await new Promise<void>((res) => {
        this.waiters.push(res);
        const nudge = () => {
          const w = this.waiters.shift();
          w?.();
        };
        // любое завершение разбудит цикл: пересобрать waiters просто
        const prev = this.wake;
        this.wake = () => {
          prev();
          nudge();
        };
      });
    }
  }

  private wake: () => void = () => {};

  /**
   * Переждать шторм-паузу. Размораживаем все дорожки: трогать счётчики
   * запущенных задач нельзя — они доделаются сами и позовут release().
   */
  private waitStormRelease(signal: AbortSignal): Promise<void> {
    this.running.clear();
    this.opts.emit({ t: "run.state", state: "paused", at: new Date().toISOString() });
    this.stormGate = new Promise<void>((res) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        this.stormRelease = null;
        res();
      };
      this.stormRelease = done;
      signal.addEventListener("abort", done, { once: true });
    });
    // разбудить цикл: он мог уже ждать освобождения шторма
    this.wake();
    return this.stormGate;
  }

  private async exec(st: TaskState, ctx: TaskCtx): Promise<void> {
    const { task } = st;
    const retriesT = this.opts.transportRetries ?? 3;
    const retriesC = this.opts.contractRetries ?? 1;
    this.opts.emit({ t: "task.start", task: task.id, at: new Date().toISOString() });

    let lastErr = { klass: "fatal" as ErrorClass, message: "не выполнено" };
    for (let attempt = 0; attempt <= retriesT + retriesC; attempt++) {
      if (ctx.signal.aborted) break;
      try {
        const r = await task.run(ctx);
        if (r.ok) {
          st.done = true;
          st.result = r;
          this.consecutiveTransportErrors = 0;
          this.opts.emit({
            t: "task.done", task: task.id,
            at: new Date().toISOString(),
            usage: r.usage,
          });
          this.release(task.lane);
          return;
        }
        lastErr = r.error ?? lastErr;
      } catch (err) {
        const e = err as Error & { klass?: ErrorClass };
        lastErr = { klass: e.klass ?? "transport", message: e.message };
      }
      // разбор класса ошибки (SPEC §6): transport — ретраи; contract — 1 самокоррекция;
      // quota/fatal — выход, решение принимает RunManager (fallback/пауза/needs_human)
      if (lastErr.klass === "quota" || lastErr.klass === "fatal") break;
      if (lastErr.klass === "transport") {
        // шторм считает НЕ попытки одной задачи: 3 ретрая задачи-судьи это один
        // сбой сети, а не «провайдер лёг». Счётчик растёт только когда задача
        // окончательно падает по транспорту (см. выход из цикла) — иначе
        // единственная неудачная задача пожирала весь бюджет ретраев и
        // ставила на паузу весь прогон на первом же «fetch failed»
        if (this.consecutiveTransportErrors >= STORM_LIMIT) {
          this.stormPaused = true;
          break;
        }
        await sleep(Math.min(1000 * 2 ** attempt, 15_000)); // экспоненциально
        continue;
      }
      if (attempt > retriesT) break; // contract: самокоррекцию уже дали один раз
      continue;
    }

    st.result = { ok: false, error: lastErr };
    if (lastErr.klass === "transport") this.consecutiveTransportErrors++;
    this.opts.emit({
      t: "task.error", task: task.id,
      at: new Date().toISOString(),
      klass: lastErr.klass, message: lastErr.message,
    });
    this.release(task.lane);
  }

  private release(lane: string): void {
    this.running.set(lane, Math.max(0, (this.running.get(lane) ?? 1) - 1));
    this.wake();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
