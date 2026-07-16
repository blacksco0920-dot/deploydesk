import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("accessibility styles", () => {
  it("keeps stronger semantic contrast when the operating system requests it", () => {
    expect(styles).toContain("@media (prefers-contrast: more)");
    expect(styles).toContain("--muted-foreground: #494946");
    expect(styles).toContain("--border: #92928b");
  });

  it("maps the design tokens to Windows forced-color system colors", () => {
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("--background: Canvas");
    expect(styles).toContain("--foreground: CanvasText");
    expect(styles).toContain("--focus: Highlight");
    expect(styles).toContain('.a11y-status-dot[data-status="active"]');
  });

  it("defines the informational surface used by version states", () => {
    expect(styles).toMatch(/--info-soft:\s*#[0-9a-f]{6}/i);
  });
});
