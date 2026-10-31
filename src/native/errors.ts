import { Device } from "../rpc.js";

// The runtime's typed failure. Every rejected runtime operation rejects with a {@link DeviceFailure}, so a caller reads
// a stable {@link Device.DeviceErrorCode}, a human-readable message, and whether the native action may already have run,
// instead of inspecting an opaque `Error`. `data` is exactly the {@link Device.DeviceError} that crosses the wire.
export class DeviceFailure extends Error {
  readonly code: Device.DeviceErrorCode;
  readonly mayHaveExecuted: boolean;

  constructor(data: Device.DeviceError) {
    super(data.message);
    this.name = "DeviceFailure";
    this.code = data.code;
    this.mayHaveExecuted = data.mayHaveExecuted;
  }

  // The schema-shaped payload for the RPC/IPC boundary.
  get data(): Device.DeviceError {
    return { code: this.code, message: this.message, mayHaveExecuted: this.mayHaveExecuted };
  }
}

// Build a {@link DeviceFailure}. `mayHaveExecuted` defaults to false; callers set it true after dispatching a mutation.
export function deviceError(
  code: Device.DeviceErrorCode,
  message: string,
  mayHaveExecuted = false,
): DeviceFailure {
  return new DeviceFailure({ code, message, mayHaveExecuted });
}

// Narrow an unknown rejection to a {@link DeviceFailure}.
export function isDeviceFailure(value: unknown): value is DeviceFailure {
  return value instanceof DeviceFailure;
}
