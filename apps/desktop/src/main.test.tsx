import { StrictMode, type ReactElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const rootRender = vi.hoisted(() => vi.fn());
const semiReact19AdapterLoaded = vi.hoisted(() => vi.fn());
const semiBaseStylesLoaded = vi.hoisted(() => vi.fn());

vi.mock("@douyinfe/semi-ui/react19-adapter", () => {
  semiReact19AdapterLoaded();
  return {};
});

vi.mock("@douyinfe/semi-ui/lib/es/_base/base.css", () => {
  semiBaseStylesLoaded();
  return {};
});

vi.mock("react-dom/client", () => {
  const createRoot = () => ({ render: rootRender });
  return {
    createRoot,
    default: { createRoot },
  };
});

vi.mock("./App", () => ({
  default: () => <div>ABCDeploy</div>,
}));

describe("desktop application root", () => {
  beforeAll(async () => {
    await import("./main");
  });

  it("does not wrap FlowGram in development StrictMode", () => {
    expect(rootRender).toHaveBeenCalledTimes(1);
    const root = rootRender.mock.calls[0]?.[0] as ReactElement;
    expect(root.type).not.toBe(StrictMode);
  });

  it("loads the Semi React 19 compatibility adapter and shared base styles before rendering", () => {
    expect(semiReact19AdapterLoaded).toHaveBeenCalledTimes(1);
    expect(semiBaseStylesLoaded).toHaveBeenCalledTimes(1);
    expect(rootRender).toHaveBeenCalledTimes(1);
  });
});
