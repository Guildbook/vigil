// Regenerates src/data/spell-icons.json and src/data/boss-spells.json from Blizzard's WoW Classic Era client
// tables, exported as CSV by wago.tools (a mirror of the game's DB2 files). No credentials needed.
//
//   pnpm icons:generate                      # default build (CLASSIC_ERA_BUILD)
//   pnpm icons:generate --build 1.15.9.69722
//   pnpm icons:generate --verify-cdn         # also check every icon on Blizzard's render CDN (about 1,700 requests)
//
// With BATTLENET_CLIENT_ID and BATTLENET_CLIENT_SECRET in the environment it also compares the boss spells'
// icons with the Game Data API's spell media (retail namespace; Classic namespaces have no spell media). The
// secrets are only used by this script and never end up in the app.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOSSES } from "../src/data/bosses";
import { buildIconData, CLASSIC_ERA_BUILD, iconFromMedia, parseCsv, type Row } from "./icon-data";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "..", "src", "data");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const build = option("--build") ?? CLASSIC_ERA_BUILD;
const cacheDir = path.join(os.tmpdir(), `vigil-db2-${build}`);

async function table(name: string): Promise<Row[]> {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${name}.csv`);
  if (!existsSync(file)) {
    const url = `https://wago.tools/db2/${name}/csv?build=${encodeURIComponent(build)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    writeFileSync(file, await res.text());
  }
  return parseCsv(readFileSync(file, "utf8"));
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

async function verifyCdn(icons: string[]): Promise<string[]> {
  const missing: string[] = [];
  await pool(icons, 8, async (name) => {
    const res = await fetch(`https://render.worldofwarcraft.com/us/icons/36/${name}.jpg`, { method: "HEAD" });
    if (!res.ok) missing.push(name);
  });
  return missing.sort();
}

async function blizzardCheck(ids: number[], icons: (id: number) => string | undefined) {
  const id = process.env.BATTLENET_CLIENT_ID;
  const secret = process.env.BATTLENET_CLIENT_SECRET;
  if (!id || !secret) return;
  const region = process.env.BATTLENET_REGION ?? "us";
  const tokenRes = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) throw new Error(`Battle.net token request failed (${tokenRes.status})`);
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };
  let same = 0;
  const differ: string[] = [];
  const absent: number[] = [];
  await pool(ids, 4, async (spell) => {
    const res = await fetch(`https://${region}.api.blizzard.com/data/wow/media/spell/${spell}?namespace=static-${region}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const api = res.ok ? iconFromMedia(await res.json()) : null;
    if (!api) absent.push(spell);
    else if (api === icons(spell)) same++;
    else differ.push(`${spell}: client ${icons(spell)}, API ${api}`);
  });
  console.log(`Game Data API spell media: ${same} match, ${differ.length} differ, ${absent.length} not in the retail namespace.`);
  for (const d of differ) console.log(`  ${d}`);
  if (absent.length) console.log(`  Not found: ${absent.sort((a, b) => a - b).join(", ")}`);
}

async function main() {
  const [manifest, spellMisc, spellNames, classOptions] = await Promise.all(
    ["ManifestInterfaceData", "SpellMisc", "SpellName", "SpellClassOptions"].map(table),
  );
  const data = buildIconData(
    { manifest: manifest!, spellMisc: spellMisc!, spellNames: spellNames!, classOptions: classOptions! },
    { source: "World of Warcraft Classic Era client tables (SpellMisc, ManifestInterfaceData, SpellName, SpellClassOptions)", build },
  );
  const previous = existsSync(path.join(out, "spell-icons.json"))
    ? (JSON.parse(readFileSync(path.join(out, "spell-icons.json"), "utf8")) as { missing?: string[] })
    : null;
  data.missing = flag("--verify-cdn") ? await verifyCdn(data.icons) : (previous?.missing ?? []).filter((m) => data.icons.includes(m));
  writeFileSync(path.join(out, "spell-icons.json"), `${JSON.stringify(data)}\n`);
  console.log(`spell-icons.json: ${Object.keys(data.spells).length} spells, ${data.icons.length} icons, ${data.missing.length} missing on the CDN.`);

  const names = new Map(spellNames!.map((r) => [Number(r.ID), r.Name_lang ?? ""]));
  const bossIds = [...new Set(BOSSES.flatMap((b) => b.abilities.flatMap((a) => a.spellIds)))].sort((a, b) => a - b);
  const bossSpells: Record<string, string | null> = {};
  for (const id of bossIds) bossSpells[id] = names.get(id) ?? null;
  writeFileSync(path.join(out, "boss-spells.json"), `${JSON.stringify({ build, spells: bossSpells }, null, 2)}\n`);
  const unknown = bossIds.filter((id) => !names.has(id));
  console.log(`boss-spells.json: ${bossIds.length} spells${unknown.length ? `, not in the client: ${unknown.join(", ")}` : ""}.`);

  await blizzardCheck(bossIds, (id) => {
    const i = data.spells[id];
    return i === undefined ? undefined : data.icons[i];
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
