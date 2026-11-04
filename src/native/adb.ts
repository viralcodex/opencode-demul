import type { Device } from "../rpc.js";

export interface AdbDevice {
  serial: string;
  state: string;
}

export function parseAdbDevices(output: string): AdbDevice[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*"))
    .flatMap((line) => {
      const [serial, state] = line.split(/\s+/u);
      return serial && state ? [{ serial, state }] : [];
    });
}

export function adbState(state: string): Device.DeviceState {
  if (state === "device") return "booted";
  if (state === "offline" || state === "connecting" || state === "authorizing") return "booting";
  return "unavailable";
}
