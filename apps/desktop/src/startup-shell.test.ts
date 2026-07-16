import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("desktop startup shell", () => {
  it("shows an immediate accessible status before React is ready", () => {
    expect(html).toContain('class="startup-shell" aria-live="polite"');
    expect(html).toContain("正在打开 ABCDeploy");
    expect(html).toContain("prefers-reduced-motion: reduce");
  });
});
