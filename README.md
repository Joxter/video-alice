# Video Alice

A tiny video editor for short clips, simple enough for kids. Upload a video, trim
the ends, doodle on top, download the result.

**[Try it →](https://joxter.github.io/video-alice/)**

Everything runs in your browser. Your video is never uploaded anywhere — there is
no server, no account, and no analytics.

## What it does

- **Upload** — drag and drop a clip, or pick one. Works best with ~10 second videos.
- **Trim** — two handles on the timeline set the start and end. Playback stays inside them.
- **Draw** — pause anywhere and doodle. Each doodle is pinned to that moment (an orange
  dot on the timeline) and stays on screen until the next doodle takes over. Eight colors,
  three brush sizes, eraser, undo, clear.
- **Download** — get an MP4 with the trim and the doodles baked in.

Shortcuts: <kbd>Space</kbd> to play/pause, <kbd>⌘Z</kbd> / <kbd>Ctrl+Z</kbd> to undo.

## Running it locally

```sh
npm install
npm run dev
```

Then open http://localhost:5173.

It needs a real server rather than opening `index.html` directly — ES modules and
WebCodecs both require a proper origin, and `file://` isn't one.

```sh
npm run build     # production build into dist/
npm run preview   # serve that build
```

## How the export works

The interesting part of an editor like this is producing a downloadable file with
the trim and drawings baked in, entirely in the browser.

The preview composites two things onto a canvas: the current video frame, and the
doodle layer belonging to that moment. The export runs that same compositing again —
but instead of the `<video>` element, frames come from
[mediabunny](https://mediabunny.dev), which decodes the original file with WebCodecs:

1. `VideoSampleSink.samples(trimStart, trimEnd)` yields exactly the frames inside the trim.
2. Each frame is drawn to an offscreen canvas, and the doodle layer for that frame's
   timestamp is drawn on top.
3. `CanvasSource` encodes the composited canvas; audio is decoded and re-encoded in
   parallel, with timestamps shifted onto the trimmed timeline so it stays in sync.
4. The muxed result downloads as an MP4.

Because decoding is frame-accurate and not tied to playback, the export is exact and
finishes faster than real time. (The earlier approach recorded the preview canvas with
`MediaRecorder`, which ran in real time and depended on playback events.)

The output codec is probed at runtime: MP4 where the browser can encode it, WebM as a
fallback.

Where WebCodecs encoding isn't available — Safari, and iPads in particular — the export
falls back to recording the preview canvas with `MediaRecorder`, with audio routed through
WebAudio (Safari has no `HTMLMediaElement.captureStream`). The result is the same picture;
it just renders in real time and re-encodes from the preview rather than the source.

## Browser support

Chrome and Edge use the WebCodecs path and give the best quality. Safari, iPadOS, and
older browsers use the recording fallback automatically.

## Project layout

```
index.html      structure — upload screen and editor
style.css       styling
app.js          all the logic: upload, trim, doodle layers, export
vite.config.js  base path for GitHub Pages
```
