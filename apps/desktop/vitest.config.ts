import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // The former App suite encodes the archived release-center and mandatory
    // staging/production product contract. Keep the file as migration evidence
    // while the current contract is guarded by App.current and deployment-path
    // acceptance tests.
    exclude: [...configDefaults.exclude, "src/App.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
