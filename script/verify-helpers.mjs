import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await realpath(await mkdtemp(join(tmpdir(), "demule-helpers-")));
const lock = JSON.parse(await readFile(join(root, "src/native/helper-lock.json"), "utf8"));
try {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      target: "node22",
      lib: {
        entry: join(root, "src/native/helpers.ts"),
        formats: ["es"],
        fileName: () => "helpers.mjs",
      },
      outDir: join(temporary, "harness"),
      rollupOptions: { external: [/^node:/u] },
    },
  });
  const { ensureHelpers, HELPER_LOCK_HASH } = await import(
    pathToFileURL(join(temporary, "harness/helpers.mjs")).href
  );
  const installedTrees = [];
  for (const name of ["first", "second"]) {
    const dir = join(temporary, name);
    const paths = await ensureHelpers(dir, 300_000, process.execPath);
    const installed = [];
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path) continue;
      const manifest = await readFile(join(dir, path, "package.json"), "utf8").catch(() => null);
      if (!manifest) {
        assert(pkg.optional, `Required locked package missing: ${path}`);
        continue;
      }
      assert.equal(
        JSON.parse(manifest).version,
        pkg.version,
        `Unexpected installed version: ${path}`,
      );
      installed.push(`${path}@${pkg.version}`);
    }
    installedTrees.push(installed.sort());
    assert.equal(
      (await readFile(join(dir, ".helper-lock.sha256"), "utf8")).trim(),
      HELPER_LOCK_HASH,
    );
    const native = createRequire(join(dir, "package.json"))("node-datachannel");
    assert.equal(typeof native.PeerConnection, "function", "The host native module must load.");
    native.cleanup?.();
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const previousPath = process.env[pathKey];
    process.env[pathKey] = join(temporary, "missing-toolchain");
    try {
      assert.deepEqual(
        await ensureHelpers(dir, 1, join(temporary, "missing-node")),
        paths,
        "Valid cached installs must work offline.",
      );
      await writeFile(join(dir, ".helper-lock.sha256"), "stale\n");
      await assert.rejects(
        ensureHelpers(dir, 1, join(temporary, "missing-node")),
        (error) => error.data?.code === "missing-prerequisite",
        "A stale cache must not be reused.",
      );
      await assert.rejects(
        readFile(join(dir, ".helper-lock.sha256"), "utf8"),
        (error) => error.code === "ENOENT",
        "A failed reinstall must not leave a validity fingerprint.",
      );
    } finally {
      if (previousPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = previousPath;
    }
  }
  assert.deepEqual(
    installedTrees[0],
    installedTrees[1],
    "Fresh installs must have identical package versions.",
  );
  console.log(
    `Verified two identical helper installs and native loading on ${process.platform}/${process.arch}; offline reuse and stale-cache rejection pass.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
