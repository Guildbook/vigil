/**
 * Which servers the companion talks to and which links it opens. Every API call goes to one built-in home
 * server (https://guildbook.io in release builds). Pairing codes are global, so home knows which guild a code
 * belongs to and answers with that guild's site: its subdomain, or a verified custom domain that only the server
 * can vouch for. Local hosts are only allowed in development builds.
 */

export interface TrustConfig {
  /** Origin of the home server, e.g. `https://guildbook.io`. */
  homeUrl: string;
  /** Development builds may use `localhost`, `*.localhost` and private IPs over plain HTTP. */
  allowLocal: boolean;
}

const LOCAL_ROOT = "localhost";

function isPrivateIp(host: string): boolean {
  if (host === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === LOCAL_ROOT || host.endsWith(`.${LOCAL_ROOT}`) || isPrivateIp(host);
}

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");

function parse(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

/** The domain guild subdomains live under: the home server's hostname (`guildbook.io`, or `localhost` in dev). */
export function rootDomain(config: TrustConfig): string {
  return new URL(config.homeUrl).hostname.toLowerCase();
}

/**
 * The origin of `raw` when it is a site the companion may use, or null. HTTPS on the default port is required,
 * except for local hosts in development builds. The root domain and its subdomains are always allowed; any other
 * public host only when the home server named it (`vouched`), which is how verified custom domains arrive.
 */
export function trustedSiteOrigin(raw: string | null | undefined, config: TrustConfig, opts: { vouched?: boolean } = {}): string | null {
  const url = raw ? parse(raw) : null;
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (isLocalHostname(host)) {
    if (!config.allowLocal || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
    return url.origin;
  }
  if (url.protocol !== "https:" || url.port || isIp(host) || !host.includes(".")) return null;
  const root = rootDomain(config);
  if (host === root || host.endsWith(`.${root}`)) return url.origin;
  return opts.vouched ? url.origin : null;
}

/** Validates the home server itself, for build scripts and the development override. */
export function validHomeUrl(raw: string, allowLocal: boolean): string | null {
  const url = parse(raw);
  if (!url) return null;
  if (isLocalHostname(url.hostname)) return allowLocal && /^https?:$/.test(url.protocol) ? url.origin : null;
  return url.protocol === "https:" && !url.port && !isIp(url.hostname) ? url.origin : null;
}

/** Project pages the app links to (release notes and downloads). */
export const RELEASES_URL = "https://github.com/Guildbook/vigil/releases";

/**
 * Whether a link may be opened in the browser: pages on the home domain and its guild subdomains, the paired
 * guilds' own sites (which may be custom domains), and the project's GitHub pages.
 */
export function canOpenExternally(raw: string, config: TrustConfig, pairedSites: string | null | readonly (string | null)[]): boolean {
  const url = parse(raw);
  if (!url) return false;
  if (url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith("/Guildbook/")) return true;
  const origin = trustedSiteOrigin(raw, config);
  if (origin) return true;
  const sites: readonly (string | null)[] = typeof pairedSites === "string" || pairedSites === null ? [pairedSites] : pairedSites;
  return sites.some((site) => site && url.origin === site) && Boolean(trustedSiteOrigin(raw, config, { vouched: true }));
}
