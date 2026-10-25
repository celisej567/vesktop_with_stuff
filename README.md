# Vesktop (with Vesktop Media)

[Vesktop](https://github.com/Vencord/Vesktop) plus its own voice and video engine for Linux. Everything of regular
Vesktop is still here.

## TODO

- AMD / Intel hardware encoding (now NVIDIA NVENC or the CPU)
- AV1 / VP9 encoding (only decoded now)
- stream bitrate above ~4.2 Mbit/s: the server's limit, not verified whether it can be raised
- occasional missing voice in a call: cause unknown
- builds for older distributions (now needs the build machine's glibc)
- Windows and macOS

## What is added

**Vesktop Media**, an own native media engine (built on libwebrtc, `packages/vesktop_media`). Pick it in Vesktop's
settings → Voice & Video → engine: WebRTC (regular Vesktop), Discord's module (if a Discord client is installed) or
Vesktop Media.

With Vesktop Media:

- **Go Live**
  - Source resolution (the window's or screen's own size)
  - any video and audio bitrate
  - stream settings also while streaming
- **Stream audio**
  - the picked window's app found by itself (KWin), Steam games too
  - sound of the app's child processes included
  - audio source changeable while streaming
- **Cameras**
  - resolution, fps, autofocus per camera
  - camera (+ microphone) as a Go Live source
- **H.264 / H.265**: encoding via NVIDIA NVENC or the CPU (selectable), and decoding
- **Noise suppression**: RNNoise, DeepFilterNet; quick switch on the call panel

**Also**: no auto-updater (rebuild to update), `pnpm package --linux pacman` works.

Linux x86-64 only. Without Vesktop Media (no submodule or no build tools) it builds and works as regular Vesktop.

## Building

```sh
git clone --recursive <this repository>   # or: git submodule update --init
cd Vesktop
pnpm i
pnpm start                                # builds Vesktop Media too
pnpm package --linux pacman --x64         # a package (the engine is x86-64 only)
```

Vesktop Media needs clang, cmake, ninja, nasm, autotools, cargo and a few development headers; the first build
downloads and compiles about 2 GB. Details: [packages/vesktop_media/README.md](packages/vesktop_media/README.md),
[docs](packages/vesktop_media/docs/README.md). `VESKTOP_SKIP_MEDIA=1` builds without it.

Original Vesktop README: [orig_readme.md](orig_readme.md).
