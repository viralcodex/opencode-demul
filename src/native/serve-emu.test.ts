import { expect, test } from "bun:test";
import { streamDescriptor } from "./hub.js";
import { waitForScreen } from "./serve-emu.js";

test.each([
  { status: 200, body: { ok: true, status: "streaming" }, error: undefined },
  {
    status: 503,
    body: { ok: false, error: "spawn ffmpeg ENOENT private-token" },
    error: "spawn ffmpeg ENOENT [redacted]",
  },
  {
    status: 200,
    body: { ok: true, status: "error", lastError: "capture ended" },
    error: "capture ended",
  },
])("Android checks capture readiness and reports backend diagnostics: %s", async (input) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/vendor/serve-emu/health");
      expect(url.searchParams.get("device")).toBe("emulator-5554");
      expect(request.headers.get("Authorization")).toBe("Bearer private-token");
      return Response.json(input.body, { status: input.status });
    },
  });
  const stream = streamDescriptor(
    { baseUrl: server.url.origin, token: "private-token" },
    "android",
    "emulator-5554",
  );
  try {
    if (!input.error) {
      await waitForScreen(stream);
      return;
    }
    const error = await waitForScreen(stream).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "helper-failed",
      message: expect.stringContaining(input.error),
    });
  } finally {
    await server.stop(true);
  }
});
