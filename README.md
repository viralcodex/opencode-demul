# Opencode-Demul

<img width="900" height="567" alt="demo" src="https://github.com/user-attachments/assets/ea5c5be1-c66d-4adc-a0d4-cc3878660152" />

<br>

View and control Android emulators from OpenCode Desktop on Windows, Linux, and macOS, and iOS
simulators on macOS.

## Requirements

- OpenCode Desktop compatible with plugin SDK 2.2.2, using a local server.
- Node 22.19+ on the 22.x line, or Node 24+, with npm.
- Android SDK Platform-Tools and Emulator, a configured Android Virtual Device, and hardware virtualization enabled.
- For iOS (macOS only): Xcode with an iOS Simulator runtime, selected with `xcode-select`.

Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` if your SDK is outside the standard Android Studio location.
Set `OPENCODE_DEVICE_NODE` to your Node executable if the desktop cannot find it.

## Install

Add this entry to your OpenCode configuration.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:viralcodex/opencode-demul#v0.4.0"]
}
```

Open **Add tab > Device** in a session.
First use downloads the pinned device helpers from npm.
Android SDK tools and Node must already be installed. Both platforms stream H.264 through a shared viewer.
Android uses the device's encoder through scrcpy; iOS uses the simulator helper's native encoder.

## Use

The panel opens the first available running device, or else the first available listed one,
and starts it if needed. Use the platform and device pickers to switch between Android
emulators and iOS simulators, and refresh to rescan. Either platform's toolchain may be
missing; the picker lists what the host can run.

Discovery and startup run in the background. The controls remain available while a device
boots; selecting another device cancels the pending attachment.

Each session controls its own device. Run iOS and Android side by side in separate sessions;
a device already controlled by another session cannot be attached. Tabs and windows showing
the same session share its device and agent-access setting. Closing a viewer stops its video
without detaching the device, so agents can keep working. Use `device.close` to
release it; deleting or moving the session also releases it. A failed device switch keeps the
previous attachment.

Refresh retries failed video capture without changing the attached device. If a helper exits,
the plugin restarts capture on the next stream request.

Agent access starts enabled. Use the switch to revoke access for the current
session. Agents can only use a device you have opened.
Installing an app or shutting down a device requires a separate permission prompt.

Cancelling a dispatched action cannot undo device input already sent. Read device state before
retrying an action whose outcome is unknown.

Tools use `device_*` names, or `device.*` in Code Mode. They can inspect the
screen, launch apps, enter text, interact with elements and take screenshots.

The first iOS automation command builds the agent's XCTest runner, which can take a few minutes.
[Physical devices, remote servers and direct keyboard input into the panel coming soon.]

Prebuilt plugin files are included.

[Release notes for v0.4.0](https://github.com/viralcodex/opencode-demul/releases/tag/v0.4.0).

## Development

Use Bun 1.3.6 and a supported Node version to build and test it.

```sh
bun install --frozen-lockfile
bun run check
bun run bundle
bun run verify:package
```

MIT license.
Dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
