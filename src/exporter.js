// Making the file, entirely in the browser.
//
// Preferred path: mediabunny decodes the original with WebCodecs, so the export
// is frame-accurate and faster than real time; each decoded frame is recomposited
// with its doodle at the source resolution. Safari — especially on iPad — either
// lacks WebCodecs encoding or refuses every codec we can mux, so there we record
// the composite in real time instead. A still needs neither: it's a PNG.

import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';

const VIDEO_CODECS = ['avc', 'vp9', 'av1', 'vp8'];   // best-looking first
const AUDIO_CODECS = ['aac', 'opus'];

const HAS_WEBCODECS =
  typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// e.g. alice-video_2026-08-01_7s.mp4 — the length is the trimmed one, so the
// name describes the file you actually got.
function fileName(mode, ext, seconds) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return mode === 'image'
    ? `alice-image_${date}.${ext}`
    : `alice-video_${date}_${Math.max(1, Math.round(seconds))}s.${ext}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Errors from deep in an encoder are often bare DOMExceptions, where the name
// carries as much as the message.
function describe(err) {
  if (!err) return 'Unknown error.';
  if (err.name && err.message) return `${err.name}: ${err.message}`;
  return String(err.message || err.name || err);
}

export function createExporter({ clip, doodles, progress, onStart, onFinish }) {
  let running = false;
  let audioTap = null;

  async function pickEncoding(width, height, audioTrack) {
    const audioInfo = audioTrack
      ? { numberOfChannels: audioTrack.numberOfChannels, sampleRate: audioTrack.sampleRate }
      : null;
    for (const format of [new Mp4OutputFormat({ fastStart: 'in-memory' }), new WebMOutputFormat()]) {
      const supported = format.getSupportedCodecs();
      const videoCodec = await getFirstEncodableVideoCodec(
        VIDEO_CODECS.filter((c) => supported.includes(c)),
        { width, height, quality: QUALITY_HIGH },
      );
      if (!videoCodec) continue;
      const audioCodec = audioInfo
        ? await getFirstEncodableAudioCodec(
          AUDIO_CODECS.filter((c) => supported.includes(c)),
          { ...audioInfo, quality: QUALITY_HIGH },
        )
        : null;
      return { format, videoCodec, audioCodec };
    }
    return null;
  }

  async function withCodecs() {
    const { trimStart, trimEnd } = clip;
    const span = Math.max(0.001, trimEnd - trimStart);

    const input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('That file doesn’t have a video track.');
    const audioTrack = await input.getPrimaryAudioTrack();

    // The source's own resolution, and H.264 needs even dimensions.
    const width = Math.max(2, Math.floor(clip.width / 2) * 2);
    const height = Math.max(2, Math.floor(clip.height / 2) * 2);

    const encoding = await pickEncoding(width, height, audioTrack);
    if (!encoding) throw new Error('no encodable video codec');
    const { format, videoCodec, audioCodec } = encoding;

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const outCtx = out.getContext('2d');

    const target = new BufferTarget();
    const output = new Output({ format, target });
    const canvasSource = new CanvasSource(out, { codec: videoCodec, quality: QUALITY_HIGH });
    output.addVideoTrack(canvasSource);
    const audioSource = audioCodec
      ? new AudioSampleSource({ codec: audioCodec, quality: QUALITY_HIGH })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const rasterize = doodles.rasterizer(width, height);

    const pumpVideo = async () => {
      for await (const sample of new VideoSampleSink(videoTrack).samples(trimStart, trimEnd)) {
        outCtx.clearRect(0, 0, width, height);
        sample.draw(outCtx, 0, 0, width, height);
        // Frames are continuous, doodles are on the grid: a frame carries
        // whichever doodle its moment has reached, the rule the preview uses.
        const doodle = rasterize(doodles.at(clip.stepReached(sample.timestamp)));
        if (doodle) outCtx.drawImage(doodle, 0, 0);

        const timestamp = Math.max(0, sample.timestamp - trimStart);
        const duration = Math.max(1 / 1000, Math.min(sample.duration, trimEnd - sample.timestamp));
        sample.close();
        await canvasSource.add(timestamp, duration);
        progress(clamp(timestamp / span, 0, 1));
      }
    };

    const pumpAudio = async () => {
      if (!audioSource) return;
      for await (const sample of new AudioSampleSink(audioTrack).samples(trimStart, trimEnd)) {
        sample.setTimestamp(Math.max(0, sample.timestamp - trimStart));
        await audioSource.add(sample);
        sample.close();
      }
    };

    await Promise.all([pumpVideo(), pumpAudio()]);
    await output.finalize();
    progress(1);
    download(new Blob([target.buffer], { type: format.mimeType }),
      fileName('video', format.fileExtension.replace(/^\./, ''), span));
  }

  function recorderMimeType() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported?.(c)) || '';
  }

  // Safari has no HTMLMediaElement.captureStream, so the audio goes through
  // WebAudio. createMediaElementSource can only be called once per element.
  function recorderAudioTracks() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return [];
    try {
      if (!audioTap) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(clip.videoElement);
        const dest = ctx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(ctx.destination);   // keep it audible while recording
        audioTap = { ctx, dest };
      }
      audioTap.ctx.resume();
      return audioTap.dest.stream.getAudioTracks();
    } catch (err) {
      console.warn('No audio in export:', err);
      return [];
    }
  }

  async function withRecorder() {
    const video = clip.videoElement;
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error('This browser can’t make video files. Try Chrome, Edge, or a newer Safari.');
    }
    const { trimStart, trimEnd } = clip;
    const span = Math.max(0.001, trimEnd - trimStart);
    await clip.seekTime(trimStart);

    // Composite onto our own canvas rather than capturing the preview one: the
    // preview sits above a visible <video>, so a failed drawImage there looks
    // fine on screen but records as a black frame with only the doodles on it.
    const out = document.createElement('canvas');
    out.width = clip.width;
    out.height = clip.height;
    const outCtx = out.getContext('2d');
    const rasterize = doodles.rasterizer(out.width, out.height);

    let painting = 0;
    const paint = () => {
      clip.followPlayback();
      outCtx.fillStyle = '#000';
      outCtx.fillRect(0, 0, out.width, out.height);
      if (video.readyState >= 2) {
        try {
          outCtx.drawImage(video, 0, 0, out.width, out.height);
        } catch (err) {
          console.warn('Could not draw the video frame:', err);
        }
      }
      const doodle = rasterize(doodles.at(clip.step));
      if (doodle) outCtx.drawImage(doodle, 0, 0);
      painting = requestAnimationFrame(paint);
    };
    paint();

    const stream = out.captureStream(30);
    for (const track of recorderAudioTracks()) stream.addTrack(track);
    const mime = recorderMimeType();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

    const blob = await new Promise((resolve, reject) => {
      let settled = false;
      // Whichever comes first: the trim end, the clip ending, or the safety
      // timeout. All three are needed — watching `paused` alone hangs forever
      // when `ended` beats it.
      const finish = () => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(painting);
        clearInterval(ticker);
        clearTimeout(safety);
        video.removeEventListener('ended', finish);
        video.pause();
        if (rec.state !== 'inactive') rec.stop();
      };
      // Off the element on purpose: a backgrounded tab stops rAF, and this has
      // to keep measuring a recording that is still running.
      const tick = () => {
        progress(clamp((video.currentTime - trimStart) / span, 0, 1));
        if (video.currentTime >= trimEnd - 0.02) finish();
      };
      const ticker = setInterval(tick, 100);
      const safety = setTimeout(finish, span * 1000 + 5000);
      video.addEventListener('ended', finish);
      rec.onstop = () => resolve(new Blob(chunks, { type: mime || 'video/webm' }));
      rec.onerror = (e) => { finish(); reject(e.error || new Error('Recording failed.')); };
      rec.start();
      video.play().catch((err) => { finish(); reject(err); });
    });

    progress(1);
    download(blob, fileName('video', (mime || '').includes('mp4') ? 'mp4' : 'webm', span));
    clip.seek(clip.stepAt(trimStart));
  }

  async function still() {
    const { width, height } = clip;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const outCtx = out.getContext('2d');
    outCtx.drawImage(clip.imageElement, 0, 0, width, height);
    const doodle = doodles.rasterizer(width, height)(doodles.at(clip.step));
    if (doodle) outCtx.drawImage(doodle, 0, 0);

    const blob = await new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture couldn’t be encoded.'))), 'image/png');
    });
    download(blob, fileName('image', 'png'));
  }

  return {
    get running() { return running; },

    async run() {
      if (running || !clip.loaded) return;

      if (clip.mode === 'image') {
        try {
          await still();
        } catch (err) {
          console.error('Export failed:', err);
          alert('Sorry, making the picture didn’t work.\n\n' + describe(err));
        }
        return;
      }

      running = true;
      onStart();
      clip.pause();
      let firstError = null;
      try {
        if (HAS_WEBCODECS) {
          try {
            await withCodecs();
            return;
          } catch (err) {
            // An unsupported codec or a quirk deep in the encoder is worth
            // retrying with the recorder before giving up.
            firstError = err;
            console.warn('WebCodecs export failed, recording instead:', err);
          }
        }
        onStart('recording');   // the label says which path ran
        await withRecorder();
      } catch (err) {
        console.error('Export failed:', err, '(earlier:', firstError, ')');
        alert('Sorry, making the video didn’t work.\n\n' + describe(err)
          + (firstError ? `\n\nFirst tried: ${describe(firstError)}` : ''));
      } finally {
        running = false;
        onFinish();
      }
    },
  };
}
