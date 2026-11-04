import { Device } from "../rpc.js";

// Preserve the error code, message, and dispatch certainty across the device RPC boundary.
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

// Mark mutations that were dispatched before failure so callers do not mistake their outcome for a clean cancellation.
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
