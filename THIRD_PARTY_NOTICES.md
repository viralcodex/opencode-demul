# Third-party notices

The GUI bundle includes ws 8.22.0 under the MIT license. Its license follows.
OpenCode's SDK, Schema, Effect and Solid are supplied by the host or installed
as npm dependencies, not copied into this bundle.

## ws

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Separately installed helpers

Opening a supported device downloads agent-device 0.21.35 and expo-device-hub
0.19.0 from npm into an isolated helper directory. They are not distributed in
the plugin archive. Their original packages retain their licenses and notices.

- agent-device: MIT, copyright 2026 Callstack.
- expo-device-hub: MIT, copyright 2015-present 650 Industries, Inc. Its vendored
  serve-emu and serve-sim code is Apache-2.0, with licenses in the vendor folders.
- Native and transitive helper dependencies keep their own licenses. Pinning the
  helper version does not freeze transitive dependency ranges.

Android SDK, emulator images, ffmpeg and other system tools are installed by the
user and remain subject to their respective licenses. The plugin does not
redistribute them or install system tooling.
