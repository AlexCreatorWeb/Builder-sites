/**
 * Граф прогона (SPEC §6). Общий для White/Black — режимы отличаются
 * параметрами ролей и путями экспорта, а не формой графа.
 *
 * brief → plan → ⛔gate → (copy ∥ image-prompts→imgs[N] ∥ code)
 *        → assemble → shoot → judge → [fix ≤N → shoot → judge]* → export → report
 */
import type { Defect, RunManifest, SitePlan } from "@builder/shared";
import type { RunResult, Task } from "./types.ts";

export interface GraphInput {
  projectId: string;
  plan: SitePlan;
  manifest: RunManifest;
  /** сколько картинок реально нужно (imageMode none/manual — пусто) */
  imageSlugs: string[];
  fixRound: number; // 0 = первая сборка
  /** дефекты прошлого вердикта: при fixRound>0 рождают задачи fix:<id> */
  defects?: Defect[];
  /** рисовать export/report в этом раунде (красный вердикт или последний раунд) */
  finalize?: (round: number) => boolean;
}

/**
 * Задачи одного раунда сборки. До gate (plan/gate) строит RunManager;
 * здесь — всё, что идёт после «Поехали».
 */
export function buildRoundTasks(
  input: GraphInput,
  run: TaskHelpers,
): Task<unknown>[] {
  const { plan, imageSlugs, fixRound, defects = [] } = input;
  const r = `r${fixRound}`;
  const gateId = "gate:plan";
  const tasks: Task<unknown>[] = [];

  // --- раунд фиксов: по задаче на дефект, патчи пишутся в build/fix-rN.*
  const onlyFixable = defects.filter((d) => d.severity === "critical" || d.severity === "major");
  const fixIds: string[] = [];
  if (fixRound > 0 && onlyFixable.length) {
    for (const d of onlyFixable) {
      const id = `fix:${r}:${d.id}`;
      fixIds.push(id);
      tasks.push(run.task(id, "llm", [gateId], () => run.fix(d)));
    }
  }

  // --- тексты, картинки и код нужны только в первом раунде: в раундах фиксов
  // они берутся с диска (copy.json, assets/img, build/page.json) и не зовут модели
  const imgIds: string[] = [];
  const firstRoundDeps: string[] = [];
  // страницы сайта: главная + вложенные (pageCount>1). Тексты и код каждой —
  // отдельная llm-задача, дорожки (lanes.llm) крутят их параллельно
  const pageSlugs = ["index", ...(plan.pages ?? []).map((pg) => pg.slug)];

  if (fixRound === 0) {
    for (const pg of pageSlugs) {
      const id = pg === "index" ? `copy:${r}` : `copy:${r}:${pg}`;
      tasks.push(run.task(id, "llm", [gateId], () => run.copyPage(pg)));
      firstRoundDeps.push(id);
    }

    // ветка картинок: сначала описания, затем N задач в дорожке image
    tasks.push(
      run.task("image-prompts", "llm", [gateId], () => run.imagePrompts(plan)),
    );
    for (const slug of imageSlugs) {
      const id = `image:${slug}`;
      imgIds.push(id);
      tasks.push(
        run.task(id, "image", ["image-prompts"], () => run.image(slug)),
      );
    }

    // ветка кода (vision и код — одна модель, разные роли-параметры):
    // каждая страница ждёт только свои тексты, поэтому стартует сразу как они готовы
    for (const pg of pageSlugs) {
      const copyId = pg === "index" ? `copy:${r}` : `copy:${r}:${pg}`;
      const codeId = pg === "index" ? `code:${r}` : `code:${r}:${pg}`;
      tasks.push(run.task(codeId, "llm", [gateId, copyId], () => run.codePage(pg)));
      firstRoundDeps.push(codeId);
    }
    firstRoundDeps.push(...imgIds);
  }

  // --- сборка: плейсхолдер картинки = валидный успех, он не валит раунд
  const assembleDeps =
    fixIds.length > 0 ? fixIds : fixRound === 0 ? firstRoundDeps : [];
  tasks.push(
    run.task(`assemble:${r}`, "fs", assembleDeps, () => run.assemble()),
  );

  // --- съёмка и вердикт
  tasks.push(
    run.task(`shoot:${r}`, "browser", [`assemble:${r}`], () => run.shoot()),
  );
  tasks.push(
    run.task(`judge:${r}`, "llm", [`shoot:${r}`], () => run.judge()),
  );

  // --- экспорт и отчёт: только когда раунд последний или вердикт зелёный
  const exportId = `export:${r}`;
  const reportId = `report:${r}`;
  tasks.push(run.task(exportId, "fs", [`judge:${r}`], () => run.exportSite()));
  tasks.push(run.task(reportId, "fs", [exportId], () => run.report()));
  const finalize = input.finalize ?? ((round: number) => round > 0);
  const gateFinalize = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (t) t.enabled = () => finalize(fixRound);
  };
  gateFinalize(exportId);
  gateFinalize(reportId);

  return tasks;
}

/** Минимальная поверхность, которую RunManager подкладывает под задачи. */
export interface TaskHelpers {
  task<T>(
    id: string,
    lane: Task<T>["lane"],
    dependsOn: string[],
    run: () => Promise<RunResult<T>>,
  ): Task<T>;
  copyPage: (pageSlug: string) => Promise<RunResult<unknown>>;
  imagePrompts: (plan: SitePlan) => Promise<RunResult<unknown>>;
  image: (slug: string) => Promise<RunResult<string>>;
  codePage: (pageSlug: string) => Promise<RunResult<unknown>>;
  assemble: () => Promise<RunResult<unknown>>;
  shoot: () => Promise<RunResult<unknown>>;
  judge: () => Promise<RunResult<unknown>>;
  fix: (defect: Defect) => Promise<RunResult<unknown>>;
  exportSite: () => Promise<RunResult<unknown>>;
  report: () => Promise<RunResult<unknown>>;
}
