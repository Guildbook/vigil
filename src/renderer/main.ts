import { CLASS_INFO, FACTION_LABELS, type Faction, type WowClass } from "@/lib/game";
import { LOG_VERSION_LABELS, type LogGameVersion } from "@/lib/vigil/game-version";
import type { Callout, LiveFight } from "@/lib/vigil/live";
import type { Boss, BossAbility, Instance } from "../data/bosses";
import { ADDON_ACTION_LABEL, addonStatus } from "../core/addon-status";
import type { GroupAbilityView, GroupFightView, GroupPlayerView } from "../core/group";
import { bossByKey, bossesByInstance, instanceById, searchBosses, type InstanceGroup } from "../core/intel";
import type { AppState, CompanionBridge, FightSummary, Identity, Settings } from "../core/protocol";

declare global {
  interface Window {
    vigil: CompanionBridge;
  }
}

const api = window.vigil;
const root = document.getElementById("app")!;

let state: AppState | null = null;
let view: "live" | "settings" | "intel" | "fight" = "live";
let intelKind: Instance["kind"] = "dungeon";
/** The instance open in each Intel tab. */
const intelInstance: Record<Instance["kind"], string> = { dungeon: "deadmines", raid: "mc" };
let intelBoss: string | null = null;
let intelQuery = "";
/** The fight open in the detail view: a FightSummary id, or a group fight id when there is no summary. */
let detailId: string | null = null;
let meter: "damage" | "healing" = "damage";
let seenCallouts = new Set<string>();
let pairLink: { code: string } | null = null;
let pairMessage: { ok: boolean; text: string } | null = null;
let addonMessage: { ok: boolean; text: string } | null = null;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const tone = (score: number) => (score >= 85 ? "tone-high" : score >= 65 ? "tone-mid" : "tone-low");
const metricUnit = (m: LiveFight["metric"]) => (m === "threat" ? "TPS" : m === "healing" ? "HPS" : "DPS");

function num(v: number) {
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

/* Icons. Spell icons and portraits are Blizzard art served by the main process (vigil-media://, cached from
   Blizzard's render CDN); class and faction icons ship with the app. */

const ENVIRONMENT_ICONS: Record<string, string> = {
  lava: "spell_fire_volcano",
  fire: "spell_fire_fire",
  falling: "ability_rogue_quickrecovery",
  drowning: "spell_shadow_demonbreath",
  slime: "ability_creature_poison_03",
  fatigue: "spell_nature_sleep",
};

function img(src: string, size: number, cls: string, title = "") {
  return `<img class="${cls}" src="${esc(src)}" width="${size}" height="${size}" alt="" loading="lazy" draggable="false"${title ? ` title="${esc(title)}"` : ""} />`;
}

/** An ability's icon: by spell ID (with its name as a fallback), else by name, with melee and environment drawn from known icons. */
function spellIcon(spellId: number | null, name: string, size = 18, source?: string, icon?: string) {
  const px = size > 36 ? 56 : 36;
  let src: string;
  if (icon) src = `vigil-media://icon/${px}/${icon}`;
  else if (spellId) src = `vigil-media://spell/${px}/${spellId}${name ? `?name=${encodeURIComponent(name)}` : ""}`;
  else if (name === "Melee") src = `vigil-media://icon/${px}/ability_meleedamage`;
  else if (source === "Environment" && ENVIRONMENT_ICONS[name.toLowerCase()]) src = `vigil-media://icon/${px}/${ENVIRONMENT_ICONS[name.toLowerCase()]}`;
  else src = `vigil-media://spell-name/${px}/${encodeURIComponent(name)}`;
  return img(src, size, "ic");
}

function classIcon(wowClass: WowClass | null, size = 18) {
  return wowClass
    ? img(`icons/classes/${wowClass}.jpg`, size, "ic cls", CLASS_INFO[wowClass].label)
    : img("icons/fallback.svg", size, "ic cls", "Class not known yet");
}

function factionIcon(faction: Faction, size = 14) {
  return img(`icons/factions/${faction}.jpg`, size, "ic fac", FACTION_LABELS[faction]);
}

function portrait(displayId: number | null, size: number, view: "portrait" | "zoom" = "portrait") {
  return displayId
    ? img(`vigil-media://npc/${view}/${displayId}`, size, `portrait ${view}`)
    : img("icons/fallback.svg", size, `portrait ${view}`);
}

const classColor = (c: WowClass | null) => (c ? `cc-${c}` : "");

function statusLine(s: AppState) {
  const e = s.engine;
  if (!s.logsDir) return `<span class="dot warn"></span>No WoW Logs folder found. Choose one in settings.`;
  if (!e) return `<span class="dot warn"></span>Logs folder is missing: ${esc(s.logsDir)}`;
  if (e.status.error) return `<span class="dot warn"></span>${esc(e.status.error)}`;
  if (!e.status.file) return `<span class="dot"></span>Waiting for a combat log. Type /combatlog in game.`;
  const file = e.status.file.split(/[\\/]/).pop();
  const who = e.player ? `${esc(e.player.name)}${e.player.level ? ` (${e.player.level})` : ""}` : "detecting character";
  const model = e.model ? esc(e.model.label) : s.settings.modelId === "auto" ? "detecting rotation" : "";
  const game = e.log.gameVersion ? ` ${gameBadge(e.log.gameVersion)}` : "";
  return `<span class="dot live"></span>${who}${model ? `, ${model}` : ""}${game} <span class="file" title="${esc(e.status.file)}">in ${esc(file)}</span>`;
}

const GAME_SHORT: Record<LogGameVersion, string> = { forever: "Forever", anniversary: "TBC", era: "Era", seasonal: "SoD", progression: "Progression" };

function gameBadge(v: LogGameVersion) {
  return `<span class="game-badge" title="${esc(LOG_VERSION_LABELS[v])}" data-version="${v}">${GAME_SHORT[v]}</span>`;
}

/** One line under the header when the log is from another game than the paired guild's. */
function renderGameMismatch(s: AppState) {
  const log = s.engine?.log.gameVersion ?? null;
  const guild = s.pairing.paired ? s.pairing.guild : null;
  if (!log || !guild?.gameVersion || log === guild.gameVersion) return "";
  return `<div class="update game-mismatch">This log is from ${esc(LOG_VERSION_LABELS[log])}, but ${esc(guild.name)} is a ${esc(
    LOG_VERSION_LABELS[guild.gameVersion],
  )} guild. Uploads are kept with a warning until WoW: Forever launches, then refused. Pair Vigil with your ${esc(LOG_VERSION_LABELS[log])} guild.</div>`;
}

/** Top right: the recording character's class icon, with the faction as a badge when it is known. */
function renderIdentity(id: Identity | null) {
  if (!id) return "";
  const cls = id.wowClass ? CLASS_INFO[id.wowClass].label : "class not known yet";
  const title = `${id.name}${id.level ? `, level ${id.level}` : ""} ${cls}${id.faction ? `, ${FACTION_LABELS[id.faction]}` : ""}`;
  return `<div class="identity" title="${esc(title)}">${classIcon(id.wowClass, 26)}${id.faction ? factionIcon(id.faction, 13) : ""}</div>`;
}

/* Interface icons: 16px strokes in currentColor. Shapes with class "fill" fill in when their button is on. */
const ICON_PATHS = {
  live: `<path d="M1.5 8.5h3l2-5 3 9 2-4h3" />`,
  intel: `<path d="M8 4.2C6.6 3.2 4.6 2.7 2 2.7v9.8c2.6 0 4.6.5 6 1.5 1.4-1 3.4-1.5 6-1.5V2.7c-2.6 0-4.6.5-6 1.5Z" /><path d="M8 4.2V14" />`,
  settings: `<path d="M2 4h6.7M12.3 4H14M2 8h1.7M7.3 8H14M2 12h7.2M12.8 12H14" /><circle cx="10.5" cy="4" r="1.8" /><circle cx="5.5" cy="8" r="1.8" /><circle cx="11" cy="12" r="1.8" />`,
  pin: `<path class="fill" d="M5.5 2h5M6.5 2v4L4 9h8L9.5 6V2" /><path d="M8 9v5" />`,
  shrink: `<path d="M2.5 6.5h4v-4M13.5 9.5h-4v4M6.5 6.5 2 2M9.5 9.5 14 14" />`,
  expand: `<path d="M9.5 2h4.5v4.5M6.5 14H2V9.5M14 2 9 7M2 14l5-5" />`,
  back: `<path d="M10 3 5 8l5 5" />`,
};

function icon(name: keyof typeof ICON_PATHS) {
  return `<svg class="ui-ic" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

type Tab = "live" | "intel" | "settings";
const TABS: { id: Tab; label: string; title: string }[] = [
  { id: "live", label: "Live", title: "Live fight" },
  { id: "intel", label: "Intel", title: "Boss intel" },
  { id: "settings", label: "Settings", title: "Settings" },
];

/** The fight detail belongs to Live: it opens from the fight list there. */
const activeTab = (): Tab => (view === "fight" ? "live" : view);

function renderTabs() {
  const tab = activeTab();
  return `<nav class="tabs" aria-label="Views">${TABS.map(
    (t) =>
      `<button class="tab ${t.id === tab ? "on" : ""}" data-view="${t.id}" title="${t.title}"${t.id === tab ? ` aria-current="page"` : ""}>${icon(t.id)}<span class="tab-label">${t.label}</span></button>`,
  ).join("")}</nav>`;
}

function renderTopbar(s: AppState) {
  const compact = s.settings.mode === "compact";
  const pinned = s.settings.alwaysOnTop;
  const pinLabel = pinned ? "Stop keeping on top" : "Keep on top";
  const modeLabel = compact ? "Full view" : "Compact view";
  return `
    <header class="topbar">
      <div class="topbar-row">
        <h1>VIGIL</h1>
        <div class="status">${statusLine(s)}</div>
        <div class="toggles">
          <button class="icon-btn ${pinned ? "on" : ""}" data-act="pin" title="${pinLabel}" aria-label="Keep on top" aria-pressed="${pinned}">${icon("pin")}</button>
          <button class="icon-btn" data-act="mode" title="${modeLabel}" aria-label="${modeLabel}">${icon(compact ? "expand" : "shrink")}</button>
        </div>
        ${renderIdentity(s.identity)}
      </div>
      ${compact ? "" : renderTabs()}
    </header>`;
}

function backBar(act: string, label: string) {
  return `<div class="back-bar"><button class="back" data-act="${act}">${icon("back")}<span>${label}</span></button></div>`;
}

/** One quiet line under the header when a new version is waiting. */
function renderUpdate(s: AppState) {
  const u = s.update;
  if (u.state === "ready") {
    return `<div class="update">Vigil ${esc(u.version)} is ready. <button class="link" data-act="install-update">Restart to update</button></div>`;
  }
  if (u.state === "available") {
    return `<div class="update">Vigil ${esc(u.version)} is available. <button class="link" data-open="${esc(u.downloadUrl)}">Download</button></div>`;
  }
  return "";
}

/** How long the log may sit unchanged before the Current fight panel explains why. */
const QUIET_HINT_MS = 2 * 60_000;

/** Classic clients write the log in 48 KB batches, so solo and small-group fights can arrive minutes late. */
function quietHint(s: AppState) {
  const quiet = s.engine?.status.quietMs ?? null;
  if (quiet === null || quiet < QUIET_HINT_MS) return "";
  const mins = Math.floor(quiet / 60_000);
  return `<p class="empty quiet-hint">No new combat log data for ${mins} min. WoW Classic writes the log in 48 KB batches, so solo and small-group pulls can show up minutes late (raids within seconds), and the rest is written when you log out. If logging is off, type /combatlog in game.</p>`;
}

function renderCurrent(s: AppState) {
  const f = s.engine?.current;
  if (!f) {
    return `<section class="panel"><h2>Current fight</h2><p class="empty">${
      s.engine?.status.file ? "Out of combat. The next pull shows up here." : "Nothing to follow yet."
    }</p>${quietHint(s)}</section>`;
  }
  const compact = s.settings.mode === "compact";
  const idleAlert = f.idleNowMs >= 2000;
  const stats = [
    `<div class="stat"><div class="k">GCD use</div><div class="v">${pct(f.gcdUsage)}</div></div>`,
    `<div class="stat ${idleAlert ? "alert" : ""}"><div class="k">Idle now</div><div class="v">${secs(f.idleNowMs)}</div></div>`,
    `<div class="stat"><div class="k">${metricUnit(f.metric)}</div><div class="v">${num(f.perSecond)}</div></div>`,
  ];
  if (!compact && f.readyIdleMs !== null) {
    stats.push(`<div class="stat"><div class="k">Ready idle</div><div class="v">${secs(f.readyIdleMs)}</div></div>`);
  }
  const uptimes = compact
    ? ""
    : f.uptimes
        .map(
          (u) => `
      <div class="uptime">
        <div class="label">${spellIcon(null, u.label, 16)}${esc(u.label)} <span class="pill ${u.active ? "up" : "down"}">${u.active ? "up" : "down"}</span></div>
        <div class="pct">${pct(u.pct)}</div>
        <div class="bar" title="Target ${pct(u.targetPct)}"><span data-width="${Math.round(u.pct * 100)}"></span><i data-left="${Math.round(u.targetPct * 100)}"></i></div>
      </div>`,
        )
        .join("");
  const others = f.targets.length > 1 ? ` and ${f.targets.length - 1} more` : "";
  const boss = s.engine?.group?.boss;
  return `
    <section class="panel">
      <div class="fight-head">
        ${boss ? portrait(boss.displayId, compact ? 34 : 46) : ""}
        <div class="who">
          <div class="target" title="${esc(f.targets.join(", "))}">${esc(f.label)}</div>
          <div class="sub">${f.kind === "boss" || boss ? `<span class="pill boss">Boss</span> ` : ""}${boss ? `${esc(boss.instance)}, ` : ""}${clock(f.elapsedMs)}${esc(others)}</div>
        </div>
        <div class="score ${tone(f.score)}">${Math.round(f.score)}<small>score</small></div>
      </div>
      <div class="stats">${stats.join("")}</div>
      ${uptimes}
    </section>`;
}

function renderCallouts(s: AppState) {
  const limit = s.settings.mode === "compact" ? 2 : 12;
  const list = s.callouts.slice(0, limit);
  const fresh = new Set<string>();
  const items = list
    .map((c: Callout) => {
      const isNew = !seenCallouts.has(c.id);
      fresh.add(c.id);
      return `<li class="${esc(c.kind)} ${isNew ? "fresh" : ""}"><span class="t">${clock(c.offsetMs)}</span><span class="text">${esc(c.text)}</span></li>`;
    })
    .join("");
  for (const id of fresh) seenCallouts.add(id);
  if (seenCallouts.size > 500) seenCallouts = new Set(s.callouts.map((c) => c.id));
  if (s.settings.mode === "compact" && !items) return "";
  return `<section class="panel"><h2>Callouts</h2>${items ? `<ul class="callouts">${items}</ul>` : `<p class="empty">Missed procs, idle time and dropped buffs appear here.</p>`}</section>`;
}

function uploadLine(f: FightSummary) {
  const u = f.upload;
  switch (u.state) {
    case "uploaded":
      return `<div class="upload">Uploaded. <button class="link" data-open="${esc(u.url)}">Open report</button>${u.warning ? `<div class="upload-warning">${esc(u.warning)}</div>` : ""}</div>`;
    case "failed":
      return `<div class="upload bad">${esc(u.error)}${u.retrying ? " Retrying." : u.final ? "" : ` <button class="link" data-retry="${esc(f.id)}">Retry</button>`}</div>`;
    case "skipped":
      return `<div class="upload">${esc(u.reason)}</div>`;
    case "uploading":
      return `<div class="upload">Uploading</div>`;
    default:
      return `<div class="upload">Waiting to upload</div>`;
  }
}

function renderFights(s: AppState) {
  if (s.settings.mode === "compact") return "";
  const items = s.fights
    .slice(0, 15)
    .map((f) => {
      const g = f.groupId ? s.groupFights.find((x) => x.id === f.groupId) : null;
      return `
      <li>
        <div class="fscore ${tone(f.score)}">${Math.round(f.score)}</div>
        ${g?.boss ? portrait(g.boss.displayId, 30) : ""}
        <div class="meta">
          <div class="name">${f.kind === "boss" || g?.boss ? `<span class="pill boss">Boss</span> ` : ""}${esc(f.label)}${resultPill(g?.result ?? null)}</div>
          <div class="detail">${clock(f.durationMs)}, ${pct(f.gcdUsage)} GCD, ${num(f.perSecond)} ${metricUnit(f.metric)}${f.modelLabel ? `, ${esc(f.modelLabel)}` : ""}${
            g?.deaths.length ? `, ${g.deaths.length} ${g.deaths.length === 1 ? "death" : "deaths"}` : ""
          }</div>
          ${uploadLine(f)}
        </div>
        <button class="icon" data-detail="${esc(f.id)}" title="Fight details">Details</button>
      </li>`;
    })
    .join("");
  return `<section class="panel"><h2>Recent fights</h2>${items ? `<ul class="fights">${items}</ul>` : `<p class="empty">Finished fights are listed here.</p>`}</section>`;
}

function renderLive(s: AppState) {
  const g = s.engine?.group ?? null;
  const compact = s.settings.mode === "compact";
  return renderCurrent(s) + (compact ? "" : renderLiveIntel(g) + renderGroup(g, 10)) + renderCallouts(s) + renderFights(s);
}

/* Group meter and deaths. */

function renderMeterRows(players: GroupPlayerView[], limit: number) {
  const value = (p: GroupPlayerView) => (meter === "damage" ? p.damage : p.healing);
  const rate = (p: GroupPlayerView) => (meter === "damage" ? p.dps : p.hps);
  const list = players.filter((p) => value(p) > 0).sort((a, b) => value(b) - value(a));
  const top = list[0] ? value(list[0]) : 0;
  const rows = list
    .slice(0, limit)
    .map(
      (p, i) => `
      <li class="${p.isMe ? "me" : ""}">
        <span class="rank">${i + 1}</span>${classIcon(p.wowClass)}
        <span class="pname ${classColor(p.wowClass)}">${esc(p.name)}</span>
        <span class="amount">${num(rate(p))}</span>
        <span class="mbar"><span class="${classColor(p.wowClass)}" data-width="${top ? Math.max(2, Math.round((value(p) / top) * 100)) : 0}"></span></span>
      </li>`,
    )
    .join("");
  const more = list.length > limit ? `<p class="note">${list.length - limit} more</p>` : "";
  return rows ? `<ol class="meter">${rows}</ol>${more}` : `<p class="empty">No ${meter} yet.</p>`;
}

function renderDeaths(g: GroupFightView) {
  if (!g.deaths.length) return "";
  const rows = g.deaths
    .map(
      (d) => `
      <li class="${d.isMe ? "me" : ""}">
        <span class="t">${clock(d.offsetMs)}</span>${classIcon(d.wowClass)}
        <span class="pname ${classColor(d.wowClass)}">${esc(d.name)}</span>
        ${
          d.blow
            ? `<span class="blow">${spellIcon(d.blow.spellId, d.blow.name, 16, d.blow.source)}${esc(d.blow.name)} <span class="muted">${num(d.blow.amount)}${
                d.blow.source !== "Environment" ? `, ${esc(d.blow.source)}` : ""
              }</span></span>`
            : `<span class="blow muted">No hit logged</span>`
        }
      </li>`,
    )
    .join("");
  return `<h3 class="sub-h">Deaths</h3><ul class="deaths">${rows}</ul>`;
}

function meterToggle() {
  return `<div class="seg">${(["damage", "healing"] as const)
    .map((m) => `<button class="${meter === m ? "on" : ""}" data-meter="${m}">${m === "damage" ? "Damage" : "Healing"}</button>`)
    .join("")}</div>`;
}

function renderGroup(g: GroupFightView | null, limit: number) {
  if (!g || g.players.length === 0) return "";
  return `
    <section class="panel">
      <div class="panel-head"><h2>Group</h2>${g.faction ? factionIcon(g.faction, 16) : ""}<span class="grow"></span>${meterToggle()}</div>
      ${renderMeterRows(g.players, limit)}
      ${renderDeaths(g)}
    </section>`;
}

/* Boss intel. */

const TAG_LABELS: Record<string, string> = {
  tank: "Tank",
  healer: "Healer",
  melee: "Melee",
  ranged: "Ranged",
  raid: "Raid",
  dispel: "Dispel",
  decurse: "Decurse",
  interrupt: "Interrupt",
  move: "Move",
  fear: "Fear",
  knockback: "Knockback",
  adds: "Adds",
};

/** Observed numbers for one intel ability in a fight, summed over the spell IDs and sources it covers. */
function observedFor(g: GroupFightView | null, key: string) {
  const rows = g?.abilities.filter((a) => a.intelKey === key) ?? [];
  if (!rows.length) return null;
  return {
    damage: rows.reduce((n, a) => n + a.damage, 0),
    players: Math.max(...rows.map((a) => a.players)),
    kills: rows.reduce((n, a) => n + a.kills, 0),
    debuffs: rows.reduce((n, a) => n + a.debuffs, 0),
    casts: rows.reduce((n, a) => n + a.casts, 0),
  };
}

function observedLine(o: ReturnType<typeof observedFor>) {
  if (!o) return "";
  const parts = [
    o.damage ? `${num(o.damage)} damage` : "",
    o.debuffs ? `${o.debuffs} ${o.debuffs === 1 ? "application" : "applications"}` : "",
    o.players ? `${o.players} ${o.players === 1 ? "player" : "players"}` : "",
    o.casts && !o.damage && !o.debuffs ? `cast ${o.casts === 1 ? "once" : `${o.casts} times`}` : "",
    o.kills ? `${o.kills} ${o.kills === 1 ? "death" : "deaths"}` : "",
  ].filter(Boolean);
  return `<span class="observed ${o.kills ? "bad" : ""}">${parts.join(", ")}</span>`;
}

function renderAbility(a: BossAbility, g: GroupFightView | null, full: boolean) {
  const o = observedFor(g, a.key);
  const tags = a.tags.map((t) => `<span class="pill tag">${TAG_LABELS[t]}</span>`).join("");
  return `
    <li class="ability ${o ? "seen" : ""}">
      ${spellIcon(a.spellIds[0] ?? null, a.name, full ? 36 : 22, undefined, a.icon)}
      <div class="grow">
        <div class="aname">${esc(a.name)}${a.source ? ` <span class="muted">${esc(a.source)}</span>` : ""}</div>
        ${full ? `<div class="tags">${tags}</div><p class="asum">${esc(a.summary)}</p><p class="acounter">${esc(a.counter)}</p>` : ""}
        ${full && a.uncertain ? `<p class="uncertain">Unconfirmed: ${esc(a.uncertain)}</p>` : ""}
        ${observedLine(o)}
      </div>
    </li>`;
}

function resultPill(result: GroupFightView["result"]) {
  return result ? ` <span class="pill ${result === "kill" ? "up" : "down"}">${result === "kill" ? "Kill" : "Wipe"}</span>` : "";
}

function renderLiveIntel(g: GroupFightView | null) {
  const boss = g?.boss ? bossByKey(g.boss.key) : null;
  if (!boss && g?.encounter) {
    return `
    <section class="panel">
      <div class="panel-head"><h2>Boss intel</h2></div>
      <p class="asum">No notes yet for ${esc(g.encounter.name)}. The fight is still tracked and uploaded as a boss fight.</p>
    </section>`;
  }
  if (!boss || (!boss.abilities.length && boss.status !== "full")) return "";
  if (!boss.abilities.length) {
    return `
    <section class="panel">
      <div class="panel-head"><h2>Boss intel</h2><span class="grow"></span><button class="link" data-intel="${esc(boss.key)}">All about ${esc(boss.name)}</button></div>
      <p class="asum">${esc(boss.summary)}</p>
    </section>`;
  }
  return `
    <section class="panel">
      <div class="panel-head"><h2>Boss intel</h2><span class="grow"></span><button class="link" data-intel="${esc(boss.key)}">All about ${esc(boss.name)}</button></div>
      <ul class="abilities compact">${boss.abilities.map((a) => renderAbility(a, g, false)).join("")}</ul>
    </section>`;
}

/** Hostile abilities that hit the group, with the ones the intel lists marked. */
function renderTaken(g: GroupFightView, limit = 12) {
  const list = g.abilities.filter((a) => a.damage > 0 || a.debuffs > 0).slice(0, limit);
  if (!list.length) return "";
  const top = Math.max(...list.map((a) => a.damage), 1);
  const rows = list
    .map(
      (a: GroupAbilityView) => `
      <li>
        ${spellIcon(a.spellId, a.name, 22, a.source)}
        <div class="grow">
          <div class="aname">${esc(a.name)} <span class="muted">${esc(a.source)}</span>${a.intelKey ? ` <span class="pill boss">Intel</span>` : ""}</div>
          <div class="detail">${a.damage ? `${num(a.damage)} damage, ` : ""}${a.hits ? `${a.hits} ${a.hits === 1 ? "hit" : "hits"}, ` : ""}${
            a.debuffs ? `${a.debuffs} ${a.debuffs === 1 ? "debuff" : "debuffs"}, ` : ""
          }${a.players} ${
            a.players === 1 ? "player" : "players"
          }${a.kills ? `, <span class="bad">${a.kills} ${a.kills === 1 ? "death" : "deaths"}</span>` : ""}</div>
          <div class="targets">${a.topTargets.map((t) => `${classIcon(t.wowClass, 14)}<span class="${classColor(t.wowClass)}">${esc(t.name)}</span>`).join("")}</div>
        </div>
        <span class="mbar short"><span data-width="${Math.round((a.damage / top) * 100)}"></span></span>
      </li>`,
    )
    .join("");
  return `<section class="panel"><h2>Damage taken by ability</h2><ul class="taken">${rows}</ul></section>`;
}

/* Fight detail. */

function renderMySpells(g: GroupFightView) {
  const me = g.players.find((p) => p.isMe);
  if (!me || !me.spells.length) return "";
  const total = me.spells.reduce((n, sp) => n + sp.damage + sp.healing, 0) || 1;
  const rows = me.spells
    .map((sp) => {
      const amount = sp.damage + sp.healing;
      return `
      <li>
        ${spellIcon(sp.spellId, sp.name, 22)}
        <span class="pname">${esc(sp.name)}</span>
        <span class="amount">${num(amount)}</span>
        <span class="share">${pct(amount / total)}</span>
        <span class="mbar"><span class="${sp.healing > sp.damage ? "heal" : ""}" data-width="${Math.round((amount / total) * 100)}"></span></span>
      </li>`;
    })
    .join("");
  return `<section class="panel"><h2>Your abilities</h2><ul class="spells">${rows}</ul></section>`;
}

function renderFightDetail(s: AppState) {
  const f = s.fights.find((x) => x.id === detailId) ?? null;
  const g = (f?.groupId ? s.groupFights.find((x) => x.id === f.groupId) : s.groupFights.find((x) => x.id === detailId)) ?? null;
  const back = backBar("close-detail", "Recent fights");
  if (!f && !g) return back + `<section class="panel"><p class="empty">This fight is no longer in memory.</p></section>`;
  const boss = g?.boss ? bossByKey(g.boss.key) : null;
  const result = g?.result === "kill" ? "Kill" : g?.result === "wipe" ? "Wipe" : null;
  const head = `${back}
    <section class="panel">
      <div class="fight-head">
        ${boss ? portrait(boss.displayId, 56) : ""}
        <div class="who">
          <div class="target">${esc(f?.label ?? g!.label)}</div>
          <div class="sub">${boss ? `${esc(g!.boss!.instance)}, ` : ""}${clock(f?.durationMs ?? g!.durationMs)}${result ? `, ${result}` : ""}${
            g ? `, ${g.players.length} ${g.players.length === 1 ? "player" : "players"}` : ""
          }</div>
        </div>
        ${f ? `<div class="score ${tone(f.score)}">${Math.round(f.score)}<small>score</small></div>` : ""}
      </div>
    </section>`;
  if (!g) return head + `<section class="panel"><p class="empty">No group data was recorded for this fight.</p></section>`;
  const intel =
    boss && boss.abilities.length
      ? `<section class="panel"><div class="panel-head"><h2>Boss intel</h2><span class="grow"></span><button class="link" data-intel="${esc(boss.key)}">Open in Intel</button></div><ul class="abilities">${boss.abilities
          .map((a) => renderAbility(a, g, false))
          .join("")}</ul></section>`
      : "";
  return head + renderMySpells(g) + intel + renderTaken(g) + renderGroup(g, 40);
}

/* Browsable intel. */

function instanceMeta(i: Instance) {
  return i.levels ? `Levels ${i.levels[0]}-${i.levels[1]}, ${i.size}-player` : `${i.size}-player`;
}

function bossRow(b: Boss, where = false) {
  return `
      <li>
        <button class="boss-row" data-boss="${esc(b.key)}">
          ${portrait(b.displayId, 32)}
          <span class="grow">${esc(b.name)}${where ? `<span class="where">${esc(instanceById(b.instance).name)}</span>` : ""}</span>
          ${b.rare ? `<span class="pill">Rare</span>` : ""}
          ${
            b.status === "scaffold"
              ? `<span class="pill">Soon</span>`
              : b.abilities.length
                ? `<span class="pill tag">${b.abilities.length} ${b.abilities.length === 1 ? "ability" : "abilities"}</span>`
                : `<span class="pill tag">Melee only</span>`
          }
        </button>
      </li>`;
}

function bossList(g: InstanceGroup) {
  return `<h3 class="sub-h">${esc(g.instance.name)} <span class="muted small">${instanceMeta(g.instance)}</span></h3>
      <ul class="boss-list">${g.bosses.map((b) => bossRow(b)).join("")}</ul>`;
}

const INTEL_CREDIT = `<p class="note center">Spell data from Blizzard's World of Warcraft Classic Era client; icons and portraits from Blizzard. World of Warcraft is a trademark of Blizzard Entertainment. Vigil is not affiliated with Blizzard.</p>`;

function renderIntel(s: AppState) {
  const boss = intelBoss ? bossByKey(intelBoss) : null;
  if (boss) return backBar("intel-back", intelQuery.trim() ? "Search results" : "All bosses") + renderBossDetail(s, boss) + INTEL_CREDIT;
  const query = intelQuery.trim();
  let body: string;
  if (query) {
    const found = searchBosses(query);
    body = found.length ? found.map((g) => bossList(g)).join("") : `<p class="empty">No boss, dungeon or ability matches "${esc(query)}".</p>`;
  } else {
    const groups = bossesByInstance(intelKind);
    const current = groups.find((g) => g.instance.id === intelInstance[intelKind]) ?? groups[0]!;
    const kinds = (["dungeon", "raid"] as const)
      .map((k) => `<button class="${k === intelKind ? "on" : ""}" data-kind="${k}">${k === "dungeon" ? "Dungeons" : "Raids"}</button>`)
      .join("");
    const chips = groups
      .map(
        ({ instance: i }) =>
          `<button class="chip ${i.id === current.instance.id ? "on" : ""}" data-instance="${esc(i.id)}" title="${esc(i.name)}">${esc(i.short)}${
            i.levels ? `<small>${i.levels[0]}-${i.levels[1]}</small>` : ""
          }</button>`,
      )
      .join("");
    body = `<div class="seg kinds">${kinds}</div><div class="chips">${chips}</div>${bossList(current)}`;
  }
  return `
    <section class="panel">
      <div class="panel-head"><h2>Boss intel</h2></div>
      <input id="intel-search" class="intel-search" type="search" value="${esc(intelQuery)}" placeholder="Search bosses, dungeons or abilities" aria-label="Search boss intel" spellcheck="false" autocomplete="off" />
      ${body}
    </section>
    ${INTEL_CREDIT}`;
}

function renderBossDetail(s: AppState, boss: Boss) {
  const last = s.groupFights.find((g) => g.boss?.key === boss.key) ?? (s.engine?.group?.boss?.key === boss.key ? s.engine.group : null);
  const instance = instanceById(boss.instance);
  const abilities = boss.abilities.length
    ? `<ul class="abilities">${boss.abilities.map((a) => renderAbility(a, last, true)).join("")}</ul>`
    : boss.status === "full"
      ? `<p class="empty">No special abilities: this fight is plain melee.</p>`
      : `<p class="empty">Abilities for this encounter are not written up yet. Vigil still recognises the fight and lists what hit the group.</p>`;
  const lastLine = last
    ? `<p class="note">Observed numbers are from your last ${esc(boss.name)} fight (${clock(last.durationMs)}${
        last.result === "kill" ? ", kill" : last.result === "wipe" ? ", wipe" : ""
      }). <button class="link" data-group="${esc(last.id)}">Open that fight</button></p>`
    : "";
  return `
    <section class="panel boss-detail">
      <div class="boss-hero">
        ${portrait(boss.displayId, 120, "zoom")}
        <div class="grow">
          <div class="target">${esc(boss.name)}</div>
          <div class="sub">${esc(instance.name)}, ${instanceMeta(instance)}</div>
          <div class="sub">${[boss.rare ? "Rare spawn" : "", boss.encounterId !== null ? `Encounter ${boss.encounterId}` : "", boss.npcIds.length ? `NPC ${boss.npcIds.join(", ")}` : ""].filter(Boolean).join(", ")}</div>
          <p class="asum">${esc(boss.summary)}</p>
          ${boss.uncertain ? `<p class="uncertain">Unconfirmed: ${esc(boss.uncertain)}</p>` : ""}
        </div>
      </div>
      ${lastLine}
      ${abilities}
    </section>`;
}

function msg(m: { ok: boolean; text: string } | null) {
  return m ? `<div class="msg ${m.ok ? "ok" : "err"}">${esc(m.text)}</div>` : "";
}

function renderSettings(s: AppState) {
  const p = s.pairing;
  const set = s.settings;
  const pairing = p.paired
    ? `
      <p>Paired with ${s.identity?.faction ? factionIcon(s.identity.faction, 16) + " " : ""}<strong>${esc(p.guild?.name)}</strong>${p.user?.name ? ` as ${esc(p.user.name)}` : ""}.${
        s.server.siteUrl ? ` <button class="link" data-open="${esc(s.server.siteUrl)}/vigil">Open Vigil on the site</button>` : ""
      }</p>
      <p class="note">This computer is listed as "${esc(p.device?.name)}" on the site, where you can revoke it. ${
        p.storage === "keychain" ? "The token is kept in the system keychain." : "No system keychain is available, so you will need to pair again after a restart."
      }</p>
      ${p.error ? `<div class="msg err">${esc(p.error)}</div>` : ""}
      <button data-act="unpair">Unpair</button>`
    : `
      <p class="note">On your guild's site, open Vigil, then Connect Vigil companion, and create a pairing code. The code tells Vigil which guild it belongs to.</p>
      <label class="field">Pairing code<input id="pair-code" value="${esc(pairLink?.code ?? "")}" placeholder="ABCD-EFGH" spellcheck="false" autocomplete="off" /></label>
      <button class="primary" data-act="pair">Pair</button>
      ${s.server.dev ? `<p class="note">Development build, pairing with ${esc(s.server.homeUrl)}.</p>` : ""}
      ${p.error ? `<div class="msg err">${esc(p.error)}</div>` : ""}`;

  const options = s.logsOptions
    .map((o) => `<option value="${esc(o.logsDir)}" ${o.logsDir === s.logsDir ? "selected" : ""}>${esc(o.label)}${o.latestLog ? `, last log ${new Date(o.latestAt!).toLocaleDateString()}` : ""}</option>`)
    .join("");
  const custom = s.logsDir && !s.logsOptions.some((o) => o.logsDir === s.logsDir);
  const visibility = (["default", "private", "officers", "guild"] as const)
    .map((v) => {
      const label =
        v === "default"
          ? `My site default${p.defaultVisibility ? ` (${p.defaultVisibility})` : ""}`
          : v === "private"
            ? "Only me"
            : v === "officers"
              ? "Me and officers"
              : "Whole guild";
      return `<option value="${v}" ${set.visibility === v ? "selected" : ""}>${label}</option>`;
    })
    .join("");
  const models = [`<option value="auto">Detect from spells cast</option>`]
    .concat(s.models.map((m) => `<option value="${esc(m.id)}" ${set.modelId === m.id ? "selected" : ""}>${esc(m.label)}</option>`))
    .join("");
  const addon = s.addon.targets.length
    ? s.addon.targets
        .map((t) => {
          const status = addonStatus(t.installed, s.addon.bundled);
          return `
        <div class="row addon">
          <div class="grow"><div>${esc(t.label)}</div><div class="path">${esc(status.text)}</div></div>
          ${status.action ? `<button data-addon="${esc(t.clientDir)}">${ADDON_ACTION_LABEL[status.action]}</button>` : ""}
        </div>`;
        })
        .join("")
    : `<p class="empty">No World of Warcraft install found.</p>`;

  return `
    <section class="panel"><h2>${p.paired ? "Site" : "Pair with the site"}</h2>${pairing}${msg(pairMessage)}</section>
    <section class="panel">
      <h2>Combat log</h2>
      <label class="field">Logs folder
        <div class="row">
          <select id="logs-select">
            <option value="">Auto-detect</option>
            ${options}
            ${custom ? `<option value="${esc(s.logsDir)}" selected>${esc(s.logsDir)}</option>` : ""}
          </select>
          <button data-act="browse">Browse</button>
        </div>
      </label>
      <div class="path">${s.logsDir ? `Reading ${esc(s.logsDir)}` : "No folder selected."}</div>
      <p class="note">Vigil only reads the combat log file. It never touches the game. Turn logging on with /combatlog (or Advanced Combat Logging in the options).</p>
    </section>
    <section class="panel">
      <h2>Uploads</h2>
      <label class="check"><input type="checkbox" id="auto-upload" ${set.autoUpload ? "checked" : ""} /> Upload each fight automatically</label>
      <label class="field">Skip trash shorter than (seconds)<input type="number" id="min-seconds" min="0" max="600" value="${set.minFightSeconds}" /></label>
      <label class="field">Who can see uploads<select id="visibility">${visibility}</select></label>
    </section>
    <section class="panel">
      <h2>Analysis</h2>
      <label class="field">Rotation<select id="model">${models}</select></label>
      <label class="check"><input type="checkbox" id="on-top" ${set.alwaysOnTop ? "checked" : ""} /> Keep this window on top</label>
    </section>
    <section class="panel">
      <h2>Background</h2>
      <label class="check"><input type="checkbox" id="keep-in-tray" ${set.keepInTray ? "checked" : ""} /> Keep running in the ${navigator.userAgent.includes("Mac") ? "menu bar" : "tray"} when closed</label>
      ${s.canOpenAtLogin ? `<label class="check"><input type="checkbox" id="open-at-login" ${set.openAtLogin ? "checked" : ""} /> Start Vigil when I log in</label>` : ""}
    </section>
    <section class="panel">
      <h2>In-game addon</h2>
      <p class="note">Optional. It has its own version, separate from the app, and only updates when it changes.</p>
      ${s.addon.bundled ? "" : `<p class="note">This build does not include the in-game addon.</p>`}
      ${addon}
      ${msg(addonMessage)}
    </section>
    <p class="note center">Vigil ${esc(s.version)} (desktop app)</p>`;
}

/** Switch views; a new view starts scrolled to the top. */
function go(next: typeof view) {
  if (next === "settings" && view !== "settings") {
    pairMessage = null;
    addonMessage = null;
  }
  if (next !== "fight") detailId = null;
  view = next;
  scrollToTop = true;
}

let scrollToTop = false;

/** The focused control's data attribute, so keyboard focus survives the re-render that replaces it. */
function focusKey(): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLButtonElement) || !root.contains(el)) return null;
  for (const name of ["view", "act", "detail", "boss", "kind", "instance", "meter", "intel", "group"]) {
    const v = el.dataset[name];
    if (v) return `button[data-${name}="${CSS.escape(v)}"]`;
  }
  return null;
}

function render() {
  if (!state) return;
  document.body.classList.toggle("compact", state.settings.mode === "compact");
  const scrollEl = root.querySelector(".scroll");
  const scrollTop = scrollToTop ? 0 : (scrollEl?.scrollTop ?? 0);
  scrollToTop = false;
  const focused = focusKey();
  const body =
    view === "settings" ? renderSettings(state) : view === "intel" ? renderIntel(state) : view === "fight" ? renderFightDetail(state) : renderLive(state);
  root.innerHTML = renderTopbar(state) + renderUpdate(state) + renderGameMismatch(state) + `<main class="scroll">${body}</main>`;
  const next = root.querySelector(".scroll");
  if (next) next.scrollTop = scrollTop;
  if (focused) root.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
  // The CSP forbids inline style attributes; set bar geometry through the DOM instead.
  for (const el of root.querySelectorAll<HTMLElement>("[data-width]")) el.style.width = `${el.dataset.width}%`;
  for (const el of root.querySelectorAll<HTMLElement>("[data-left]")) el.style.left = `${el.dataset.left}%`;
}

/** Live data re-renders every tick; the settings view only redraws its header so inputs keep focus. */
function onState(next: AppState) {
  const updateChanged = JSON.stringify(state?.update) !== JSON.stringify(next.update);
  state = next;
  if (view === "live" || view === "fight" || updateChanged) return render();
  const bar = root.querySelector(".topbar .status");
  if (bar) bar.innerHTML = statusLine(next);
}

async function update(partial: Partial<Settings>) {
  await api.updateSettings(partial);
  state = await api.getState();
}

root.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!el || !state) return;
  if (el.dataset.open) return void api.openExternal(el.dataset.open);
  if (el.dataset.retry) return void api.retryUpload(el.dataset.retry);
  if (el.dataset.detail || el.dataset.group) {
    go("fight");
    detailId = el.dataset.detail ?? el.dataset.group!;
    return render();
  }
  if (el.dataset.meter) {
    meter = el.dataset.meter as typeof meter;
    return render();
  }
  if (el.dataset.intel) {
    const boss = bossByKey(el.dataset.intel);
    if (boss) {
      intelKind = instanceById(boss.instance).kind;
      intelInstance[intelKind] = boss.instance;
      intelBoss = boss.key;
      intelQuery = "";
    }
    go("intel");
    return render();
  }
  if (el.dataset.kind) {
    intelKind = el.dataset.kind as Instance["kind"];
    intelBoss = null;
    return render();
  }
  if (el.dataset.instance) {
    intelInstance[intelKind] = el.dataset.instance;
    intelBoss = null;
    return render();
  }
  if (el.dataset.boss) {
    intelBoss = el.dataset.boss;
    scrollToTop = true;
    return render();
  }
  if (el.dataset.view) {
    go(el.dataset.view as Tab);
    return render();
  }
  if (el.dataset.addon) {
    const r = await api.installAddon(el.dataset.addon);
    addonMessage = { ok: r.ok, text: r.message };
    state = await api.getState();
    return render();
  }
  switch (el.dataset.act) {
    case "pin":
      await update({ alwaysOnTop: !state.settings.alwaysOnTop });
      break;
    case "mode":
      if (state.settings.mode !== "compact") go("live");
      await update({ mode: state.settings.mode === "compact" ? "full" : "compact" });
      break;
    case "close-detail":
      go("live");
      break;
    case "intel-back":
      intelBoss = null;
      scrollToTop = true;
      break;
    case "pair": {
      const code = (document.getElementById("pair-code") as HTMLInputElement).value;
      el.setAttribute("disabled", "");
      const r = await api.pair({ code });
      pairMessage = r.ok ? { ok: true, text: "Paired. Fights will upload to your guild." } : { ok: false, text: r.error ?? "Pairing failed." };
      if (r.ok) pairLink = null;
      state = await api.getState();
      break;
    }
    case "install-update":
      return void api.installUpdate();
    case "unpair":
      await api.unpair();
      pairMessage = null;
      state = await api.getState();
      break;
    case "browse": {
      const dir = await api.pickFolder();
      if (dir) await update({ logsDirOverride: dir });
      break;
    }
    default:
      return;
  }
  render();
});

/** Search re-renders the Intel view as you type; the new input keeps focus and the caret. */
root.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id !== "intel-search") return;
  intelQuery = el.value;
  const caret = el.selectionStart;
  render();
  const next = document.getElementById("intel-search") as HTMLInputElement | null;
  next?.focus();
  if (next && caret !== null) next.setSelectionRange(caret, caret);
});

root.addEventListener("change", async (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  switch (el.id) {
    case "logs-select":
      await update({ logsDirOverride: el.value || null });
      break;
    case "auto-upload":
      await update({ autoUpload: (el as HTMLInputElement).checked });
      return;
    case "min-seconds":
      await update({ minFightSeconds: Number(el.value) });
      return;
    case "visibility":
      await update({ visibility: el.value as Settings["visibility"] });
      return;
    case "model":
      await update({ modelId: el.value });
      return;
    case "on-top":
      await update({ alwaysOnTop: (el as HTMLInputElement).checked });
      return;
    case "keep-in-tray":
      await update({ keepInTray: (el as HTMLInputElement).checked });
      return;
    case "open-at-login":
      await update({ openAtLogin: (el as HTMLInputElement).checked });
      return;
    default:
      return;
  }
  render();
});

api.onPairLink(async (link) => {
  pairLink = link;
  go("settings");
  pairMessage = { ok: true, text: "Pairing code received. Press Pair to connect." };
  if (state?.settings.mode === "compact") await update({ mode: "full" });
  render();
});

/** Esc goes back to Live from any other view; a search box with text clears itself first. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || view === "live" || !state) return;
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.type === "search" && t.value) return;
  if (t instanceof HTMLSelectElement) return;
  e.preventDefault();
  go("live");
  render();
  root.querySelector<HTMLElement>('button[data-view="live"]')?.focus({ preventScroll: true });
});

api.onState(onState);
void api.getState().then((s) => {
  state = s;
  render();
});
