import {
  configDefaults,
  coverageConfigDefaults,
  defineConfig,
} from "vitest/config";

const sourceInclude = [
  "packages/*/src/**/*.{ts,tsx}",
  "packages/runtime/transport/**/*.{ts,tsx}",
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "tests/workspace-governance.test.mjs",
    ],
    coverage: {
      provider: "v8",
      include: sourceInclude,
      exclude: [...coverageConfigDefaults.exclude, "**/dist/**"],
    },
  },
});
