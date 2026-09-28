// Draws the in-game addon icon, resources/addon/Vigil/Vigil.tga (the TOC's IconTexture): `pnpm addon:icon`.
// A crop of the app icon (build/icon.png) around the eye, so it still reads in the AddOn List's ~20 px slot. WoW wants
// a power-of-two TGA: 64x64, 32-bit BGRA, uncompressed, rows stored bottom-up (origin bottom-left, descriptor 0x08).
// No image libraries: the PNG is decoded with node:zlib and box-filtered in premultiplied alpha.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "build", "icon.png");
const OUT = path.join(ROOT, "resources", "addon", "Vigil", "Vigil.tga");
const SIZE = 64;
/** The square taken from the 1024 px app icon: the crimson field and the eye, without the gold frame. */
const CROP = { x: 128, y: 128, size: 768 };

type Image = { width: number; height: number; rgba: Buffer };

/** 8-bit RGBA, non-interlaced PNGs only, which is what build/icon.png is. */
function decodePng(file: Buffer): Image {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = data.subarray(8);
      if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error("expected 8-bit RGBA, non-interlaced");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[row + i - 4]! : 0;
      const b = y > 0 ? rgba[row - stride + i]! : 0;
      const c = i >= 4 && y > 0 ? rgba[row - stride + i - 4]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[row + i] = (line[i]! + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Averages each (size / px)-square block of the crop into one pixel, weighting colour by alpha. */
function cropAndShrink(img: Image, crop: typeof CROP, px: number): Buffer {
  const scale = crop.size / px;
  if (!Number.isInteger(scale)) throw new Error("crop size must be a multiple of the output size");
  const out = Buffer.alloc(px * px * 4);
  for (let oy = 0; oy < px; oy++) {
    for (let ox = 0; ox < px; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((crop.y + oy * scale + sy) * img.width + crop.x + ox * scale + sx) * 4;
          const alpha = img.rgba[i + 3]!;
          r += img.rgba[i]! * alpha;
          g += img.rgba[i + 1]! * alpha;
          b += img.rgba[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (oy * px + ox) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / (scale * scale));
    }
  }
  return out;
}

/** Uncompressed true-colour TGA, BGRA, bottom-left origin (the TGA default, and what WoW's loader expects). */
function tga(px: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(18);
  header.writeUInt8(2, 2); // uncompressed true-colour
  header.writeUInt16LE(px, 12);
  header.writeUInt16LE(px, 14);
  header.writeUInt8(32, 16); // bits per pixel
  header.writeUInt8(0x08, 17); // 8 alpha bits, origin bottom-left
  const pixels = Buffer.alloc(px * px * 4);
  for (let y = 0; y < px; y++) {
    const dst = (px - 1 - y) * px * 4;
    for (let x = 0; x < px; x++) {
      const s = (y * px + x) * 4;
      const d = dst + x * 4;
      pixels[d] = rgba[s + 2]!;
      pixels[d + 1] = rgba[s + 1]!;
      pixels[d + 2] = rgba[s]!;
      pixels[d + 3] = rgba[s + 3]!;
    }
  }
  return Buffer.concat([header, pixels]);
}

writeFileSync(OUT, tga(SIZE, cropAndShrink(decodePng(readFileSync(SOURCE)), CROP, SIZE)));
console.log(path.relative(ROOT, OUT));
