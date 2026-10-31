# Demule

<img width="900" height="567" alt="demo" src="https://github.com/user-attachments/assets/ea5c5be1-c66d-4adc-a0d4-cc3878660152" />

View and control Android emulators from OpenCode Desktop on Windows, Linux, and
macOS. Includes a Device panel and agent tools.

## Requirements

- OpenCode Desktop compatible with plugin SDK 2.2.2, using a local server.
- Node 22.19+ on the 22.x line, or Node 24+, with npm.
- Android SDK Platform-Tools and Emulator, a configured Android Virtual Device,
  and hardware virtualization enabled.
- ffmpeg with libx264 on the desktop process's PATH.

Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` if your SDK is outside the standard
Android Studio location. Set `OPENCODE_DEVICE_NODE` to your Node executable if
the desktop cannot find it.

## Install

Add this entry to your OpenCode configuration.

```json
{
  "plugins": ["github:viralcodex/opencode-demul#v0.1.0"]
}
```

Restart OpenCode Desktop, then open **Add tab > Device** in a session.
First use downloads the pinned device helpers from npm. Android SDK tools,
Node and ffmpeg must already be installed.

## Use

The panel opens the first configured emulator and starts it if needed. Use the
picker to switch devices, refresh to rescan, and detach to disconnect without
shutting down the emulator. Click or drag the screen to control it.

Agent access starts enabled. Use the switch to revoke access for the current
session. Agents can only use a device you have opened. Installing an APK or
shutting down an emulator requires a separate permission prompt.

Tools use `device_*` names, or `device.*` in Code Mode. They can inspect the
screen, launch apps, enter text, interact with elements and take screenshots.

Android emulators only (for now).
[iOS, physical devices, remote servers and direct keyboard input into the panel coming soon.]

Prebuilt plugin files are included. No build step or Bun installation is needed
to install the plugin.

## Development

Use Bun 1.3.6 and a supported Node version to build and test it.

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run verify:package
```

MIT license. Dependency licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
