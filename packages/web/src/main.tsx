import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import "./styles.css";

/**
 * Белый экран был самой дорогой поломкой витрины: Vite на этой машине читает
 * файл в момент записи и отдаёт пустой трансформ, React падает на
 * «does not provide an export named 'default'» — и юзер видит ПУСТУЮ страницу
 * без единой зацепки, пока не перезагрузится (а файл дохнет минуты).
 * Граница показывает что случилось и даёт кнопку перезагрузки.
 */
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot-fail">
        <h2>Витрина не собралась</h2>
        <p>
          {String(this.state.error.message || this.state.error).slice(0, 300)}
        </p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          ⟳ Перезагрузить
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);
