import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { Faction, WowClass } from "@/lib/game";
import { reportGameVersion } from "@/lib/vigil/game-version";
import type { Callout, CompletedFight } from "@/lib/vigil/live";
import type { FightReport } from "@/lib/vigil/report";
import { ROTATION_MODELS } from "@/lib/vigil/rotations";
import { installAddon, installedVersion, pickAddonSource, readTocVersion, ADDON_TOC } from "../core/addon";
import { CompanionEngine, type EngineSnapshot } from "../core/engine";
import { factionFromClasses, type GroupFightView } from "../core/group";
import { SpellIcons } from "../core/media";
import { addPairing, asGameVersion, defaultPairing, pickPairing, setGameVersion, tokenFileFor, type Pairing } from "../core/pairings";
import type { AppState, FightSummary, Identity, PairResult, PairingState, Settings, UpdateState, UploadState } from "../core/protocol";
import { asBossFight, skipReason, Uploader, type UploadTarget } from "../core/uploader";
import { discoverLogsCandidates, resolveLogsDir, wowRootCandidates, type LogsCandidate } from "../core/wow-paths";
import { trustedSiteOrigin, type TrustConfig } from "../core/origins";
import { loadPairings, loadSettings, loginItemsSupported, savePairings, saveSettings, TokenStore, trustConfig } from "./store";

const MAX_FIGHTS = 50;
const MAX_CALLOUTS = 40;
const MAX_GROUP_FIGHTS = 15;

interface Profile {
  /** The guild's canonical site, which changes when the guild verifies a custom domain. */
  siteUrl?: string;
  guild: { slug: string; name: string; gameVersion?: string | null };
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
  private pairings: Pairing[] = loadPairings(this.trust);
  /** By pairing id: the site's profile, and why the site refused or could not be reached. */
  private readonly profiles = new Map<string, Profile>();
  private readonly pairingErrors = new Map<string, string>();
  /** By fight id: the pairing picked for its upload, kept for retries. */
  private readonly routes = new Map<string, string>();
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
      target: (id, report) => this.uploadTarget(id, report),
      onStatus: (id, state) => this.setUpload(id, state),
      onUnauthorized: (message, target) => {
        if (!target.pairingId) return;
        this.pairingErrors.set(target.pairingId, message);
        this.profiles.delete(target.pairingId);
        this.push();
      },
    });
  }

  start() {
    this.rescan(true);
    void this.refreshProfiles();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** Pairings with a token this run can use (without OS encryption, tokens do not survive a restart). */
  private usablePairings(): Pairing[] {
    return this.pairings.filter((p) => this.tokens.load(p.tokenFile));
  }

  /** The pairing picked when the fight finished, or a fresh pick if that one has been unpaired since. */
  private uploadTarget(id: string, report: FightReport): UploadTarget | null {
    const usable = this.usablePairings();
    const pairing = usable.find((p) => p.id === this.routes.get(id)) ?? pickPairing(usable, reportGameVersion(report)).pairing;
    const token = pairing ? this.tokens.load(pairing.tokenFile) : null;
    if (!pairing || !token) return null;
    this.routes.set(id, pairing.id);
    return {
      apiUrl: this.trust.homeUrl,
      token,
      guild: pairing.guild.slug,
      visibility: this.settings.visibility === "default" ? null : this.settings.visibility,
      pairingId: pairing.id,
    };
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
    for (const profile of this.profiles.values()) {
      const found = profile.characters.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (found) return found.wowClass;
    }
    return null;
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
    const route = pickPairing(this.usablePairings(), reportGameVersion(report));
    const pairing = route.pairing;
    const reason = skipReason(report, this.settings, Boolean(pairing && !this.pairingErrors.has(pairing.id)));
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
      destination: pairing ? { pairingId: pairing.id, guild: pairing.guild.name, gameVersion: pairing.guild.gameVersion, warning: route.warning } : null,
      encounterId: report.fight.encounter?.id ?? null,
      groupId: null,
    };
    summary.groupId = this.groupFor(summary);
    this.fights.unshift(summary);
    this.reports.set(id, report);
    if (pairing) this.routes.set(id, pairing.id);
    for (const old of this.fights.splice(MAX_FIGHTS)) {
      this.reports.delete(old.id);
      this.routes.delete(old.id);
    }
    if (!reason) this.uploader.enqueue(id, report);
    this.push();
  }

  private setUpload(id: string, upload: UploadState) {
    const f = this.fights.find((x) => x.id === id);
    const pairing = this.pairings.find((p) => p.id === this.routes.get(id));
    if (f) {
      f.upload = upload;
      if (pairing && f.destination?.pairingId !== pairing.id) {
        f.destination = { pairingId: pairing.id, guild: pairing.guild.name, gameVersion: pairing.guild.gameVersion, warning: null };
      }
    }
    if (upload.state === "uploaded" && pairing) {
      pairing.lastUsedAt = new Date().toISOString();
      this.persistPairings();
    }
    this.push();
  }

  private persistPairings() {
    try {
      savePairings(this.pairings);
    } catch (err) {
      console.warn(`Could not save pairings: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  /**
   * The code names the guild, so pairing always asks the home server; it answers with the guild's own site. A
   * guild of a game version already paired replaces that pairing (the code is spent by then, so there is no
   * asking first; the window says what was replaced).
   */
  async pair(code: string): Promise<PairResult> {
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
        device?: { id?: string; name?: string };
        guild?: { slug?: string; name?: string; gameVersion?: string | null };
      };
      if (!res.ok || !body.token || !body.device?.id || !body.guild?.slug) return { ok: false, error: body.error ?? `Pairing failed (${res.status}).` };
      const pairing: Pairing = {
        id: body.device.id,
        guild: { slug: body.guild.slug, name: body.guild.name || body.guild.slug, gameVersion: asGameVersion(body.guild.gameVersion) },
        siteUrl: trustedSiteOrigin(body.siteUrl, this.trust, { vouched: true }),
        device: { id: body.device.id, name: body.device.name ?? "" },
        pairedAt: new Date().toISOString(),
        lastUsedAt: null,
        tokenFile: tokenFileFor(body.device.id),
      };
      this.tokens.save(pairing.tokenFile, body.token);
      const added = addPairing(this.pairings, pairing);
      this.pairings = added.pairings;
      this.pairingErrors.delete(pairing.id);
      const replaced = [...this.forget(added.replaced, pairing), ...(await this.refreshProfile(pairing.id))];
      this.persistPairings();
      const current = this.pairings.find((p) => p.id === pairing.id) ?? pairing;
      return {
        ok: true,
        guild: { name: current.guild.name, gameVersion: current.guild.gameVersion },
        replaced: replaced.filter((p) => p.guild.slug !== current.guild.slug).map((p) => ({ name: p.guild.name, gameVersion: p.guild.gameVersion })),
      };
    } catch (err) {
      return { ok: false, error: `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Drops replaced pairings' tokens and cached state, unless a pairing still uses the token file. */
  private forget(replaced: Pairing[], keep?: Pairing): Pairing[] {
    for (const p of replaced) {
      if (p.tokenFile !== keep?.tokenFile && !this.pairings.some((q) => q.tokenFile === p.tokenFile)) this.tokens.clear(p.tokenFile);
      if (p.id !== keep?.id) {
        this.profiles.delete(p.id);
        this.pairingErrors.delete(p.id);
      }
    }
    return replaced;
  }

  /** The guild sites the device is paired with, for deciding which links may open. */
  get pairedSites(): string[] {
    return this.usablePairings()
      .map((p) => p.siteUrl)
      .filter((s): s is string => Boolean(s));
  }

  setUpdate(update: UpdateState) {
    this.update = update;
    this.push();
  }

  /** One guild, or all of them without an id. */
  unpair(pairingId?: string) {
    const gone = pairingId ? this.pairings.filter((p) => p.id === pairingId) : this.pairings;
    this.pairings = this.pairings.filter((p) => !gone.includes(p));
    this.forget(gone);
    this.persistPairings();
    this.push();
  }

  private async refreshProfiles() {
    await Promise.all(this.usablePairings().map((p) => this.refreshProfile(p.id)));
  }

  /**
   * Loads a pairing's profile from the site: the member's characters and default visibility, the guild's current
   * name and site, and its game version when the pairing did not carry one (pairings from 0.4.0). Returns any
   * older pairing the game version made redundant.
   */
  private async refreshProfile(id: string): Promise<Pairing[]> {
    const pairing = this.pairings.find((p) => p.id === id);
    const token = pairing ? this.tokens.load(pairing.tokenFile) : null;
    if (!pairing || !token) return [];
    let replaced: Pairing[] = [];
    try {
      const res = await fetch(`${this.trust.homeUrl}/api/vigil/companion/me`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as Profile & { error?: string };
      if (!this.pairings.includes(pairing)) return [];
      if (res.ok) {
        this.profiles.set(id, body);
        const siteUrl = trustedSiteOrigin(body.siteUrl, this.trust, { vouched: true });
        let changed = false;
        if (siteUrl && siteUrl !== pairing.siteUrl) {
          pairing.siteUrl = siteUrl;
          changed = true;
        }
        if (body.guild?.name && body.guild.name !== pairing.guild.name) {
          pairing.guild.name = body.guild.name;
          changed = true;
        }
        const versioned = setGameVersion(this.pairings, id, asGameVersion(body.guild?.gameVersion));
        if (versioned.pairings.length !== this.pairings.length || versioned.pairings.some((p, i) => p !== this.pairings[i])) {
          this.pairings = versioned.pairings;
          replaced = this.forget(versioned.replaced);
          changed = true;
        }
        if (changed) this.persistPairings();
        this.pairingErrors.delete(id);
        this.engine?.reconfigure(this.sessionOptions());
      } else {
        this.pairingErrors.set(id, body.error ?? `The site refused this companion (${res.status}).`);
      }
    } catch {
      if (this.pairings.includes(pairing)) this.pairingErrors.set(id, "The site is unreachable; uploads will wait until it is back.");
    }
    this.push();
    return replaced;
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
    const usable = this.usablePairings();
    const fallback = defaultPairing(usable);
    const failing = usable.find((p) => this.pairingErrors.has(p.id));
    const error = failing ? this.pairingErrors.get(failing.id)! : null;
    return {
      paired: usable.length > 0,
      pairings: usable.map((p) => ({
        id: p.id,
        guild: { ...p.guild },
        user: this.profiles.get(p.id)?.user ?? null,
        device: { ...p.device },
        siteUrl: p.siteUrl,
        pairedAt: p.pairedAt,
        lastUsedAt: p.lastUsedAt,
        error: this.pairingErrors.get(p.id) ?? null,
      })),
      defaultVisibility: (fallback && this.profiles.get(fallback.id)?.defaultVisibility) ?? null,
      storage: usable.length ? this.tokens.storage : null,
      error: failing && usable.length > 1 ? `${failing.guild.name}: ${error}` : error,
    };
  }

  state(): AppState {
    const source = this.addonSource();
    return {
      version: app.getVersion(),
      server: { homeUrl: this.trust.homeUrl, siteUrl: defaultPairing(this.usablePairings())?.siteUrl ?? null, dev: this.trust.allowLocal },
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
