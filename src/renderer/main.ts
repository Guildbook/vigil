import type { Callout, LiveFight } from "@/lib/vigil/live";
import type { AppState, CompanionBridge, FightSummary, Settings } from "../core/protocol";

declare global {
  interface Window {
    vigil: CompanionBridge;
  }
}

const api = window.vigil;
const root = document.getElementById("app")!;

let state: AppState | null = null;
let view: "live" | "settings" = "live";
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

function statusLine(s: AppState) {
  const e = s.engine;
  if (!s.logsDir) return `<span class="dot warn"></span>No WoW Logs folder found. Choose one in settings.`;
  if (!e) return `<span class="dot warn"></span>Logs folder is missing: ${esc(s.logsDir)}`;
  if (e.status.error) return `<span class="dot warn"></span>${esc(e.status.error)}`;
  if (!e.status.file) return `<span class="dot"></span>Waiting for a combat log. Type /combatlog in game.`;
  const file = e.status.file.split(/[\\/]/).pop();
  const who = e.player ? `${esc(e.player.name)}${e.player.level ? ` (${e.player.level})` : ""}` : "detecting character";
  const model = e.model ? esc(e.model.label) : s.settings.modelId === "auto" ? "detecting rotation" : "";
  return `<span class="dot live"></span>${who}${model ? `, ${model}` : ""} <span title="${esc(e.status.file)}">in ${esc(file)}</span>`;
}

function renderTopbar(s: AppState) {
  const compact = s.settings.mode === "compact";
  return `
    <header class="topbar">
      <h1>VIGIL</h1>
      <div class="status">${statusLine(s)}</div>
      <button class="icon ${s.settings.alwaysOnTop ? "on" : ""}" data-act="pin" title="Keep on top">Pin</button>
      <button class="icon" data-act="mode" title="${compact ? "Full view" : "Compact view"}">${compact ? "Full" : "Compact"}</button>
      <button class="icon ${view === "settings" ? "on" : ""}" data-act="settings" title="Settings">${view === "settings" ? "Done" : "Settings"}</button>
    </header>`;
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

function renderCurrent(s: AppState) {
  const f = s.engine?.current;
  if (!f) {
    return `<section class="panel"><h2>Current fight</h2><p class="empty">${
      s.engine?.status.file ? "Out of combat. The next pull shows up here." : "Nothing to follow yet."
    }</p></section>`;
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
        <div class="label">${esc(u.label)} <span class="pill ${u.active ? "up" : "down"}">${u.active ? "up" : "down"}</span></div>
        <div class="pct">${pct(u.pct)}</div>
        <div class="bar" title="Target ${pct(u.targetPct)}"><span data-width="${Math.round(u.pct * 100)}"></span><i data-left="${Math.round(u.targetPct * 100)}"></i></div>
      </div>`,
        )
        .join("");
  const others = f.targets.length > 1 ? ` and ${f.targets.length - 1} more` : "";
  return `
    <section class="panel">
      <div class="fight-head">
        <div class="who">
          <div class="target" title="${esc(f.targets.join(", "))}">${esc(f.label)}</div>
          <div class="sub">${f.kind === "boss" ? `<span class="pill boss">Boss</span> ` : ""}${clock(f.elapsedMs)}${esc(others)}</div>
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
      return `<div class="upload">Uploaded. <button class="link" data-open="${esc(u.url)}">Open report</button></div>`;
    case "failed":
      return `<div class="upload bad">${esc(u.error)}${u.retrying ? " Retrying." : ` <button class="link" data-retry="${esc(f.id)}">Retry</button>`}</div>`;
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
    .map(
      (f) => `
      <li>
        <div class="fscore ${tone(f.score)}">${Math.round(f.score)}</div>
        <div class="meta">
          <div class="name">${f.kind === "boss" ? `<span class="pill boss">Boss</span> ` : ""}${esc(f.label)}</div>
          <div class="detail">${clock(f.durationMs)}, ${pct(f.gcdUsage)} GCD, ${num(f.perSecond)} ${metricUnit(f.metric)}${f.modelLabel ? `, ${esc(f.modelLabel)}` : ""}</div>
          ${uploadLine(f)}
        </div>
      </li>`,
    )
    .join("");
  return `<section class="panel"><h2>Recent fights</h2>${items ? `<ul class="fights">${items}</ul>` : `<p class="empty">Finished fights are listed here.</p>`}</section>`;
}

function renderLive(s: AppState) {
  return renderCurrent(s) + renderCallouts(s) + renderFights(s);
}

function msg(m: { ok: boolean; text: string } | null) {
  return m ? `<div class="msg ${m.ok ? "ok" : "err"}">${esc(m.text)}</div>` : "";
}

function renderSettings(s: AppState) {
  const p = s.pairing;
  const set = s.settings;
  const pairing = p.paired
    ? `
      <p>Paired with <strong>${esc(p.guild?.name)}</strong>${p.user?.name ? ` as ${esc(p.user.name)}` : ""}.${
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
        .map(
          (t) => `
        <div class="row addon">
          <div class="grow"><div>${esc(t.label)}</div><div class="path">${t.installed ? `Installed: ${esc(t.installed)}` : "Not installed"}</div></div>
          <button data-addon="${esc(t.clientDir)}">${t.installed ? "Update" : "Install"}</button>
        </div>`,
        )
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
      <h2>Vigil addon</h2>
      <p class="note">Optional. Bundled version ${esc(s.addon.bundled ?? "unavailable")}.</p>
      ${addon}
      ${msg(addonMessage)}
    </section>
    <p class="note center">Vigil ${esc(s.version)}</p>`;
}

function render() {
  if (!state) return;
  document.body.classList.toggle("compact", state.settings.mode === "compact");
  const scrollEl = root.querySelector(".scroll");
  const scrollTop = scrollEl?.scrollTop ?? 0;
  root.innerHTML =
    renderTopbar(state) + renderUpdate(state) + `<main class="scroll">${view === "settings" ? renderSettings(state) : renderLive(state)}</main>`;
  const next = root.querySelector(".scroll");
  if (next) next.scrollTop = scrollTop;
  // The CSP forbids inline style attributes; set bar geometry through the DOM instead.
  for (const el of root.querySelectorAll<HTMLElement>("[data-width]")) el.style.width = `${el.dataset.width}%`;
  for (const el of root.querySelectorAll<HTMLElement>("[data-left]")) el.style.left = `${el.dataset.left}%`;
}

/** Live data re-renders every tick; the settings view only redraws its header so inputs keep focus. */
function onState(next: AppState) {
  const updateChanged = JSON.stringify(state?.update) !== JSON.stringify(next.update);
  state = next;
  if (view === "live" || updateChanged) return render();
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
      await update({ mode: state.settings.mode === "compact" ? "full" : "compact" });
      break;
    case "settings":
      view = view === "settings" ? "live" : "settings";
      pairMessage = null;
      addonMessage = null;
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
    default:
      return;
  }
  render();
});

api.onPairLink((link) => {
  pairLink = link;
  view = "settings";
  pairMessage = { ok: true, text: "Pairing code received. Press Pair to connect." };
  render();
});

api.onState(onState);
void api.getState().then((s) => {
  state = s;
  render();
});
