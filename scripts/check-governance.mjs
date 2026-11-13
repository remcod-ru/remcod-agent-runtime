import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const textExtensions = new Set([
  "",
  ".cjs",
  ".env",
  ".example",
  ".cts",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const forbiddenLicenses = [
  "AGPL",
  "BSL-1.1",
  "BUSL-1.1",
  "SSPL",
  "BUSINESS SOURCE",
  "COMMONS CLAUSE",
  "POLYFORM",
];
const allowedCoreBareSpecifiers = new Set([
  "@remcod/protocol",
  "@remcod/testing",
  "@remcod/tools",
  "@opentelemetry/api",
  "@vitest/coverage-v8",
  "eslint",
  "prettier",
  "typescript",
  "vitest",
  "zod",
]);

function parseArguments(argv) {
  let scanRoot = process.cwd();
  let checkLicenses = false;
  let licenseReportPath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      scanRoot = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argv[index] === "--licenses") {
      checkLicenses = true;
    } else if (argv[index] === "--license-report") {
      licenseReportPath = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return { checkLicenses, licenseReportPath, scanRoot };
}

async function listTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTextFiles(absolutePath)));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name)))
      files.push(absolutePath);
  }
  return files;
}

function isAllowedCoreBareSpecifier(name) {
  for (const allowed of allowedCoreBareSpecifiers) {
    if (name === allowed || name.startsWith(`${allowed}/`)) return true;
  }
  return false;
}

function isAllowedCoreImportSpecifier(name) {
  return (
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.startsWith("#") ||
    name.startsWith("node:") ||
    isAllowedCoreBareSpecifier(name)
  );
}

async function inspectCoreManifest(scanRoot, findings) {
  const manifestPath = path.join(scanRoot, "packages/core/package.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const dependencyGroup of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(manifest[dependencyGroup] ?? {})) {
        if (!isAllowedCoreBareSpecifier(name)) {
          findings.push(`forbidden core dependency: ${name}`);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function inspectFiles(scanRoot, findings) {
  const files = await listTextFiles(scanRoot);
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*["']?(?!\$\{|<|\{\{|REPLACE_|example\b|changeme\b)[^\s"'`]+/i,
    /\b(?:ghp|github_pat|glpat|sk)-[A-Za-z0-9_-]{10,}\b/,
  ];
  const importPattern =
    /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;

  for (const file of files) {
    const relativePath = path.relative(scanRoot, file);
    const content = await readFile(file, "utf8");
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        findings.push(`secret pattern: ${relativePath}`);
        break;
      }
    }

    if (
      relativePath.startsWith(`packages${path.sep}core${path.sep}`) &&
      sourceExtensions.has(path.extname(file))
    ) {
      for (const match of content.matchAll(importPattern)) {
        if (!isAllowedCoreImportSpecifier(match[1])) {
          findings.push(
            `forbidden core import: ${match[1]} in ${relativePath}`,
          );
        }
      }
    }
  }
}

async function inspectPackagePrivacy(scanRoot, findings) {
  const packagesDirectory = path.join(scanRoot, "packages");
  try {
    for (const entry of await readdir(packagesDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(
        packagesDirectory,
        entry.name,
        "package.json",
      );
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.private !== true)
          findings.push(`package is not private: packages/${entry.name}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectLicenseReport(report, findings) {
  if (typeof report !== "string" || report.trim() === "") {
    findings.push("invalid license report: empty input");
    return;
  }

  let decoded;
  try {
    decoded = JSON.parse(report);
  } catch {
    findings.push("invalid license report: malformed JSON");
    return;
  }

  if (!isRecord(decoded) || Object.keys(decoded).length === 0) {
    findings.push("invalid license report: expected a non-empty object");
    return;
  }

  const licenseIdentifiers = [];
  for (const [licenseKey, packages] of Object.entries(decoded)) {
    if (
      licenseKey.trim() === "" ||
      !Array.isArray(packages) ||
      packages.length === 0
    ) {
      findings.push(
        "invalid license report: license groups must be non-empty arrays",
      );
      return;
    }
    licenseIdentifiers.push(licenseKey);

    for (const packageRecord of packages) {
      if (
        !isRecord(packageRecord) ||
        typeof packageRecord.name !== "string" ||
        packageRecord.name.trim() === "" ||
        typeof packageRecord.license !== "string" ||
        packageRecord.license.trim() === "" ||
        !Array.isArray(packageRecord.versions) ||
        packageRecord.versions.length === 0 ||
        packageRecord.versions.some(
          (version) => typeof version !== "string" || version.trim() === "",
        )
      ) {
        findings.push("invalid license report: invalid package record");
        return;
      }
      licenseIdentifiers.push(packageRecord.license);
    }
  }

  const normalizedIdentifiers = licenseIdentifiers.map((license) =>
    license.toUpperCase(),
  );
  for (const license of forbiddenLicenses) {
    if (
      normalizedIdentifiers.some((identifier) => identifier.includes(license))
    ) {
      findings.push(`forbidden dependency license: ${license}`);
    }
  }
}

function inspectLicenses(scanRoot, findings) {
  // Windows cannot spawn the bare "pnpm" shim without a shell, so the command is
  // routed through the command interpreter without passing shell:true (which
  // Node deprecates for unescaped argument lists).
  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd licenses list --json"]
      : ["licenses", "list", "--json"];
  const result = spawnSync(command, args, {
    cwd: scanRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    findings.push(
      `license audit command failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return;
  }
  inspectLicenseReport(result.stdout, findings);
}

const { checkLicenses, licenseReportPath, scanRoot } = parseArguments(
  process.argv.slice(2),
);
const findings = [];
await inspectCoreManifest(scanRoot, findings);
await inspectFiles(scanRoot, findings);
await inspectPackagePrivacy(scanRoot, findings);
if (checkLicenses) inspectLicenses(scanRoot, findings);
if (licenseReportPath) {
  try {
    inspectLicenseReport(await readFile(licenseReportPath, "utf8"), findings);
  } catch (error) {
    findings.push(
      `invalid license report: unable to read (${typeof error?.code === "string" ? error.code : "READ_ERROR"})`,
    );
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log("governance checks passed");
}
