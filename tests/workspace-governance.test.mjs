import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runLicenseReportFixture(report) {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "remcod-license-report-"),
  );
  try {
    const reportPath = path.join(fixture, "licenses.json");
    await writeFile(reportPath, report);
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/check-governance.mjs"),
        "--root",
        fixture,
        "--license-report",
        reportPath,
      ],
      { encoding: "utf8" },
    );
    return {
      output: `${result.stdout}\n${result.stderr}`,
      status: result.status,
    };
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}

function productionLicenseEntry(license) {
  return {
    name: "license-fixture",
    versions: ["1.0.0"],
    paths: ["/fixture/license-fixture"],
    license,
  };
}

test("the complete target layout is present", async () => {
  const directories = [
    "apps/dev-console",
    "packages/protocol",
    "packages/core",
    "packages/runtime",
    "packages/store-postgres",
    "packages/scheduler",
    "packages/event-bus",
    "packages/goals",
    "packages/task-graph",
    "packages/tools",
    "packages/model-router",
    "packages/providers",
    "packages/mcp",
    "packages/policy",
    "packages/secrets",
    "packages/memory",
    "packages/browser",
    "packages/computer",
    "packages/multi-agent",
    "packages/observability",
    "packages/testing",
    "packages/sdk",
    "docs/architecture",
    "docs/concepts",
    "docs/guides",
    "docs/reference",
    "docs/adr",
    "examples/basic-agent",
    "examples/durable-agent",
    "examples/browser-agent",
    "examples/supervisor-workers",
    "examples/compatibility-adapter",
  ];

  await Promise.all(
    directories.map((directory) => access(path.join(root, directory))),
  );
  assert.equal(directories.length, 32);
});

test("workspace manifests pin the toolchain and keep packages private", async () => {
  const rootManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(rootManifest.private, true);
  assert.equal(rootManifest.packageManager, "pnpm@11.24.0");
  assert.deepEqual(rootManifest.engines, { node: ">=24.15.0 <25" });
  assert.equal(
    (await readFile(path.join(root, ".node-version"), "utf8")).trim(),
    "24.15.0",
  );

  for (const packageName of [
    "protocol",
    "core",
    "runtime",
    "model-router",
    "tools",
    "testing",
    "sdk",
  ]) {
    const manifest = JSON.parse(
      await readFile(
        path.join(root, "packages", packageName, "package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.name, `@remcod/${packageName}`);
    assert.equal(manifest.private, true);
  }
});

test("Vitest measures source and excludes generated dist from tests and coverage", async () => {
  const configUrl = pathToFileURL(path.join(root, "vitest.config.mjs"));
  const { default: config } = await import(configUrl.href);
  assert.ok(config.test.exclude.includes("**/dist/**"));
  assert.ok(config.test.coverage.exclude.includes("**/dist/**"));
  assert.deepEqual(config.test.coverage.include, [
    "packages/*/src/**/*.{ts,tsx}",
    "packages/runtime/transport/**/*.{ts,tsx}",
  ]);
});

test("governance CLI allows the core AnyTool dependency and type import", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "remcod-tools-import-"));
  try {
    await mkdir(path.join(fixture, "packages/core/src"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/core/package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@remcod/tools": "workspace:*" },
      }),
    );
    await writeFile(
      path.join(fixture, "packages/core/src/index.ts"),
      'import type { AnyTool } from "@remcod/tools";\nexport type Tool = AnyTool;\n',
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI does not parse package exports import keys as source imports", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "remcod-exports-import-"),
  );
  try {
    await mkdir(path.join(fixture, "packages/core"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/core/package.json"),
      JSON.stringify({
        private: true,
        exports: {
          ".": {
            import: "./dist/index.js",
            types: "./dist/index.d.ts",
          },
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI rejects a forbidden core dependency", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "remcod-governance-"));
  try {
    await mkdir(path.join(fixture, "packages/core"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/core/package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@external/runtime-sdk": "1.0.0" },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /forbidden core dependency/i);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI rejects an unknown vendor dependency in core", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "remcod-unknown-dependency-"),
  );
  try {
    await mkdir(path.join(fixture, "packages/core"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/core/package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@unapproved/model-sdk": "1.0.0" },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /forbidden core dependency/i,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /@unapproved\/model-sdk/,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI rejects a committed secret value", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "remcod-secret-"));
  try {
    const fakeSecret = ["sk", "test", "not", "a", "real", "key"].join("-");
    await writeFile(
      path.join(fixture, "leaked.env"),
      `EXAMPLE_API_KEY=${fakeSecret}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /secret pattern/i);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI rejects a cloud-vendor side-effect import in core", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "remcod-side-effect-"));
  try {
    await mkdir(path.join(fixture, "packages/core/src"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/core/package.json"),
      JSON.stringify({ private: true }),
    );
    await writeFile(
      path.join(fixture, "packages/core/src/index.ts"),
      'import "@external/storage-sdk";\n',
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /forbidden core import/i,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /@external\/storage-sdk/,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI rejects an unknown vendor side-effect import in core", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "remcod-unknown-import-"),
  );
  try {
    await mkdir(path.join(fixture, "packages/core/src"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/core/package.json"),
      JSON.stringify({ private: true }),
    );
    await writeFile(
      path.join(fixture, "packages/core/src/index.ts"),
      'import "@unapproved/model-sdk";\n',
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-governance.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /forbidden core import/i,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /@unapproved\/model-sdk/,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("governance CLI rejects decoded BUSL-1.1 license identifiers", async (context) => {
  const cases = [
    [
      "production-shaped identifier",
      JSON.stringify({ "BUSL-1.1": [productionLicenseEntry("BUSL-1.1")] }),
    ],
    [
      "escaped identifier",
      `{"BUSL\\u002D1.1":[${JSON.stringify(productionLicenseEntry("BUSL-1.1"))}]}`,
    ],
    [
      "escaped license value",
      JSON.stringify({ Custom: [productionLicenseEntry("BUSL-1.1")] }).replace(
        "BUSL-1.1",
        "BUSL\\u002D1.1",
      ),
    ],
  ];

  for (const [name, report] of cases) {
    await context.test(name, async () => {
      const result = await runLicenseReportFixture(report);
      assert.equal(result.status, 1);
      assert.match(result.output, /forbidden dependency license: BUSL-1\.1/i);
    });
  }
});

test("governance CLI fails closed on malformed or empty license reports", async (context) => {
  const cases = [
    ["empty input", ""],
    ["garbage", "not-json"],
    ["array", "[]"],
    ["null", "null"],
    ["empty object", "{}"],
    ["empty license group", JSON.stringify({ MIT: [] })],
    ["wrong group shape", JSON.stringify({ MIT: "MIT" })],
    ["wrong package shape", JSON.stringify({ MIT: [{ name: "fixture" }] })],
  ];

  for (const [name, report] of cases) {
    await context.test(name, async () => {
      const result = await runLicenseReportFixture(report);
      assert.equal(result.status, 1);
      assert.match(result.output, /invalid license report/i);
      assert.doesNotMatch(result.output, /\n\s+at .*check-governance/i);
    });
  }
});

test("governance CLI accepts a production-shaped MIT license report", async () => {
  const report = JSON.stringify({ MIT: [productionLicenseEntry("MIT")] });
  const result = await runLicenseReportFixture(report);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /governance checks passed/i);
});

test("legal and governance baseline documents clean implementation provenance", async () => {
  const requiredFiles = [
    "LICENSE",
    "NOTICE",
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "docs/provenance.md",
    "docs/architecture/overview.md",
    "docs/adr/0001-clean-implementation-boundary.md",
  ];
  await Promise.all(requiredFiles.map((file) => access(path.join(root, file))));

  const license = await readFile(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  const provenance = await readFile(
    path.join(root, "docs/provenance.md"),
    "utf8",
  );
  assert.match(provenance, /clean-room/i);
  assert.match(provenance, /dependency and license review/i);
  assert.match(provenance, /third-party source code/i);
  const decision = await readFile(
    path.join(root, "docs/adr/0001-clean-implementation-boundary.md"),
    "utf8",
  );
  assert.match(decision, /compatibility adapter/i);
  assert.match(decision, /not.*primary architecture/is);
});

test("reference PostgreSQL and CI are secretless and reproduce root gates", async () => {
  const compose = await readFile(path.join(root, "compose.yaml"), "utf8");
  assert.match(compose, /image: postgres:18-alpine/);
  assert.match(compose, /127\.0\.0\.1:\$\{POSTGRES_PORT:-5432\}:5432/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD\}/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*(?!\$\{)[^\s]+/);

  const envExample = await readFile(path.join(root, ".env.example"), "utf8");
  assert.deepEqual(envExample.trim().split("\n"), [
    "POSTGRES_DB=",
    "POSTGRES_USER=",
    "POSTGRES_PASSWORD=",
    "POSTGRES_PORT=",
  ]);

  const workflow = await readFile(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(workflow, /corepack enable/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm check/);
  assert.match(workflow, /pnpm legal:licenses/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("export smoke rejects manifest targets that do not exist", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "remcod-exports-"));
  try {
    await mkdir(path.join(fixture, "packages/example"), { recursive: true });
    await writeFile(
      path.join(fixture, "packages/example/package.json"),
      JSON.stringify({
        name: "@remcod/example",
        private: true,
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/smoke-exports.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /missing export target/i,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("export smoke loads valid self-reference and rejects a broken public import", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "remcod-public-import-"),
  );
  try {
    const brokenDirectory = path.join(fixture, "packages/broken");
    const validDirectory = path.join(fixture, "packages/valid");
    await mkdir(path.join(brokenDirectory, "dist"), { recursive: true });
    await mkdir(path.join(validDirectory, "dist"), { recursive: true });
    await writeFile(
      path.join(brokenDirectory, "package.json"),
      JSON.stringify({
        name: "@remcod/broken",
        private: true,
        type: "module",
        exports: { ".": "./dist/index.js" },
      }),
    );
    await writeFile(
      path.join(brokenDirectory, "dist/index.js"),
      "export const broken = ;\n",
    );
    await writeFile(
      path.join(validDirectory, "package.json"),
      JSON.stringify({
        name: "@remcod/valid-self-reference",
        private: true,
        type: "module",
        exports: {
          ".": {
            node: "./dist/node.js",
            default: "./dist/fallback.js",
          },
        },
      }),
    );
    await writeFile(
      path.join(validDirectory, "dist/node.js"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../loaded.txt", import.meta.url), "loaded");\nexport const loaded = true;\n',
    );
    await writeFile(
      path.join(validDirectory, "dist/fallback.js"),
      'throw new Error("wrong export condition");\n',
    );

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/smoke-exports.mjs"), "--root", fixture],
      { encoding: "utf8" },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /public import failed: @remcod\/broken/i);
    assert.doesNotMatch(
      output,
      /public import failed: @remcod\/valid-self-reference/i,
    );
    assert.doesNotMatch(output, new RegExp(fixture.replaceAll("/", "\\/")));
    assert.equal(
      await readFile(path.join(validDirectory, "loaded.txt"), "utf8"),
      "loaded",
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
