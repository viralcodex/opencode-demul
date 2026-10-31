import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build, defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

const define = {
  "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
  "process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
};
const resolve = {
  alias: {
    ws: join(dirname(createRequire(import.meta.url).resolve("ws/package.json")), "index.js"),
  },
};

export default defineConfig({
  define,
  resolve,
  plugins: [
    gui({ outFile: "dist/gui.cjs" }),
    {
      name: "device-main-factory",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "./main.js" && importer?.includes("/src/gui.tsx")) return "\0device-main";
      },
      async load(id) {
        if (id !== "\0device-main") return;
        const output = await build({
          configFile: false,
          plugins: [gui({ entry: "src/main.ts" })],
          define,
          resolve,
          build: { write: false },
          logLevel: "silent",
        });
        const result = Array.isArray(output) ? output[0] : output;
        if (!result || !("output" in result)) throw new Error("Expected one device main bundle");
        const chunk = result.output.find((item) => item.type === "chunk" && item.isEntry);
        if (!chunk || chunk.type !== "chunk") throw new Error("Device main bundle has no entry");
        return `export default function setup(ctx) {
				const main = ((require) => {
					const module = { exports: {} }
					const exports = module.exports
					${chunk.code}
					return module.exports
				})(require)
				return main.default(ctx)
			}`;
      },
    },
  ],
});
