// Draws the tray icons into resources/tray/ (packaged as extraResources): `pnpm icons:tray`.
// The glyph is the app icon's eye (build/icon.png) reduced to what reads at 16 to 24 px. No image libraries: shapes
// are signed distance functions, supersampled per pixel, and written as PNG (and PNG-in-ICO) with node:zlib.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

type Rgba = [number, number, number, number];
/** A layer: coverage at a point in glyph units (0 to 1, where 1 is fully inside), and its colour. */
type Layer = { color: Rgba; cover: (x: number, y: number) => number };

const OUT = path.resolve(__dirname, "..", "resources", "tray");
const SAMPLES = 8;

const BLACK: Rgba = [0, 0, 0, 255];
const INK: Rgba = [26, 12, 14, 255];
const CREAM: Rgba = [240, 232, 214, 255];
const GOLD: Rgba = [214, 172, 74, 255];
const CRIMSON: Rgba = [118, 20, 36, 255];
const AMBER: Rgba = [255, 154, 46, 255];

const inside = (d: number) => (d <= 0 ? 1 : 0);
const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) - r;

/** The almond: two arcs through the corners (cx +/- halfW, cy) and the lid apexes (cx, cy +/- halfH). */
function almond(cx: number, cy: number, halfW: number, halfH: number) {
  const r = (halfW * halfW + halfH * halfH) / (2 * halfH);
  const top = circle(cx, cy - halfH + r, r);
  const bottom = circle(cx, cy + halfH - r, r);
  return (x: number, y: number) => Math.max(top(x, y), bottom(x, y));
}

function roundedRect(x0: number, y0: number, x1: number, y1: number, radius: number) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - radius;
  const hh = (y1 - y0) / 2 - radius;
  return (x: number, y: number) => {
    const dx = Math.max(Math.abs(x - cx) - hw, 0);
    const dy = Math.max(Math.abs(y - cy) - hh, 0);
    return Math.hypot(dx, dy) - radius;
  };
}

type Variant = "normal" | "attention" | "paused";

/** macOS template: black with alpha only, so the menu bar tints it for light and dark. */
function templateLayers(variant: Variant): Layer[] {
  const eye = almond(0.5, 0.5, 0.47, 0.29);
  const stroke = 0.085;
  const iris = circle(0.5, 0.5, 0.2);
  const pupil = circle(0.5, 0.5, 0.085);
  const dot = circle(0.84, 0.84, 0.15);
  const dotGap = circle(0.84, 0.84, 0.23);
  const alpha = variant === "paused" ? 0.45 : 1;
  const hole = (x: number, y: number) => variant === "attention" && dotGap(x, y) <= 0;
  const layers: Layer[] = [
    {
      color: [0, 0, 0, Math.round(255 * alpha)],
      cover: (x, y) => {
        if (hole(x, y)) return 0;
        const ring = Math.abs(eye(x, y) + stroke / 2) <= stroke / 2;
        const disc = iris(x, y) <= 0 && pupil(x, y) > 0;
        return ring || disc ? 1 : 0;
      },
    },
  ];
  if (variant === "attention") layers.push({ color: BLACK, cover: (x, y) => inside(dot(x, y)) });
  return layers;
}

/** Windows and Linux: the app icon in miniature, a crimson tile with a gold rim and the cream eye. */
function colorLayers(variant: Variant): Layer[] {
  const tile = roundedRect(0.02, 0.02, 0.98, 0.98, 0.2);
  const rim = 0.07;
  const eye = almond(0.5, 0.5, 0.4, 0.25);
  const iris = circle(0.5, 0.5, 0.17);
  const pupil = circle(0.5, 0.5, 0.075);
  const edge = 0.05;
  const dot = circle(0.8, 0.8, 0.17);
  const dotRing = circle(0.8, 0.8, 0.23);
  const fade = variant === "paused" ? 0.5 : 1;
  const faded = (c: Rgba): Rgba => [c[0], c[1], c[2], Math.round(c[3] * fade)];
  const layers: Layer[] = [
    { color: faded(GOLD), cover: (x, y) => inside(tile(x, y)) },
    { color: faded(CRIMSON), cover: (x, y) => inside(tile(x, y) + rim) },
    { color: faded(INK), cover: (x, y) => inside(eye(x, y) - edge / 2) },
    { color: faded(CREAM), cover: (x, y) => inside(eye(x, y) + edge / 2) },
    { color: faded(INK), cover: (x, y) => inside(iris(x, y) - edge / 2) },
    { color: faded(GOLD), cover: (x, y) => inside(iris(x, y) + edge / 2) },
    { color: faded(INK), cover: (x, y) => inside(pupil(x, y)) },
  ];
  if (variant === "attention") {
    layers.push({ color: INK, cover: (x, y) => inside(dotRing(x, y)) });
    layers.push({ color: AMBER, cover: (x, y) => inside(dot(x, y)) });
  }
  return layers;
}

/** Straight-alpha RGBA pixels, each averaged from SAMPLES x SAMPLES points composited back to front. */
function rasterize(px: number, layers: Layer[]): Buffer {
  const out = Buffer.alloc(px * px * 4);
  for (let py = 0; py < px; py++) {
    for (let pxX = 0; pxX < px; pxX++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (pxX + (sx + 0.5) / SAMPLES) / px;
          const y = (py + (sy + 0.5) / SAMPLES) / px;
          // Premultiplied "over", back to front.
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const layer of layers) {
            const la = (layer.cover(x, y) * layer.color[3]) / 255;
            if (la <= 0) continue;
            cr = layer.color[0] * la + cr * (1 - la);
            cg = layer.color[1] * la + cg * (1 - la);
            cb = layer.color[2] * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SAMPLES * SAMPLES;
      const i = (py * px + pxX) * 4;
      const alpha = a / n;
      out[i] = alpha ? Math.round(r / n / alpha) : 0;
      out[i + 1] = alpha ? Math.round(g / n / alpha) : 0;
      out[i + 2] = alpha ? Math.round(b / n / alpha) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(px: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  const rows = Buffer.alloc(px * (px * 4 + 1));
  for (let y = 0; y < px; y++) rgba.copy(rows, y * (px * 4 + 1) + 1, y * px * 4, (y + 1) * px * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An ICO whose entries are PNGs (supported since Windows Vista), smallest first. */
function ico(images: { px: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ px, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(px >= 256 ? 0 : px, 0);
    e.writeUInt8(px >= 256 ? 0 : px, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const draw = (px: number, layers: Layer[]) => png(px, rasterize(px, layers));

mkdirSync(OUT, { recursive: true });
const write = (name: string, data: Buffer) => {
  writeFileSync(path.join(OUT, name), data);
  console.log(`resources/tray/${name}`);
};

for (const variant of ["normal", "attention", "paused"] as const) {
  const suffix = variant === "normal" ? "" : `-${variant}`;
  // macOS: 18 pt in the 22 pt menu bar. The name must end in "Template" for Electron to treat it as one.
  write(`tray${suffix}Template.png`, draw(18, templateLayers(variant)));
  write(`tray${suffix}Template@2x.png`, draw(36, templateLayers(variant)));
  // Windows: the notification area picks 16, 20, 24 or 32 px by display scale.
  write(`tray${suffix}.ico`, ico([16, 20, 24, 32].map((px) => ({ px, data: draw(px, colorLayers(variant)) }))));
  // Linux (AppIndicator and the legacy tray): 24 px, which 22 px panels scale down.
  write(`tray${suffix}.png`, draw(24, colorLayers(variant)));
}
