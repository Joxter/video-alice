# Ideas

Things worth doing one day. Nothing here is a commitment, and the point of the
app — mark up a short clip in a couple of taps and get a file back — is more
easily lost by adding to this list than by ignoring it.

## Who it's for

Marking up short clips: a screencast from work with a circle round the thing you
mean, an arrow, a note. Simple enough that a child can use it too, but that's a
side effect of keeping it small rather than the target.

## A native Mac app

Same tools, taking photos as well as video — mostly for annotating screenshots,
which is the same job as annotating a frame and is what a Mac app would get used
for most.

Worth thinking about first:

- Annotating a still already works in the web app — a picture is a clip with one
  step on the grid, and it needed no changes to the drawing side at all. So the
  Mac app isn't about gaining that; it's about the ways of *reaching* it.
- What the app would actually gain from being native: the system share sheet,
  Services / right-click on a file, a screenshot hotkey, drag-and-drop out to
  another app. That's the reason to build it, not the drawing.
- What that costs: everything here is the browser's — decoding, encoding, muxing
  via mediabunny, the canvas. A native app replaces all of it with AVFoundation,
  or wraps the web app and gives up most of the point.
