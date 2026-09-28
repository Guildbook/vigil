// electron-builder configuration. Signing and notarization switch on when their credentials are in the
// environment (see scripts/signing.cjs) and are skipped otherwise, so the same config builds unsigned locally and
// signed in CI.
const { signing } = require("./scripts/signing.cjs");

const env = process.env;
const { macSigned, macNotarized, azure, winSigned } = signing(env);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "io.guildbook.vigil",
  productName: "Vigil",
  copyright: "Copyright Guildbook contributors",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  extraResources: [{ from: "resources/addon", to: "addon" }],
  electronLanguages: ["en", "en-US"],
  protocols: [{ name: "Vigil pairing", schemes: ["vigil-companion"] }],
  artifactName: "Vigil-${version}-${os}-${arch}.${ext}",
  // Releases are tagged v0.1.0 and so on; the release workflow creates the draft this uploads to.
  publish: [{ provider: "github", owner: "Guildbook", repo: "vigil", releaseType: "draft" }],

  mac: {
    category: "public.app-category.utilities",
    target: [
      { target: "dmg", arch: ["universal"] },
      { target: "zip", arch: ["universal"] },
    ],
    icon: "build/icon-mac.png",
    // Without a Developer ID the app is ad-hoc signed, which Apple Silicon requires to launch at all.
    identity: macSigned ? undefined : "-",
    hardenedRuntime: macSigned,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    gatekeeperAssess: false,
    notarize: macNotarized,
  },
  dmg: { title: "Vigil ${version}" },

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    signExecutable: winSigned,
    azureSignOptions: azure
      ? {
          publisherName: env.AZURE_TRUSTED_SIGNING_PUBLISHER,
          endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
          codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT,
          certificateProfileName: env.AZURE_TRUSTED_SIGNING_PROFILE,
        }
      : undefined,
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },

  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    icon: "build/icon.png",
    category: "Utility",
    synopsis: "Live combat log analysis for WoW: Forever",
  },
};
