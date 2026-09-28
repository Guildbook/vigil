// Bundles the main process, preload and window with esbuild. `@/` resolves to shared/, the combat log parser and
// Vigil analysis vendored from the Guildbook site (see README, "Shared code").
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const dist = path.join(pkg, "dist");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// The home server of packaged builds: every API call goes there, and guild sites must be its subdomains or
// custom domains it names. Self-hosters build with their own. Development runs ignore it (see src/main/store.ts).
const homeUrl = homeOrigin(process.env.VIGIL_HOME_URL ?? "https://guildbook.io");

function homeOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const local = url && /(^|\.)localhost$|^127\.|^10\.|^192\.168\.|^\[::1\]$/.test(url.hostname);
  if (!url || url.protocol !== "https:" || url.port || url.username || local) {
    console.error(`VIGIL_HOME_URL must be a public https origin without a port, not ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return url.origin;
}

const common = {
  bundle: true,
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  alias: { "@": path.join(pkg, "shared") },
  define: { __HOME_URL__: JSON.stringify(homeUrl) },
};

function copyStatic() {
  const out = path.join(dist, "renderer");
  mkdirSync(path.join(out, "fonts"), { recursive: true });
  for (const f of ["index.html", "styles.css"]) cpSync(path.join(pkg, "src", "renderer", f), path.join(out, f));
  const fonts = [
    ["cinzel", "cinzel-latin-400-normal.woff2"],
    ["cinzel", "cinzel-latin-700-normal.woff2"],
    ["inter", "inter-latin-400-normal.woff2"],
    ["inter", "inter-latin-600-normal.woff2"],
  ];
  for (const [family, file] of fonts) {
    cpSync(path.join(pkg, "node_modules", "@fontsource", family, "files", file), path.join(out, "fonts", file));
  }
}

const copyPlugin = {
  name: "copy-static",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyStatic();
    });
  },
};

rmSync(dist, { recursive: true, force: true });

const configs = [
  {
    ...common,
    entryPoints: { main: path.join(pkg, "src/main/main.ts"), preload: path.join(pkg, "src/main/preload.ts") },
    outdir: dist,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: { main: path.join(pkg, "src/renderer/main.ts") },
    outdir: path.join(dist, "renderer"),
    platform: "browser",
    format: "iife",
    target: "chrome138",
    plugins: [copyPlugin],
  },
];

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  // Static files are not part of the renderer graph; copy them again when they change.
  const { watch: fsWatch } = await import("node:fs");
  fsWatch(path.join(pkg, "src", "renderer"), (_event, file) => {
    if (file && /\.(html|css)$/.test(file)) copyStatic();
  });
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
