import { describe, expect, it } from "vitest";
import { canOpenExternally, trustedSiteOrigin, validHomeUrl, type TrustConfig } from "../src/core/origins";

const release: TrustConfig = { homeUrl: "https://guildbook.io", allowLocal: false };
const dev: TrustConfig = { homeUrl: "http://localhost:3000", allowLocal: true };

describe("trustedSiteOrigin", () => {
  it("accepts the root domain and guild subdomains over https", () => {
    expect(trustedSiteOrigin("https://guildbook.io", release)).toBe("https://guildbook.io");
    expect(trustedSiteOrigin("https://osm.guildbook.io/vigil/companion", release)).toBe("https://osm.guildbook.io");
  });

  it("refuses plain http, ports, credentials, IPs and look-alike domains", () => {
    for (const url of [
      "http://osm.guildbook.io",
      "https://osm.guildbook.io:8443",
      "https://user:pw@osm.guildbook.io",
      "https://203.0.113.9",
      "https://guildbook.io.evil.test",
      "https://evilguildbook.io",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(trustedSiteOrigin(url, release), url).toBeNull();
    }
  });

  it("accepts a custom domain only when the home server named it", () => {
    expect(trustedSiteOrigin("https://order.example", release)).toBeNull();
    expect(trustedSiteOrigin("https://order.example", release, { vouched: true })).toBe("https://order.example");
    expect(trustedSiteOrigin("http://order.example", release, { vouched: true })).toBeNull();
  });

  it("allows local hosts in development builds only", () => {
    expect(trustedSiteOrigin("http://osm.localhost:3000", release)).toBeNull();
    expect(trustedSiteOrigin("http://osm.localhost:3000", release, { vouched: true })).toBeNull();
    expect(trustedSiteOrigin("http://127.0.0.1:3000", release)).toBeNull();
    expect(trustedSiteOrigin("http://osm.localhost:3000/x", dev)).toBe("http://osm.localhost:3000");
  });
});

describe("validHomeUrl", () => {
  it("wants a public https origin, or a local one when allowed", () => {
    expect(validHomeUrl("https://guildbook.io/", false)).toBe("https://guildbook.io");
    expect(validHomeUrl("http://guildbook.io", false)).toBeNull();
    expect(validHomeUrl("http://localhost:3000", false)).toBeNull();
    expect(validHomeUrl("http://localhost:3000", true)).toBe("http://localhost:3000");
  });
});

describe("canOpenExternally", () => {
  it("opens guild pages, the paired custom domain and the project's GitHub pages", () => {
    expect(canOpenExternally("https://osm.guildbook.io/vigil/reports/1", release, null)).toBe(true);
    expect(canOpenExternally("https://order.example/vigil/reports/1", release, "https://order.example")).toBe(true);
    expect(canOpenExternally("https://github.com/Guildbook/vigil/releases", release, null)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(canOpenExternally("https://order.example/vigil", release, null)).toBe(false);
    expect(canOpenExternally("https://other.example/", release, "https://order.example")).toBe(false);
    expect(canOpenExternally("https://github.com/someone/else", release, null)).toBe(false);
    expect(canOpenExternally("file:///etc/passwd", release, null)).toBe(false);
    expect(canOpenExternally("http://localhost:3000/", release, null)).toBe(false);
  });
});
