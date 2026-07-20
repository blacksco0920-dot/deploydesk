import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom does not implement element resize observation. Canvas libraries use it
// for geometry updates, so provide the browser contract without pretending to
// calculate layout in unit tests. Workflow business tests mock the canvas and
// the canvas itself is covered by a focused editor-contract test.
class TestResizeObserver implements ResizeObserver {
  disconnect() {}

  observe() {}

  unobserve() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
  writable: true,
});

afterEach(() => cleanup());
