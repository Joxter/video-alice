# Video Alice

A tiny video editor for short clips, simple enough for kids. Upload a video, trim
the ends, doodle on top, download the result.

**[Try it →](https://joxter.github.io/video-alice/)**

Everything runs in your browser. Your video is never uploaded anywhere — there is
no server, no account, and no analytics. The only thing kept between visits is your
drawings, in this browser's own local storage.

## What it does

- **Upload** — drag and drop a clip, or pick one. Works best with ~10 second videos.
  The tools are all on screen before you choose a file, dimmed until there's something
  to edit.
- **Trim** — two handles on the timeline set the start and end. Playback stays inside
  them, but scrubbing and stepping range over the whole clip, so you can look at what
  you cut or draw just outside it.
- **Draw** — pause anywhere and doodle. Each doodle is pinned to that moment (an orange
  dot on the timeline) and stays on screen until the next doodle takes over. Ten colors,
  three brush sizes, eraser, undo, clear.

  A doodle *replaces* the one before it, it doesn't add to it. Exactly one drawing is on
  screen at a time — the most recent one at or before the playhead — so starting a new
  doodle is how you make the previous one go away, and the eraser is for tidying the
  drawing you are on, not the one it inherited. To change an existing doodle, jump back
  to its own dot with the orange-dot buttons; drawing a step later starts a new one.

  Drawings survive a reload: the strokes are kept in this browser's local storage,
  under a `videoAlice:` prefix. There's no check that you came back with the same
  video — load a different clip and the doodles are still there, at the same moments,
  rescaled if the picture is a different shape.
- **Play** — play/pause and stop (back to the start of the trim). Double chevrons
  jump a second, single chevrons one step. The outer buttons, marked with an orange
  dot, hop straight between the moments that already have a drawing.
- **Download** — get an MP4 with the trim and the doodles baked in, named for the day
  and the clip's length: `alice-video_2026-08-01_7s.mp4`.

Shortcuts: <kbd>Space</kbd> to play/pause, <kbd>←</kbd> / <kbd>→</kbd> to skip a second
(hold <kbd>Shift</kbd> for one step), <kbd>⌘Z</kbd> / <kbd>Ctrl+Z</kbd> to undo.

### The step grid

The playhead only ever stops on a tenth of a second. Every button moves by whole steps,
a click on the timeline goes to the nearest one, and a doodle belongs to a step rather
than to a video frame. The shaded band under the playhead is the step you're on, and the
dot of a doodle already there lights up, so it's clear which moment you're drawing at
before the brush touches anything.

This is a deliberate limit, and it's what keeps the editor honest: "is this doodle on the
same moment as the playhead?" becomes a comparison of two whole numbers. Ask a `<video>`
element where it is and the answer drifts by milliseconds — a seek reports the position
you asked for, then settles on whichever frame actually decoded — which used to be enough
to strand a fresh drawing a hair ahead of the playhead, invisible until playback caught up.

Playback and the exported file are untouched by any of this. Those are as smooth as the
source; it's only where you can *stop* that is quantised.

On a touch screen the video and the timeline swallow every touch that lands on
them — that's what makes the brush and the trim handles work — so the editor keeps
a 48px strip free down both sides to scroll the page by. The jump buttons sit in
that strip beside the track and are fine to scroll over.

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
2. Each frame is drawn to an offscreen canvas at the video's own resolution, and the
   doodle for that frame's timestamp is drawn on top. The doodle is re-rendered from
   its strokes at that resolution rather than scaled up from the preview: on screen
   the drawing layers are capped at 1600px, since that's more than the page can show
   and a full-size layer per doodle is what makes a 4K clip expensive to keep in
   memory.
3. `CanvasSource` encodes the composited canvas; audio is decoded and re-encoded in
   parallel, with timestamps shifted onto the trimmed timeline so it stays in sync.
4. The muxed result downloads as an MP4.

Because decoding is frame-accurate and not tied to playback, the export is exact and
finishes faster than real time.

The output codec is probed at runtime: MP4 where the browser can encode it, WebM as a
fallback.

If that path is missing or fails for any reason, the export falls back to `MediaRecorder`.
It plays the trimmed range and composites each frame onto a canvas of its own — not the
preview canvas, which sits above a visible `<video>` and would record as black if
`drawImage` ever came up empty — with audio routed through WebAudio, since Safari has no
`HTMLMediaElement.captureStream`. Same picture, but rendered in real time and re-encoded
from playback rather than the source. The progress overlay says "(recording)" when this
path is running.

## Browser support

Chrome and Edge use the WebCodecs path and give the best quality. Anywhere it isn't
available or throws, the recording fallback takes over automatically.

## Project layout

```
index.html      structure — one editor, which starts in an "empty" state
style.css       styling
app.js          all the logic: upload, trim, doodle layers, export
vite.config.js  base path for GitHub Pages
.github/workflows/deploy.yml   builds and publishes to Pages on push to main
```
