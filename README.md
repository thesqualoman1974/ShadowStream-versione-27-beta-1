# ShadowStream

ShadowStream 27 beta 1.4 is a Windows screen/game replay buffer built with Electron, .NET 8, and OBS Studio.

## Architecture

The .NET backend is split by responsibility while remaining a single project:

- `Program.cs` is the command-line entry point.
- `Configuration/` contains startup options and application settings.
- `Platform/` contains Windows display/window discovery and FFmpeg lookup.
- `Audio/` contains audio-device discovery, capture pipes, and level monitoring.
- `Capture/` contains FFmpeg capture and replay-buffer segment discovery.
- `Export/` contains clip export and remuxing; `Clips/` remains for saved media.
- `Application/ShadowStreamApp.cs` coordinates the backend services.

The Electron side is separated by process boundary: `electron/main.js` owns the
window and IPC, `electron/obs-engine.js` owns OBS integration,
`electron/preload.js` exposes the UI bridge, and `electron/renderer/` contains
the dashboard. Keep fixes within the relevant module; shared behavior should be
changed only at the module boundary that owns it.

## Run from source

Install Node.js 22+, the .NET 8 SDK, and OBS Studio 33 or later. Then run:

```powershell
npm install
npm start
```

For troubleshooting with the Electron Developer Tools Console open, run:

```powershell
npm run start:debug
```

Replay clips are saved to `D:\ShadowStream\Clips`.
To inspect available Windows audio endpoints without starting capture, run
`dotnet run -- --list-audio-devices`.

## Capture controls

OBS Studio is launched as a separate, minimized capture engine. Windows does not
support true headless desktop capture, so OBS remains in the logged-in desktop
session. ShadowStream creates a portable OBS runtime in its own user-data
directory using hard links to the installed OBS files; it generates a dedicated
profile, scene collection, and authenticated localhost WebSocket configuration.
The installed OBS profile, scene collection, WebSocket password, and streaming
credentials are not modified or copied. On first launch, the installed OBS
configuration must contain a display source, a window-capture source, and the
global desktop-audio/microphone sources; ShadowStream copies only those source
settings into its own scene collection.

The desktop app opens with a live video preview and audio meters while
Instant Replay is stopped; click **Avvia Instant Replay** to start the rolling
buffer. OBS's own preview canvas is disabled to reduce GPU work; the dashboard
preview uses a live Electron video stream capped at 1920x1080 and 60 FPS. The
preview and WASAPI level monitors stay active while Replay is stopped, without
saving a video or audio recording. Replay and continuous recording are
controlled through OBS WebSocket.
Set the Instant Replay duration from the gear settings, from 5 to 30 minutes in
5-minute steps; ShadowStream saves the selection and restores it on the next
launch. The **Salva clip** button becomes available once the active replay buffer
is running and saves the available buffer up to the selected duration.
Choose the screen/game source and audio input devices in the same settings view;
audio level meters remain visible on the dashboard.
The preview uses the full dashboard width in a 21:9 frame so ultrawide captures
remain large and uncropped. Window capture identifies the selected window by its
title, window class, and owning executable to avoid reusing a stale OBS target.
Use the preview controls or mouse wheel to zoom, drag to reframe, and press
**Reimposta** to restore the full view. The selected crop is applied to Instant
Replay and MP4 recordings and restored on the next launch.
**Salva clip** exports the
the recent buffer as MP4; **Avvia Registrazione MP4** records continuously to a
separate MP4 in the Clips folder. Stopping continuous recording resumes Instant
Replay if it was active before recording. Closing ShadowStream stops OBS cleanly;
unsaved replay footage is discarded.

OBS is configured for a 3440x1440 canvas at 60 FPS, NVENC video at 15 Mbps,
48 kHz stereo audio, and AAC at 192 kbps on every audio track. Screen/window
source, selected audio devices, replay duration, and save/record actions are
applied to the dedicated OBS instance. The C# helper is retained only for audio
meters and Windows device enumeration; its FFmpeg capture commands are disabled
in this mode. The OBS process runs at above-normal priority.
The dedicated desktop-audio and microphone sources start without OBS audio
filters. The microphone source retains the input device's native channel layout.

## Build a Windows installer

The installer targets 64-bit Windows (`win-x64`) for both Electron and the .NET
backend. Windows 11 is not available as a 32-bit operating system, so there is no
separate 32-bit Windows 11 build.
The installer filename includes `64bit` to make its architecture clear.

```powershell
npm run build:win
```

The installer and update metadata are written to `release\`. The app checks the
GitHub Releases page for `thesqualoman1974/ShadowStream-versione-27-beta-1`;
beta releases are included. To publish an update, create a prerelease on that
repository and upload the generated installer, `latest.yml`, and `.blockmap`
files. Users are asked before downloading and again before installing.

## Audio

System output and the default microphone are selected automatically. Use the
mixer to select another active Windows audio endpoint or disable either source.
The mixer faders adjust captured desktop-audio and microphone gain from -60 dB
to +6 dB; they do not change Windows playback or microphone device volume. OBS
confirms each applied fader level. WASAPI meters remain active independently of
Replay and recording. "Audio del PC" monitors the selected Windows playback
endpoint, including game audio.
