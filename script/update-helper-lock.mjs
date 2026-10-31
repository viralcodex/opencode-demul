import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "src/native/helper-package.json"), "utf8"));
const cli = [
  await realpath(join(dirname(process.execPath), "npm")).catch(() => undefined),
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  process.env.npm_execpath,
].find((candidate) => candidate && basename(candidate) === "npm-cli.js" && existsSync(candidate));
assert(cli, "Run with a Node installation that includes npm.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "demule-helper-lock-")));
try {
  await writeFile(join(temporary, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      cli,
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--include=optional",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: temporary, stdio: "inherit" },
  );
  const lock = JSON.parse(await readFile(join(temporary, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  const native = lock.packages["node_modules/node-datachannel"];
  for (const [name, version] of Object.entries(native.optionalDependencies)) {
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      version,
      `Missing native optional package ${name}`,
    );
  }
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert(pkg.version && pkg.resolved && pkg.integrity, `Incomplete locked package ${path}`);
  }
  await writeFile(join(root, "src/native/helper-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `Locked ${Object.keys(lock.packages).length - 1} helper packages, including every native optional platform.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
