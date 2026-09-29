import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { Faction, WowClass } from "@/lib/game";
import type { Callout, CompletedFight } from "@/lib/vigil/live";
import type { FightReport } from "@/lib/vigil/report";
import { ROTATION_MODELS } from "@/lib/vigil/rotations";
import { installAddon, installedVersion, pickAddonSource, readTocVersion, ADDON_TOC } from "../core/addon";
import { CompanionEngine, type EngineSnapshot } from "../core/engine";
import { factionFromClasses, type GroupFightView } from "../core/group";
import { SpellIcons } from "../core/media";
import type { AppState, FightSummary, Identity, PairingState, Settings, UpdateState, UploadState } from "../core/protocol";
import { asBossFight, skipReason, Uploader } from "../core/uploader";
import { discoverLogsCandidates, resolveLogsDir, wowRootCandidates, type LogsCandidate } from "../core/wow-paths";
import { trustedSiteOrigin, type TrustConfig } from "../core/origins";
import { loadPairing, loadSettings, loginItemsSupported, savePairing, saveSettings, TokenStore, trustConfig, type PairingRecord } from "./store";

const MAX_FIGHTS = 50;
const MAX_CALLOUTS = 40;
const MAX_GROUP_FIGHTS = 15;

interface Profile {
  /** The guild's canonical site, which changes when the guild verifies a custom domain. */
  siteUrl?: string;
  guild: { slug: string; name: string };
  user: { name: string | null };
  device: { id: string; name: string };
  defaultVisibility: "private" | "officers" | "guild";
  characters: { name: string; wowClass: WowClass }[];
}

/**
 * The app's state and behaviour, outside any window. It reads the combat log on disk and talks to the site;
 * it never touches the game client (no input, no memory, no screen).
 */
export class Companion {
  settings: Settings = loadSettings();
  readonly trust: TrustConfig = trustConfig();
  private readonly tokens = new TokenStore();
  private pairing: PairingRecord | null = loadPairing(this.trust);
  private profile: Profile | null = null;
  private pairingError: string | null = null;
  private engine: CompanionEngine | null = null;
  private snapshot: EngineSnapshot | null = null;
  private logsDir: string | null = null;
  private candidates: LogsCandidate[] = [];
  private callouts: Callout[] = [];
  private fights: FightSummary[] = [];
  private groupFights: GroupFightView[] = [];
  private readonly icons = new SpellIcons();
  private readonly reports = new Map<string, FightReport>();
  private readonly uploader: Uploader;
  private timer: NodeJS.Timeout | null = null;
  private lastScan = 0;
  private update: UpdateState = { state: "idle" };

  constructor(private readonly broadcast: (state: AppState) => void) {
    this.uploader = new Uploader({
      fetch,
      target: () => {
        const token = this.tokens.load();
        if (!token || !this.pairing) return null;
        return {
          apiUrl: this.trust.homeUrl,
          token,
          guild: this.pairing.guild.slug,
          visibility: this.settings.visibility === "default" ? null : this.settings.visibility,
        };
      },
      onStatus: (id, state) => this.setUpload(id, state),
      onUnauthorized: (message) => {
        this.pairingError = message;
        this.profile = null;
        this.push();
      },
    });
  }

  start() {
    this.rescan(true);
    void this.refreshProfile();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.engine?.stop();
  }

  private tick() {
    if (!this.engine && Date.now() - this.lastScan > 15_000) this.rescan(false);
    if (this.engine) this.snapshot = this.engine.tick();
    this.push();
  }

  /** Re-detect the Logs folder and (re)start tailing if it changed. */
  rescan(force: boolean) {
    this.lastScan = Date.now();
    const roots = wowRootCandidates();
    this.candidates = discoverLogsCandidates(roots);
    const override = process.env.VIGIL_LOGS_DIR || this.settings.logsDirOverride;
    const dir = resolveLogsDir(override, this.candidates);
    if (!force && dir === this.logsDir) return;
    this.engine?.stop();
    this.engine = null;
    this.snapshot = null;
    this.logsDir = dir;
    if (dir && existsSync(dir)) {
      this.engine = new CompanionEngine({
        logsDir: dir,
        startAt: "end",
        session: this.sessionOptions(),
        group: { icons: this.icons, classFor: (name) => this.knownClass(name), onFinished: (g) => this.onGroupFight(g) },
        onFight: (f) => this.onFight(f),
        onCallout: (c) => {
          this.callouts.unshift(c);
          this.callouts.length = Math.min(this.callouts.length, MAX_CALLOUTS);
        },
      });
      this.engine.start();
    }
  }

  private knownClass(name: string): WowClass | null {
    return this.profile?.characters.find((c) => c.name.toLowerCase() === name.toLowerCase())?.wowClass ?? null;
  }

  private sessionOptions() {
    return {
      modelId: this.settings.modelId === "auto" ? null : this.settings.modelId,
      classFor: (name: string) => this.knownClass(name),
    };
  }

  private onGroupFight(fight: GroupFightView) {
    this.groupFights.unshift(fight);
    this.groupFights.length = Math.min(this.groupFights.length, MAX_GROUP_FIGHTS);
    for (const f of this.fights) if (!f.groupId) f.groupId = this.groupFor(f);
    this.push();
  }

  /**
   * The group fight recorded alongside an analysed fight: the same logged encounter, or a pull that began within
   * 10 s (dungeon bosses have no logged encounter, only the one asBossFight filled in).
   */
  private groupFor(f: FightSummary): string | null {
    const start = Date.parse(f.startedAt);
    const taken = new Set(this.fights.map((x) => x.groupId).filter(Boolean));
    const match = this.groupFights.find((g) => {
      if (taken.has(g.id)) return false;
      if (f.encounterId !== null && g.encounter) return g.encounter.id === f.encounterId && Math.abs(g.startT - start) < 30_000;
      return g.encounter === null && Math.abs(g.startT - start) <= 10_000;
    });
    return match?.id ?? null;
  }

  private identity(): Identity | null {
    const player = this.snapshot?.player;
    if (!player) return null;
    const model = this.snapshot?.model ? ROTATION_MODELS.find((m) => m.id === this.snapshot!.model!.id) : null;
    const wowClass = this.knownClass(player.name) ?? model?.wowClass ?? this.engine?.classOf(player.guid) ?? null;
    const group = this.snapshot?.group ?? this.groupFights[0] ?? null;
    const faction: Faction | null = factionFromClasses([wowClass, ...(group?.players.map((p) => p.wowClass) ?? [])]);
    return { name: player.name, level: player.level, wowClass, faction };
  }

  private onFight({ report: analysed, callouts }: CompletedFight) {
    const report = asBossFight(analysed);
    const id = `${Date.parse(report.fight.startedAt)}-${report.fight.label}`;
    const reason = skipReason(report, this.settings, Boolean(this.pairing && this.tokens.load() && !this.pairingError));
    const summary: FightSummary = {
      id,
      label: report.fight.label,
      kind: report.fight.kind,
      startedAt: report.fight.startedAt,
      durationMs: report.fight.durationMs,
      score: report.score.overall,
      modelLabel: report.model?.label ?? null,
      metric: report.model?.metric ?? "damage",
      perSecond: report.model?.metric === "threat" ? report.totals.tps : report.model?.metric === "healing" ? report.totals.hps : report.totals.dps,
      gcdUsage: report.activity.gcdUsage,
      callouts: callouts.slice(0, 3).map((c) => c.text),
      upload: reason ? { state: "skipped", reason } : { state: "queued" },
      encounterId: report.fight.encounter?.id ?? null,
      groupId: null,
    };
    summary.groupId = this.groupFor(summary);
    this.fights.unshift(summary);
    this.reports.set(id, report);
    for (const old of this.fights.splice(MAX_FIGHTS)) this.reports.delete(old.id);
    if (!reason) this.uploader.enqueue(id, report);
    this.push();
  }

  private setUpload(id: string, upload: UploadState) {
    const f = this.fights.find((x) => x.id === id);
    if (f) f.upload = upload;
    this.push();
  }

  retryUpload(id: string) {
    const report = this.reports.get(id);
    if (report) this.uploader.enqueue(id, report);
  }

  setUploadsPaused(paused: boolean) {
    this.uploader.setPaused(paused);
    this.push();
  }

  updateSettings(partial: Partial<Settings>): Settings {
    const before = this.settings;
    this.settings = { ...before, ...partial, minFightSeconds: Math.max(0, Math.min(600, Number(partial.minFightSeconds ?? before.minFightSeconds) || 0)) };
    saveSettings(this.settings);
    if (before.logsDirOverride !== this.settings.logsDirOverride) this.rescan(true);
    if (before.modelId !== this.settings.modelId) this.engine?.reconfigure(this.sessionOptions());
    this.push();
    return this.settings;
  }

  /** The code names the guild, so pairing always asks the home server; it answers with the guild's own site. */
  async pair(code: string): Promise<{ ok: boolean; error?: string }> {
    const base = this.trust.homeUrl;
    if (!code.trim()) return { ok: false, error: "Enter the pairing code from your guild's site." };
    try {
      const res = await fetch(`${base}/api/vigil/companion/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, deviceName: `Vigil on ${os.hostname().replace(/\.local$/, "")}`.slice(0, 80) }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
        siteUrl?: string;
        device?: PairingRecord["device"];
        guild?: PairingRecord["guild"];
      };
      if (!res.ok || !body.token || !body.device || !body.guild) return { ok: false, error: body.error ?? `Pairing failed (${res.status}).` };
      this.tokens.save(body.token);
      this.pairing = { siteUrl: trustedSiteOrigin(body.siteUrl, this.trust, { vouched: true }), guild: body.guild, device: body.device };
      savePairing(this.pairing);
      this.pairingError = null;
      await this.refreshProfile();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** The guild site the device is paired with, for deciding which links may open. */
  get pairedSite(): string | null {
    return this.pairing?.siteUrl ?? null;
  }

  setUpdate(update: UpdateState) {
    this.update = update;
    this.push();
  }

  unpair() {
    this.tokens.clear();
    this.pairing = null;
    this.profile = null;
    this.pairingError = null;
    savePairing(null);
    this.push();
  }

  private async refreshProfile() {
    const token = this.tokens.load();
    if (!token || !this.pairing) return;
    try {
      const res = await fetch(`${this.trust.homeUrl}/api/vigil/companion/me`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as Profile & { error?: string };
      if (res.ok) {
        this.profile = body;
        const siteUrl = trustedSiteOrigin(body.siteUrl, this.trust, { vouched: true });
        if (siteUrl && siteUrl !== this.pairing.siteUrl) {
          this.pairing = { ...this.pairing, siteUrl };
          savePairing(this.pairing);
        }
        this.pairingError = null;
        this.engine?.reconfigure(this.sessionOptions());
      } else {
        this.pairingError = body.error ?? `The site refused this companion (${res.status}).`;
      }
    } catch {
      this.pairingError = "The site is unreachable; uploads will wait until it is back.";
    }
    this.push();
  }

  private addonSource() {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, "addon", "Vigil")]
      : [path.join(app.getAppPath(), "resources", "addon", "Vigil"), path.join(app.getAppPath(), "..", "addons", "Vigil")];
    return pickAddonSource(candidates);
  }

  installAddonTo(clientDir: string): { ok: boolean; message: string } {
    const source = this.addonSource();
    if (!source) return { ok: false, message: "The in-game addon is not bundled with this build." };
    try {
      const { version } = installAddon(source.path, clientDir);
      this.push();
      return { ok: true, message: `In-game addon v${version} installed. Enable it at character select, then /reload.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private pairingState(): PairingState {
    const paired = Boolean(this.pairing && this.tokens.load());
    return {
      paired,
      guild: paired ? (this.profile?.guild ?? this.pairing!.guild) : null,
      user: this.profile?.user ?? null,
      device: paired ? this.pairing!.device : null,
      defaultVisibility: this.profile?.defaultVisibility ?? null,
      storage: paired ? this.tokens.storage : null,
      error: this.pairingError,
    };
  }

  state(): AppState {
    const source = this.addonSource();
    return {
      version: app.getVersion(),
      server: { homeUrl: this.trust.homeUrl, siteUrl: this.pairing?.siteUrl ?? null, dev: this.trust.allowLocal },
      update: this.update,
      engine: this.snapshot,
      logsDir: this.logsDir,
      logsOptions: this.candidates
        .filter((c) => c.hasLogsDir)
        .map((c) => ({ label: `${c.label} (${c.flavor})`, logsDir: c.logsDir, latestLog: c.latestLog?.name ?? null, latestAt: c.latestLog?.mtimeMs ?? null })),
      callouts: this.callouts,
      fights: this.fights,
      groupFights: this.groupFights,
      identity: this.identity(),
      settings: this.settings,
      uploadsPaused: this.uploader.isPaused,
      canOpenAtLogin: loginItemsSupported(),
      pairing: this.pairingState(),
      addon: {
        bundled: source ? (readTocVersion(path.join(source.path, ADDON_TOC)) ?? source.version) : null,
        targets: this.candidates.map((c) => ({ label: `${c.label} (${c.flavor})`, clientDir: c.clientDir, installed: installedVersion(c.clientDir) })),
      },
      models: ROTATION_MODELS.map((m) => ({ id: m.id, label: m.label })),
    };
  }

  private push() {
    this.broadcast(this.state());
  }
}
