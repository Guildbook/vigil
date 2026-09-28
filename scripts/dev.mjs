// Builds, keeps esbuild watching, and runs Electron. Window code reloads on change; restart for main process edits.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { devElectron } from "./dev-app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const electron = devElectron(require("electron"), pkg);

rmSync(path.join(pkg, "dist"), { recursive: true, force: true });
const watcher = spawn(process.execPath, [path.join(here, "build.mjs"), "--watch"], { cwd: pkg, stdio: "inherit" });

const started = Date.now();
while (!existsSync(path.join(pkg, "dist", "main.js")) || !existsSync(path.join(pkg, "dist", "renderer", "index.html"))) {
  if (Date.now() - started > 30_000) {
    console.error("The first build did not finish within 30 s.");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}

const app = spawn(electron, ["."], { cwd: pkg, stdio: "inherit", env: { ...process.env, VIGIL_DEV: "1" } });
app.on("exit", (code) => {
  watcher.kill();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => {
  app.kill();
  watcher.kill();
});
