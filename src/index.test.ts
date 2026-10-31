import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/effect/plugin";
import { Agent } from "@opencode/schema/agent";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import { Effect, Schema, Stream } from "effect";
import { DeviceBridge } from "./bridge.js";
import DevicePlugin from "./index.js";
import { HandleRegistry } from "./native/handle.js";
import type { DeviceServer } from "./server.js";
import { DeviceTools } from "./tools.js";

test("the device namespace has no experimental branding", () => {
  expect(DeviceTools.namespace.name).toBe("device");
  expect(DeviceTools.namespace.description).not.toMatch(/experimental/iu);
});

test("tool commands omit absent options and preserve typed screenshot content", async () => {
  const tools: Tool.Info[] = [];
  const permissions: string[] = [];
  const handle = new HandleRegistry().create("android", "emulator-5554");
  const snapshot = {
    token: handle.token,
    generation: handle.generation,
    revision: 1,
    interactiveOnly: true,
    complete: true,
    nodes: [],
  };
  const screenshot = {
    data: new Uint8Array([1, 2, 3]),
    width: 1080,
    height: 2400,
    platform: handle.platform,
    deviceId: handle.deviceId,
  };
  const responses: DeviceBridge.Value[] = [
    { type: "devices", devices: [] },
    {
      type: "attachment",
      attachment: { handle, agentAccess: true, capabilities: { supported: [], unsupported: [] } },
    },
    { type: "launch", result: { app: "settings", state: "launched" } },
    { type: "snapshot", snapshot },
    { type: "done" },
    { type: "screenshot", screenshot },
    { type: "install", result: { installed: true } },
    { type: "done" },
  ];
  const commands: DeviceBridge.Operation[] = [];
  const server: DeviceServer.Server = {
    state: () => null,
    request: (_sessionID, operation) =>
      Effect.sync(() => {
        Schema.decodeUnknownSync(Schema.Json)(operation);
        commands.push(operation);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected device command");
        return response;
      }),
  };
  const ctx = {
    tool: {
      transform: (
        callback: (editor: { namespace: () => void; add: (tool: Tool.Info) => void }) => void,
      ) => {
        callback({ namespace: () => undefined, add: (tool) => void tools.push(tool) });
        return Effect.void;
      },
    },
    permission: {
      assert: (input: { action: string }) => Effect.sync(() => void permissions.push(input.action)),
    },
  } as unknown as Pick<Context, "tool" | "permission">;
  await Effect.runPromise(DeviceTools.register(ctx, server).pipe(Effect.scoped));
  const invocation = {
    sessionID: Session.ID.create(),
    agent: Agent.ID.make("device-test"),
    messageID: SessionMessage.ID.create(),
    id: Tool.CallID.make("device-json-test"),
    progress: () => Effect.void,
  };
  const inputs = [
    { name: "list", input: {} },
    { name: "open", input: { platform: handle.platform, deviceId: handle.deviceId } },
    { name: "launch", input: { handle, app: "settings" } },
    { name: "snapshot", input: { handle } },
    { name: "close", input: { handle } },
    { name: "screenshot", input: { handle } },
    { name: "install", input: { handle, artifactPath: "/test.apk" } },
    { name: "close", input: { handle, shutdown: true } },
  ];
  for (const item of inputs) {
    const tool = tools.find((tool) => tool.name === item.name);
    if (!tool) throw new Error(`Missing tool ${item.name}`);
    if (!Schema.isSchema(tool.input)) throw new Error("Expected a device input schema");
    const result = await Effect.runPromise(
      tool.execute(Schema.decodeUnknownSync(tool.input)(item.input), invocation),
    );
    if (typeof result.content === "string") throw new Error("Expected structured device content");
    const note = result.content?.[0];
    expect(note?.type).toBe("text");
    if (!note || note.type !== "text") throw new Error("Missing device output note");
    expect(note.text).toContain("untrusted data");
    if (item.name === "screenshot") {
      expect(result.output).toEqual(screenshot);
      expect(result.content).toContainEqual({
        type: "file",
        uri: "data:image/png;base64,AQID",
        mime: "image/png",
        name: "android-emulator-5554.png",
      });
    }
  }
  expect(commands).toEqual<unknown>(inputs.map((item) => ({ ...item.input, type: item.name })));
  expect(permissions).toEqual(["device.install", "device.shutdown"]);
});

test("the server entry registers the control RPC and real Code Mode device tools", async () => {
  const recorded: { namespace?: Tool.Namespace; rpc?: unknown; tools: Tool.Info[] } = { tools: [] };
  const ctx = {
    rpc: Object.assign(
      () => {
        throw new Error("Device plugin registration does not call an RPC client.");
      },
      {
        register: (definition: unknown) => {
          recorded.rpc = definition;
          return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } });
        },
      },
    ),
    event: { subscribe: () => Stream.empty },
    tool: {
      transform: (
        callback: (editor: {
          namespace: (namespace: Tool.Namespace) => void;
          add: (tool: Tool.Info) => void;
        }) => void,
      ) => {
        callback({
          namespace: (namespace) => (recorded.namespace = namespace),
          add: (tool) => void recorded.tools.push(tool),
        });
        return Effect.succeed(undefined);
      },
    },
  } as unknown as Context;

  expect(DevicePlugin.id).toBe("demul.device");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* DevicePlugin.effect(ctx);
      expect(recorded.rpc).toBe(DeviceBridge.ControlRpc);
      expect(recorded.namespace).toBe(DeviceTools.namespace);
      expect(recorded.tools.map((tool) => tool.name)).toEqual([
        "status",
        "state",
        "list",
        "open",
        "apps",
        "launch",
        "install",
        "snapshot",
        "press",
        "fill",
        "swipe",
        "key",
        "screenshot",
        "close",
      ]);
      recorded.tools.forEach((tool) => {
        expect(tool.options?.namespace).toBe("device");
        expect(tool.options?.codemode).toBe(true);
        expect(tool.output).toBeDefined();
      });
      const status = recorded.tools.find((tool) => tool.name === "status");
      if (!status) throw new Error("The device status tool was not registered.");
      const result = yield* status.execute(
        {},
        {
          sessionID: Session.ID.make("ses_device_index_test"),
          agent: Agent.ID.make("device-test"),
          messageID: SessionMessage.ID.make("msg_device_index_test"),
          id: Tool.CallID.make("device-status"),
          progress: () => Effect.void,
        },
      );
      expect(result.output).toEqual({ attached: false, agentAccess: false });
      expect(result.content).toContainEqual({
        type: "text",
        text: "No device is attached to this session.",
      });
    }).pipe(Effect.scoped),
  );
});
