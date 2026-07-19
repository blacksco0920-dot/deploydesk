import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tauriConfig from "../src-tauri/tauri.conf.json";

const configurationCenter = readFileSync(
  resolve(process.cwd(), "src/components/ConfigurationCenter.tsx"),
  "utf8",
);
const productWorkspace = readFileSync(
  resolve(process.cwd(), "src/components/ProductWorkspace.tsx"),
  "utf8",
);

describe("desktop window accessibility", () => {
  it("fits a 1440 × 960 display at 200% scaling", () => {
    const mainWindow = tauriConfig.app.windows[0];

    expect(mainWindow.minWidth).toBeLessThanOrEqual(720);
    expect(mainWindow.minHeight).toBeLessThanOrEqual(480);
    expect(mainWindow.width).toBeGreaterThanOrEqual(mainWindow.minWidth);
    expect(mainWindow.height).toBeGreaterThanOrEqual(mainWindow.minHeight);
  });

  it("collapses fixed desktop layouts at the minimum supported width", () => {
    const mainWindow = tauriConfig.app.windows[0];

    expect(mainWindow.minWidth).toBeLessThan(760);
    expect(configurationCenter).toContain("max-[760px]:hidden");
    expect(configurationCenter).toContain(
      "max-[760px]:grid-cols-[minmax(0,1fr)_auto]",
    );
    expect(productWorkspace).toContain("max-[760px]:grid-cols-2");
    expect(productWorkspace).toContain("max-[760px]:grid-cols-1");
    expect(productWorkspace).toContain("max-[760px]:flex-col");
    expect(productWorkspace).toContain("max-[760px]:flex-wrap");
  });

  it("keeps the four stable project sections available at narrow widths", () => {
    expect(productWorkspace).toContain('aria-label="项目导航"');
    expect(productWorkspace).toContain(
      '{ key: "overview", label: "发布中心" }',
    );
    expect(productWorkspace).toContain('{ key: "local", label: "在本机运行" }');
    expect(productWorkspace).toContain('{ key: "versions", label: "版本" }');
    expect(productWorkspace).toContain(
      '{ key: "settings", label: "项目设置" }',
    );
    expect(productWorkspace).toContain(
      "max-[760px]:grid max-[760px]:grid-cols-2",
    );
  });
});
