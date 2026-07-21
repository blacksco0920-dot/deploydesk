import "@douyinfe/semi-ui/react19-adapter";
import "@douyinfe/semi-ui/lib/es/_base/base.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ABCDeploy render failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--background)] p-8 text-[var(--foreground)]">
        <section className="w-full max-w-xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
          <h1 className="text-lg font-semibold">客户端页面没有正常打开</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
            已保留本机项目和部署记录。请重新打开客户端；如果仍然出现，可把下面的信息发给我们。
          </p>
          <pre className="mt-4 overflow-auto rounded-lg bg-[var(--muted)] p-3 text-xs leading-5">
            {this.state.error.message}
          </pre>
        </section>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // FlowGram 1.0.12 initializes its Inversify container inside a useMemo
  // calculator. React's development StrictMode invokes that calculator twice,
  // which loads FlowRendererContainerModule twice and makes
  // FlowRendererRegistry ambiguous. Keep the application root non-strict until
  // FlowGram moves container initialization to an idempotent lifecycle.
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
