import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only pick up *.test.ts / *.spec.ts. The tests/e2e directory holds
    // manual scripts (e.g. test-payment.ts) that hit a running server —
    // not automated tests, so exclude it explicitly.
    exclude: ["node_modules", "dist", "tests/e2e/**"],
  },
});
