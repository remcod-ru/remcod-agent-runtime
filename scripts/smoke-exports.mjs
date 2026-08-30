import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseRoot(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === "--root") return path.resolve(argv[1]);
  throw new Error("Usage: smoke-exports.mjs [--root <directory>]");
}

function collectTargets(value, targets = []) {
  if (typeof value === "string") {
    if (value.startsWith("./")) targets.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, targets);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectTargets(item, targets);
  }
  return targets;
}

function sanitizeImportFailure(result, root, packageDirectory) {
  if (result.error) {
    return `${result.error.code ?? "IMPORT_PROCESS_ERROR"}: import process failed`;
  }

  let name = "IMPORT_ERROR";
  let code;
  let message = result.stderr.trim() || result.stdout.trim();
  try {
    const payload = JSON.parse(message);
    name = typeof payload.name === "string" ? payload.name : name;
    code = typeof payload.code === "string" ? payload.code : undefined;
    message = typeof payload.message === "string" ? payload.message : "";
  } catch {
    // The child contract is JSON, but keep an opaque sanitized fallback.
  }

  const sanitizedMessage = message
    .replaceAll(packageDirectory, "<package>")
    .replaceAll(root, "<root>")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/[^\x20-\x7e]/g, "")
    .slice(0, 240);
  const label = code ?? name;
  return sanitizedMessage ? `${label}: ${sanitizedMessage}` : label;
}

function probePublicImport(packageName, packageDirectory, root) {
  const probe = `
const specifier = process.argv[1];
try {
  await import(specifier);
} catch (error) {
  process.stderr.write(JSON.stringify({
    name: typeof error?.name === "string" ? error.name : "IMPORT_ERROR",
    code: typeof error?.code === "string" ? error.code : undefined,
    message: typeof error?.message === "string" ? error.message : "public import failed",
  }));
  process.exitCode = 1;
}
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", probe, packageName],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (result.status === 0) return undefined;
  return sanitizeImportFailure(result, root, packageDirectory);
}

const root = parseRoot(process.argv.slice(2));
const packagesDirectory = path.join(root, "packages");
const findings = [];
let targetCount = 0;
let importCount = 0;

try {
  for (const entry of await readdir(packagesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const packageDirectory = path.join(packagesDirectory, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(packageDirectory, "package.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    const targets = collectTargets(manifest.exports);
    for (const key of ["main", "module", "types", "typings"]) {
      collectTargets(manifest[key], targets);
    }
    let hasMissingTarget = false;
    for (const target of new Set(targets)) {
      targetCount += 1;
      try {
        await access(path.resolve(packageDirectory, target));
      } catch {
        hasMissingTarget = true;
        findings.push(
          `missing export target: ${manifest.name ?? entry.name} -> ${target}`,
        );
      }
    }

    if (!hasMissingTarget && targets.length > 0 && manifest.name) {
      importCount += 1;
      const failure = probePublicImport(manifest.name, packageDirectory, root);
      if (failure) {
        findings.push(`public import failed: ${manifest.name} -> ${failure}`);
      }
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log(
    `export smoke passed (${targetCount} targets, ${importCount} public imports)`,
  );
}
