import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.DEMULE_PACKAGE_ROOT
  ? resolve(process.env.DEMULE_PACKAGE_ROOT)
  : dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert(!manifest.workspaces, "GitHub installs must not require workspace preparation.");
for (const script of ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]) {
  assert(
    !manifest.scripts?.[script],
    `GitHub installs must use prebuilt bundles, not the ${script} script. Run release:check explicitly.`,
  );
}
const temporary = await mkdtemp(join(tmpdir(), "demule-package-"));
const run = (command, args, cwd = root) => {
  if (command === "npm" && process.platform === "win32") {
    const searchPath =
      Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    const candidates = [
      process.env.npm_execpath,
      ...[dirname(process.execPath), ...searchPath.split(";").filter(Boolean)].map((directory) =>
        join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      ),
    ];
    const cli = candidates.find(
      (candidate) => candidate?.endsWith("npm-cli.js") && existsSync(candidate),
    );
    assert(cli, "Install Node with npm to verify the release on Windows.");
    return execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
};

try {
  const [packed] = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]),
  );
  const files = packed.files.map((entry) => entry.path).sort();
  assert.deepEqual(files, [
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "dist/gui.cjs",
    "dist/server.js",
    "package.json",
  ]);
  for (const entry of Object.values(manifest.exports)) {
    assert(files.includes(entry.replace(/^\.\//, "")), `Missing exported entrypoint: ${entry}`);
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `Runtime dependency is not pinned: ${name}`);
  }
  run("npm", [
    "install",
    "--prefix",
    temporary,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    join(temporary, packed.filename),
  ]);
  const installed = join(temporary, "node_modules", manifest.name);
  const verification = join(installed, "verify-installed.mjs");
  await writeFile(
    verification,
    String.raw`
        import assert from "node:assert/strict";
        import { readFile } from "node:fs/promises";
        import { createRequire, isBuiltin } from "node:module";
        import * as Effect from "effect";
        import * as Main from "@opencode/plugin/gui/main";
        import * as Rpc from "@opencode/schema/rpc";
        import { Host } from "@opencode/plugin/host";
        const entrypoints = Host.resolve({ directory: process.cwd() });
        assert(entrypoints.server?.endsWith("/dist/server.js"));
        assert(entrypoints.gui?.endsWith("/dist/gui.cjs"));
        const server = await Host.load(entrypoints.server);
        assert.equal(server.default.id, "demul.device");
        assert.equal(typeof server.default.effect, "function");
        const source = await readFile(new URL(entrypoints.gui), "utf8");
        const require = createRequire(new URL(entrypoints.gui));
        const inert = new Proxy(() => {}, { get: () => inert });
        const modules = {
          effect: Effect,
          "@opencode/plugin/gui": Main,
          "@opencode/schema/rpc": Rpc,
          "solid-js": inert,
          "solid-js/web": inert,
        };
        const bundle = { exports: {} };
        new Function("require", "module", "exports", source)(
          name => {
            if (name in modules) return modules[name];
            assert(isBuiltin(name), "Unexpected GUI runtime dependency: " + name);
            return require(name);
          },
          bundle,
          bundle.exports,
        );
        const gui = bundle.exports.default;
        assert.equal(typeof gui.setup, "function");
        assert.equal(typeof gui.main, "function");
        const providers = [];
        const cleanups = [];
        await gui.main({
          provide: (contract, implementation) => {
            providers.push({ contract, implementation });
            return { changed() {} };
          },
          windows: { on: () => () => {} },
          onCleanup: cleanup => cleanups.push(cleanup),
        });
        assert.equal(providers.length, 1);
        assert.equal(providers[0].contract.spec.id, "demul.device.bridge.v2");
        assert.deepEqual(providers[0].implementation.state(1), []);
        for (const cleanup of cleanups) await cleanup();
        console.log("OpenCode resolves the installed server and GUI; main IPC setup and cleanup pass.");
      `,
  );
  const output = run(process.execPath, [verification], installed);
  console.log(output.trim());
  console.log(`Verified ${manifest.name}@${manifest.version}: ${files.length} release files.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
