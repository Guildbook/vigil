import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const dirs = ["src", "shared"].map((d) => path.join(root, d));
const MIDDOT = String.fromCharCode(0xb7);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("house style", () => {
  // ESLint covers string literals; this also covers the window's HTML and CSS (content: "..." and so on).
  it("has no middots anywhere in the app's source, markup or styles", () => {
    const offenders = dirs
      .flatMap(files)
      .filter((f) => /\.(ts|html|css)$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes(MIDDOT))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
