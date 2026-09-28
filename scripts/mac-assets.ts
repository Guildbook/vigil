// Draws the macOS packaging assets into build/: `pnpm mac:assets` (macOS only, it needs sips and iconutil).
//   build/icon.icns                        the app and dmg volume icon, from build/icon-mac.png, every size 16 to 1024
//   build/background.png, background@2x.png the dmg window, in the Guildbook link previews' language
// iconutil stores 16 and 32 px as ARGB, which is what Finder reads for those slots. electron-builder's own PNG to
// icns conversion puts PNGs there, which Finder decodes as noise (the dmg title bar and small Finder and Dock icons).
// The background is rasterized with resvg using the bundled Cinzel fonts (scripts/fonts, SIL OFL).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const FONTS = ["Cinzel-Regular.ttf", "Cinzel-Bold.ttf"].map((f) => path.join(ROOT, "scripts/fonts", f));

/**
 * The dmg window's layout; electron-builder.config.cjs repeats it (dmg.window, iconSize, iconTextSize, contents).
 * dmg.window is the whole window, title bar included (32 pt on macOS 26), so the window is 452 tall for 420 of
 * content, and the image runs 40 past that in plain ink in case the title bar is shorter.
 */
const DMG = { width: 660, height: 420, bleed: 40, iconSize: 112, app: { x: 180, y: 206 }, applications: { x: 480, y: 206 } };
/** Finder draws each label (12 pt) centered this far below its icon's center, always in black on a picture. */
const LABEL_DROP = 73;

const INK = "#0b0908";
const GOLD = "#c9a44c";
const BONE = "#ece4d4";

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });

function icns() {
  const work = mkdtempSync(path.join(tmpdir(), "vigil-icns-"));
  const set = path.join(work, "icon.iconset");
  const source = path.join(BUILD, "icon-mac.png");
  try {
    run("mkdir", [set]);
    for (const px of [16, 32, 128, 256, 512]) {
      run("sips", ["-z", String(px), String(px), source, "--out", path.join(set, `icon_${px}x${px}.png`)]);
      run("sips", ["-z", String(px * 2), String(px * 2), source, "--out", path.join(set, `icon_${px}x${px}@2x.png`)]);
    }
    run("iconutil", ["-c", "icns", set, "-o", path.join(BUILD, "icon.icns")]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log("wrote build/icon.icns");
}

const lozenge = (cx: number, cy: number, r: number, opacity: number) =>
  `<path d="M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z" fill="${GOLD}" fill-opacity="${opacity}"/>`;

const RULE = `<stop offset="0" stop-color="${GOLD}" stop-opacity="0"/><stop offset="0.2" stop-color="${GOLD}"/><stop offset="0.5" stop-color="#e6c877"/><stop offset="0.8" stop-color="${GOLD}"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/>`;

/** A brass nameplate under an icon, so Finder's black label reads on the ink in light and dark mode alike. */
function plate(cx: number, cy: number) {
  const [pw, ph] = [108, 20];
  return `<rect x="${cx - pw / 2}" y="${cy - ph / 2}" width="${pw}" height="${ph}" rx="4" fill="url(#brass)" stroke="#5c4620" stroke-width="1"/>
    <rect x="${cx - pw / 2 + 1.5}" y="${cy - ph / 2 + 1.5}" width="${pw - 3}" height="${ph - 3}" rx="3" fill="none" stroke="#f6e3a8" stroke-opacity="0.55" stroke-width="0.75"/>`;
}

/**
 * The window: ink with a crimson glow behind each icon slot, a gold arrow between them, a nameplate under each for
 * Finder's label, the wordmark above and the instruction below.
 */
function background() {
  const { width: w, height: h, bleed, iconSize, app, applications } = DMG;
  const cx = w / 2;
  const y = app.y;
  const arrowFrom = app.x + iconSize / 2 + 30;
  const arrowTo = applications.x - iconSize / 2 - 30;
  const halo = (x: number) => `<circle cx="${x}" cy="${y}" r="${iconSize * 0.95}" fill="url(#halo)"/>`;
  const body = `<defs>
      <radialGradient id="glow" cx="0.5" cy="0" r="0.85"><stop offset="0" stop-color="${GOLD}" stop-opacity="0.12"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
      <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#a8182f" stop-opacity="0.34"/><stop offset="1" stop-color="#a8182f" stop-opacity="0"/></radialGradient>
      <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient>
      <linearGradient id="rule" x1="0" x2="1">${RULE}</linearGradient>
      <linearGradient id="shaft" x1="0" x2="1"><stop offset="0" stop-color="${GOLD}" stop-opacity="0"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0.85"/></linearGradient>
      <linearGradient id="title" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2dc98"/><stop offset="1" stop-color="${GOLD}"/></linearGradient>
      <linearGradient id="brass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ecd28a"/><stop offset="1" stop-color="#c29c4a"/></linearGradient>
      <filter id="grain" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h + bleed}"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.79 0 0 0 0 0.64 0 0 0 0 0.3 0 0 0 0.05 0"/></filter>
    </defs>
    <rect width="${w}" height="${h + bleed}" fill="${INK}"/>
    <rect width="${w}" height="${h}" fill="url(#glow)"/>
    <rect width="${w}" height="${h + bleed}" filter="url(#grain)"/>
    <rect width="${w}" height="${h}" fill="url(#vignette)"/>
    <rect y="${h}" width="${w}" height="${bleed}" fill="#000" fill-opacity="0.45"/>
    <text x="${cx}" y="66" text-anchor="middle" font-family="Cinzel" font-size="30" font-weight="700" letter-spacing="9" fill="url(#title)">VIGIL</text>
    <rect x="${cx - 150}" y="84" width="300" height="1" fill="url(#rule)" opacity="0.45"/>
    ${lozenge(cx, 84.5, 3.5, 0.6)}
    ${halo(app.x)}
    ${halo(applications.x)}
    ${plate(app.x, y + LABEL_DROP)}
    ${plate(applications.x, y + LABEL_DROP)}
    <rect x="${arrowFrom}" y="${y - 0.75}" width="${arrowTo - arrowFrom - 2}" height="1.5" fill="url(#shaft)"/>
    <path d="M${arrowTo - 11} ${y - 9} L${arrowTo} ${y} L${arrowTo - 11} ${y + 9}" fill="none" stroke="${GOLD}" stroke-opacity="0.9" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="${cx - 200}" y="${h - 84}" width="400" height="1" fill="url(#rule)" opacity="0.3"/>
    ${lozenge(cx, h - 83.5, 3, 0.5)}
    <text x="${cx}" y="${h - 48}" text-anchor="middle" font-family="Cinzel" font-size="16" letter-spacing="2" fill="${BONE}" fill-opacity="0.88">Drag Vigil to Applications</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + bleed}" viewBox="0 0 ${w} ${h + bleed}">${body}</svg>`;
}

function png(svg: string, width: number) {
  const font = { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Cinzel" };
  return new Resvg(svg, { font, fitTo: { mode: "width", value: width } }).render().asPng();
}

function write(name: string, data: Buffer) {
  writeFileSync(path.join(BUILD, name), data);
  console.log(`wrote build/${name}`);
}

if (process.platform !== "darwin") throw new Error("mac:assets needs macOS (sips and iconutil)");
icns();
const svg = background();
write("background.png", png(svg, DMG.width));
write("background@2x.png", png(svg, DMG.width * 2));
