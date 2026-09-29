// Replays a WoWCombatLog.txt through the live session, as the companion tails it, and prints one line per fight:
// targets, duration, damage, DPS, whether a known boss was recognised and whether the report passes the upload
// schema. Usage: pnpm replay:log <path to WoWCombatLog.txt> [--json]
import { readFileSync } from "node:fs";
import { splitLines } from "@/lib/combatlog/lines";
import { LiveSession } from "@/lib/vigil/live";
import { fightReportSchema } from "@/lib/vigil/report";
import { bossAmong } from "../src/core/intel";
import { asBossFight } from "../src/core/uploader";

const file = process.argv[2];
if (!file) {
  console.error("Usage: pnpm replay:log <path to WoWCombatLog.txt> [--json]");
  process.exit(1);
}

const session = new LiveSession();
for (const line of splitLines(readFileSync(file, "utf8"))) session.pushLine(line);
session.finish();

const rows = session.drainCompleted().map(({ report: analysed }) => {
  const report = asBossFight(analysed);
  const parsed = fightReportSchema.safeParse(report);
  return {
    label: report.fight.label,
    targets: report.fight.targets.map((t) => t.name).join(", "),
    seconds: Math.round(report.fight.durationMs / 100) / 10,
    damage: report.totals.damage,
    dps: report.totals.dps,
    boss: bossAmong(report.fight.targets)?.name ?? (report.fight.kind === "boss" ? report.fight.label : null),
    level: report.player.level,
    schema: parsed.success ? "ok" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
});

console.log(`${session.player?.name ?? "Unknown"} (log version ${session.header.version}, build ${session.header.build})`);
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else console.table(rows);
