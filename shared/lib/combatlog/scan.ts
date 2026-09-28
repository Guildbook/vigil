import { FLAGS, isPlayerGuid, shortName } from "./guid";
import { normalizeEvent } from "./normalize";
import { parseHeader, tokenizeLine, type LogHeader } from "./tokenizer";
import type { CombatEvent } from "./types";

/** Tokenizes and normalizes lines in order, picking up the COMBAT_LOG_VERSION header when it appears. */
export class LogReader {
  header: LogHeader = { version: null, advanced: false, build: null, projectId: null };
  lines = 0;
  unparsed = 0;
  firstT: number | null = null;
  lastT: number | null = null;
  readonly eventTypes = new Map<string, number>();

  constructor(private readonly fallbackYear = new Date().getUTCFullYear()) {}

  read(line: string): CombatEvent | null {
    if (!line.trim()) return null;
    this.lines++;
    const tok = tokenizeLine(line, this.fallbackYear);
    if (!tok) {
      this.unparsed++;
      return null;
    }
    this.firstT ??= tok.timestamp;
    this.lastT = tok.timestamp;
    this.eventTypes.set(tok.event, (this.eventTypes.get(tok.event) ?? 0) + 1);
    if (tok.event === "COMBAT_LOG_VERSION") {
      this.header = parseHeader(tok.fields);
      return null;
    }
    try {
      return normalizeEvent(tok, { header: this.header });
    } catch {
      this.unparsed++;
      return null;
    }
  }
}

export interface ScannedPlayer {
  guid: string;
  name: string;
  /** The log was recorded by this player (COMBATLOG_OBJECT_AFFILIATION_MINE). */
  isLogger: boolean;
  events: number;
  /** Distinct spell names this player cast, used to suggest a rotation model. */
  spells: string[];
  level: number | null;
}

export interface LogScan {
  header: LogHeader;
  lines: number;
  unparsed: number;
  startedAt: number | null;
  endedAt: number | null;
  players: ScannedPlayer[];
  encounters: number;
  eventTypes: Record<string, number>;
}

/** Collects the players who acted in the log, the recorder first. */
export class PlayerScanner {
  private readonly players = new Map<string, ScannedPlayer & { spellSet: Set<string> }>();
  private encounters = 0;

  push(ev: CombatEvent) {
    if (ev.type === "ENCOUNTER_START") this.encounters++;
    const src = ev.src;
    if (!src || !isPlayerGuid(src.guid)) return;
    let p = this.players.get(src.guid);
    if (!p) {
      p = { guid: src.guid, name: shortName(src.name), isLogger: false, events: 0, spells: [], level: null, spellSet: new Set() };
      this.players.set(src.guid, p);
    }
    p.events++;
    if (src.flags & FLAGS.affiliationMine) p.isLogger = true;
    if ((ev.type === "SPELL_CAST_SUCCESS" || ev.type === "SPELL_CAST_START") && ev.spellName && p.spellSet.size < 200) {
      p.spellSet.add(ev.spellName);
    }
    if (ev.adv?.guid === src.guid && ev.adv.level) p.level = ev.adv.level;
  }

  /** One player as seen so far, or null if they have not acted. */
  player(guid: string): ScannedPlayer | null {
    const p = this.players.get(guid);
    if (!p) return null;
    const { spellSet, ...rest } = p;
    return { ...rest, spells: [...spellSet].sort() };
  }

  result(reader: LogReader): LogScan {
    const players = [...this.players.values()]
      .map(({ spellSet, ...p }) => ({ ...p, spells: [...spellSet].sort() }))
      .sort((a, b) => Number(b.isLogger) - Number(a.isLogger) || b.events - a.events);
    return {
      header: reader.header,
      lines: reader.lines,
      unparsed: reader.unparsed,
      startedAt: reader.firstT,
      endedAt: reader.lastT,
      players,
      encounters: this.encounters,
      eventTypes: Object.fromEntries(reader.eventTypes),
    };
  }
}
