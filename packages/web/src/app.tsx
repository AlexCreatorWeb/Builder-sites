import { useState } from "react";
import type { Mode } from "@builder/shared";
import BriefForm from "./brief-form";
import ModelsPanel from "./models-panel";
import NetIndicator from "./net-indicator";
import ProjectsPanel from "./projects-panel";

/**
 * Витрина. Тема одна — тёмная (светлая упразднена).
 */
export default function App() {
  // режим лендинга — выбор юзера, живёт в сайдбаре двумя табами (SPEC §9)
  const [mode, setMode] = useState<Mode>("white");

  return (
    <div className="app theme-dark">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            {"</>"}
          </span>
          <span className="brand-name">Builder</span>
        </div>

        <div className="modes" role="tablist" aria-label="Что генерим">
          <button
            role="tab"
            aria-selected={mode === "white"}
            className={`mode ${mode === "white" ? "on" : ""}`}
            onClick={() => setMode("white")}
            title="Светлая серия: многостраничник, чистая типографика, много воздуха"
          >
            <i className="dot white" aria-hidden />
            White
          </button>
          <button
            role="tab"
            aria-selected={mode === "black"}
            className={`mode ${mode === "black" ? "on" : ""}`}
            onClick={() => setMode("black")}
            title="Чёрная серия: преленд под трафик, красный акцент, экраны с caption'ами"
          >
            <i className="dot black" aria-hidden />
            Black
          </button>
        </div>

        {/* сюда встал индикатор связи: раньше на этом месте висел список
            прогонов, а статус подключения — ровно та информация, которая
            нужна перед тем, как что-то гонять */}
        <div className="sidebar-sig">
          <NetIndicator />
        </div>

        {/* сюда же переехали проекты: готовое забирают не только в момент прогона */}
        <ModelsPanel />

        <ProjectsPanel />

        <div className="sidebar-foot">
          <span className="ver">0.1 · локально</span>
        </div>
      </aside>

      <div className="main">
        {/* конструктор — первое, что видит юзер: при выборе сборки hero целиком
            отдаётся полям режима, заголовок-витрина убран (только место занимал) */}
        <BriefForm mode={mode} />

        <section className="strip">
          <Card
            title="Единственный шлюз"
            text="План приходит до генерации: секции, палитра, slug картинок, смета. Правите — и только потом токены."
          />
          <Card
            title="Картинки не блокируют"
            text="Нет image-модели или кончилась квота — прогон идёт с плейсхолдерами, потом догоняет их одной кнопкой."
          />
          <Card
            title="Проверки, а не вера"
            text="console, переполнение, пустые блоки, анкоры, битые ссылки, скриншоты 375/768/1280 + вердикт vision."
          />
        </section>
      </div>
    </div>
  );
}

function Card({ title, text }: { title: string; text: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

