// Writes a synthetic combat log into a folder in real time, as the client would, so the companion can be
// tried without the game: `pnpm demo:log /tmp/vigil-demo/Logs` and point the companion at that folder.
// Rhune (Protection Warrior) fights a Defias Pillager, then Rhahk'Zor; the cycle repeats.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { warriorLog } from "../test/support/combatlog";

const dir = path.resolve(process.argv[2] ?? "/tmp/vigil-demo/Logs");
const speed = Number(process.env.DEMO_SPEED ?? 1);
const cycles = Number(process.env.DEMO_CYCLES ?? 3);
const LEAD_MS = 3_000;
const CYCLE_MS = 110_000;

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
const file = path.join(dir, `WoWCombatLog-${stamp}.txt`);
writeFileSync(file, "");
console.log(`Writing ${file}`);

/** "9/28/2026 14:03:05.120+0  ..." back to epoch ms (tzHours is 0, so the stamp is UTC). */
function lineTime(line: string): number {
  const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)\.(\d+)/.exec(line)!;
  const [mo, d, y, h, mi, s, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

const wall0 = Date.now();
const lines: { at: number; text: string }[] = [];
for (let c = 0; c < cycles; c++) {
  const start = new Date(wall0 + LEAD_MS + c * CYCLE_MS);
  const text = warriorLog({ start, tzHours: 0 }).trimEnd().split("\n");
  // The header only belongs at the top of the file.
  for (const line of c === 0 ? text : text.slice(1)) lines.push({ at: lineTime(line), text: line });
}
lines.sort((a, b) => a.at - b.at);

let i = 0;
const timer = setInterval(() => {
  const due = wall0 + (Date.now() - wall0) * speed;
  const batch: string[] = [];
  while (i < lines.length && lines[i]!.at <= due) batch.push(lines[i++]!.text);
  // The client flushes in bursts, often mid-line; split the last line to exercise partial reads.
  if (batch.length) {
    const chunk = `${batch.join("\n")}\n`;
    const cut = i < lines.length && batch.length > 3 ? chunk.length - 7 : chunk.length;
    appendFileSync(file, chunk.slice(0, cut));
    if (cut < chunk.length) setTimeout(() => appendFileSync(file, chunk.slice(cut)), 120);
  }
  if (i >= lines.length) {
    clearInterval(timer);
    console.log("Done.");
  }
}, 400);
