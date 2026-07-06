// capture.js — deterministic offscreen rendering + encoders (MP4 / GIF / PNG-seq)
// All exports are framework-agnostic; the React layer wires them to state.
import * as THREE from "three";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

// ---------- minimal STORE-only ZIP writer ----------
// JSZip's generateAsync stalls on binary (PNG) payloads in some headless/CDN
// setups, so we build the archive synchronously. STORE (no deflate) is what we
// want anyway — PNG/JPEG are already compressed. Fully spec-compliant local
// headers + central directory with CRC32.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const utf8 = (s) => new TextEncoder().encode(s);

// entries: [{ name, bytes: Uint8Array }] -> Blob (application/zip)
function buildZip(entries) {
  const encoded = entries.map((e) => {
    const nameBytes = utf8(e.name);
    return { nameBytes, data: e.bytes, crc: crc32(e.bytes) };
  });
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  for (const e of encoded) {
    const local = [];
    local.push(u32(0x04034b50));           // local file header sig
    local.push(u16(20));                    // version needed
    local.push(u16(0x0800));                // flags: UTF-8 name
    local.push(u16(0));                     // method: STORE
    local.push(u16(0), u16(0));             // mod time/date
    local.push(u32(e.crc));
    local.push(u32(e.data.length));         // compressed size
    local.push(u32(e.data.length));         // uncompressed size
    local.push(u16(e.nameBytes.length));
    local.push(u16(0));                     // extra len
    local.push(e.nameBytes);
    local.push(e.data);
    const localBytes = concatBytes(local);
    chunks.push(localBytes);

    const cd = [];
    cd.push(u32(0x02014b50));               // central dir sig
    cd.push(u16(20), u16(20));              // version made/needed
    cd.push(u16(0x0800), u16(0));           // flags, method
    cd.push(u16(0), u16(0));                // time/date
    cd.push(u32(e.crc));
    cd.push(u32(e.data.length), u32(e.data.length));
    cd.push(u16(e.nameBytes.length), u16(0), u16(0)); // name, extra, comment len
    cd.push(u16(0), u16(0));                // disk#, internal attrs
    cd.push(u32(0));                        // external attrs
    cd.push(u32(offset));                   // local header offset
    cd.push(e.nameBytes);
    central.push(concatBytes(cd));
    offset += localBytes.length;
  }

  const centralBytes = concatBytes(central);
  const cdSize = centralBytes.length;
  const cdOffset = offset;
  const end = [];
  end.push(u32(0x06054b50));               // EOCD sig
  end.push(u16(0), u16(0));                // disk numbers
  end.push(u16(encoded.length), u16(encoded.length));
  end.push(u32(cdSize), u32(cdOffset));
  end.push(u16(0));                        // comment len
  return new Blob([...chunks, centralBytes, concatBytes(end)], { type: "application/zip" });
}
function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- resolution presets ----------
export const STILL_PRESETS = [
  { label: "1600 × 1600", w: 1600, h: 1600 },
  { label: "2000 × 2000", w: 2000, h: 2000 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "3840 × 2160", w: 3840, h: 2160 },
];
export const VIDEO_PRESETS = [
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "1080 × 1080", w: 1080, h: 1080 },
  { label: "1080 × 1920", w: 1080, h: 1920 },
];

export const slug = (s) =>
  (s || "capture").replace(/\.(glb|gltf)$/i, "").replace(/[^\w\-一-龠ぁ-んァ-ヶ]+/g, "_").slice(0, 60) || "capture";

// ---------- offscreen fixed-size render ----------
// Renders the scene at an exact pixel size with the camera aspect matched to
// the output, then restores everything. Returns the WebGL canvas (caller reads
// pixels immediately, before any further render mutates the buffer).
export function renderAtSize(gl, scene, camera, w, h, { transparent = false } = {}) {
  const canvas = gl.domElement;
  const prevSize = new THREE.Vector2();
  gl.getSize(prevSize);
  const prevDpr = gl.getPixelRatio();
  const prevAspect = camera.aspect;
  const prevAlpha = gl.getClearAlpha();
  const prevClear = new THREE.Color();
  gl.getClearColor(prevClear);

  gl.setPixelRatio(1);
  gl.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (transparent) gl.setClearColor(0x000000, 0);
  gl.render(scene, camera);

  const restore = () => {
    gl.setPixelRatio(prevDpr);
    gl.setSize(prevSize.x, prevSize.y, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    gl.setClearColor(prevClear, prevAlpha);
    gl.render(scene, camera);
  };
  return { canvas, restore };
}

// Begin a multi-frame offscreen session: sizes the renderer ONCE to w×h and
// returns { canvas, renderFrame, end }. renderFrame() draws the current scene
// into the fixed buffer (no per-frame resize — much faster for video). end()
// restores the original renderer/camera state.
export function beginOffscreen(gl, scene, camera, w, h, { transparent = false } = {}) {
  const canvas = gl.domElement;
  const prevSize = new THREE.Vector2();
  gl.getSize(prevSize);
  const prevDpr = gl.getPixelRatio();
  const prevAspect = camera.aspect;
  const prevAlpha = gl.getClearAlpha();
  const prevClear = new THREE.Color();
  gl.getClearColor(prevClear);

  gl.setPixelRatio(1);
  gl.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (transparent) gl.setClearColor(0x000000, 0);

  return {
    canvas,
    renderFrame() {
      // camera.aspect is fixed for the whole session; caller mutates position only
      camera.updateProjectionMatrix();
      gl.render(scene, camera);
      return canvas;
    },
    end() {
      gl.setPixelRatio(prevDpr);
      gl.setSize(prevSize.x, prevSize.y, false);
      camera.aspect = prevAspect;
      camera.updateProjectionMatrix();
      gl.setClearColor(prevClear, prevAlpha);
      gl.render(scene, camera);
    },
  };
}

// Compose the (transparent) WebGL frame onto a pure-white 2D canvas.
// This guarantees exact (255,255,255) background pixels — WebGL clearColor
// routed through ACES tone-mapping would not land on pure white.
export function compositeOnWhite(srcCanvas, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return c;
}

// Verify the four corner pixels of a 2D canvas are exactly white.
export function verifyWhiteCorners(canvas2d) {
  const ctx = canvas2d.getContext("2d");
  const w = canvas2d.width, h = canvas2d.height;
  const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  const bad = [];
  for (const [x, y] of pts) {
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    if (!(r === 255 && g === 255 && b === 255)) bad.push({ x, y, r, g, b });
  }
  return { ok: bad.length === 0, bad };
}

export function canvasToBlob(canvas, mime, quality) {
  return new Promise((res) => canvas.toBlob(res, mime, quality));
}

// ---------- single still capture ----------
// mode: 'standard' (png/jpg on scene bg) or 'amazon' (transparent -> white composite, jpeg)
export async function captureStill(gl, scene, camera, { w, h, format, amazon }) {
  const transparent = amazon || format === "png-alpha";
  const { canvas, restore } = renderAtSize(gl, scene, camera, w, h, { transparent });
  let out, mime, quality, ext, whiteCheck = null;

  try {
    if (amazon) {
      out = compositeOnWhite(canvas, w, h);
      whiteCheck = verifyWhiteCorners(out);
      mime = "image/jpeg"; quality = 0.92; ext = "jpg";
    } else if (format === "png-alpha" || format === "png") {
      out = canvas; mime = "image/png"; quality = undefined; ext = "png";
    } else {
      // jpg on scene background — composite onto a 2D canvas so JPEG has no alpha surprises
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(canvas, 0, 0, w, h);
      out = c; mime = "image/jpeg"; quality = 0.92; ext = "jpg";
    }
    const blob = await canvasToBlob(out, mime, quality);
    return { blob, ext, w, h, whiteCheck };
  } finally {
    restore();
  }
}

// ---------- camera-work animation drivers ----------
// Each driver returns a function(t in 0..1) that mutates camera + controls target.
// baseState = { pos:[x,y,z], target:[x,y,z], up:[x,y,z] }
export function makeCameraWork(kind, baseState, opts = {}) {
  const base = new THREE.Vector3(...baseState.pos);
  const target = new THREE.Vector3(...baseState.target);
  const offset = base.clone().sub(target);
  const radius = offset.length();
  const startAngle = Math.atan2(offset.x, offset.z);
  const startY = offset.y;

  if (kind === "turntable") {
    // full Y revolution around target, keeping elevation
    return (t) => {
      const a = startAngle + t * Math.PI * 2 * (opts.dir ?? 1);
      const horiz = Math.hypot(offset.x, offset.z);
      const p = new THREE.Vector3(
        target.x + Math.sin(a) * horiz,
        base.y,
        target.z + Math.cos(a) * horiz
      );
      return { pos: p, target };
    };
  }
  if (kind === "orbit") {
    // ease in-out ping-pong sweep of ±deg around start angle
    const deg = (opts.deg ?? 30) * Math.PI / 180;
    return (t) => {
      const phase = Math.sin(t * Math.PI * 2); // out and back
      const a = startAngle + phase * deg;
      const horiz = Math.hypot(offset.x, offset.z);
      const p = new THREE.Vector3(
        target.x + Math.sin(a) * horiz,
        target.y + startY,
        target.z + Math.cos(a) * horiz
      );
      return { pos: p, target };
    };
  }
  if (kind === "dolly") {
    // ease-in-out zoom toward the model
    const endR = radius * (opts.endScale ?? 0.55);
    return (t) => {
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
      const r = radius + (endR - radius) * e;
      const dir = offset.clone().normalize();
      const p = target.clone().add(dir.multiplyScalar(r));
      return { pos: p, target };
    };
  }
  // fallback: hold
  return () => ({ pos: base, target });
}

export function applyCamState(camera, controls, st) {
  camera.position.copy(st.pos);
  camera.lookAt(st.target);
  if (controls) { controls.target.copy(st.target); controls.update(); }
}

// ---------- MP4 encoding (WebCodecs + mp4-muxer) ----------
function bitrateFor(w, h) {
  const px = w * h;
  if (px >= 1920 * 1080) return 16_000_000;
  if (px >= 1280 * 720) return 12_000_000;
  return 8_000_000;
}

export async function encodeMp4({ w, h, fps, totalFrames, drawFrame, onProgress, signal }) {
  if (typeof VideoEncoder === "undefined") throw new Error("このブラウザは WebCodecs (VideoEncoder) に未対応です");
  // even dimensions required by avc1
  const W = w - (w % 2), H = h - (h % 2);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H },
    fastStart: "in-memory",
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; },
  });
  encoder.configure({
    codec: "avc1.640028",
    width: W, height: H,
    bitrate: bitrateFor(W, H),
    framerate: fps,
  });

  const usPerFrame = 1_000_000 / fps;
  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) { encoder.close(); throw new DOMException("aborted", "AbortError"); }
    const srcCanvas = await drawFrame(i, W, H);
    const frame = new VideoFrame(srcCanvas, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) });
    encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps)) === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 0));
    }
    onProgress && onProgress((i + 1) / totalFrames);
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  const { buffer } = muxer.target;
  return new Blob([buffer], { type: "video/mp4" });
}

// GIF guardrails: long edge <= 500px, effective fps <= 15 (keeps quantize cheap
// and file size sane). Returns the reduced output dims so the caller can render
// the offscreen buffer directly at GIF size (no wasteful downscale of a huge frame).
export function gifDims(w, h) {
  const longEdge = Math.max(w, h);
  const scale = longEdge > 500 ? 500 / longEdge : 1;
  return { w: Math.max(2, Math.round(w * scale)), h: Math.max(2, Math.round(h * scale)) };
}

// ---------- GIF encoding (gifenc) ----------
// drawFrame(i) must return a canvas already at gifDims size (gw×gh).
export async function encodeGif({ gw, gh, fps, totalFrames, drawFrame, onProgress, signal }) {
  const effFps = Math.min(15, fps);
  const frameStep = Math.max(1, Math.round(fps / effFps));
  const delay = Math.round(1000 / effFps);

  const gif = GIFEncoder();
  const tmp = document.createElement("canvas");
  tmp.width = gw; tmp.height = gh;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });

  let emitted = 0;
  const emitCount = Math.ceil(totalFrames / frameStep);
  for (let i = 0; i < totalFrames; i += frameStep) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const srcCanvas = await drawFrame(i);
    tctx.clearRect(0, 0, gw, gh);
    tctx.drawImage(srcCanvas, 0, 0, gw, gh);
    const { data } = tctx.getImageData(0, 0, gw, gh);
    const palette = quantize(data, 256, { format: "rgb565" });
    const index = applyPalette(data, palette, "rgb565");
    gif.writeFrame(index, gw, gh, { palette, delay });
    emitted++;
    onProgress && onProgress(emitted / emitCount);
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return { blob: new Blob([gif.bytes()], { type: "image/gif" }), w: gw, h: gh };
}

// ---------- PNG sequence -> ZIP ----------
export async function encodePngSeq({ w, h, totalFrames, drawFrame, baseName, onProgress, signal }) {
  const pad = String(totalFrames).length;
  const entries = [];
  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const srcCanvas = await drawFrame(i, w, h);
    const blob = await canvasToBlob(srcCanvas, "image/png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    entries.push({ name: `${baseName}_${String(i).padStart(pad, "0")}.png`, bytes });
    onProgress && onProgress((i + 1) / totalFrames);
    await new Promise((r) => setTimeout(r, 0));
  }
  return buildZip(entries);
}

// ---------- batch still ZIP ----------
export async function zipBlobs(list) {
  const entries = [];
  for (const { name, blob } of list) {
    entries.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return buildZip(entries);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
