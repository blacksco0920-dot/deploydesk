import React from "react";
import ReactDOM from "react-dom/client";
import "./style.css";

function App() {
  return (
    <main>
      <span>development / staging / production</span>
      <h1>DeployDesk 示例已运行</h1>
      <p>这个页面来自 Vite 静态容器，API 健康端点位于 /api/health。</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
