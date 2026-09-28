// electron-builder configuration. Signing and notarization switch on when their credentials are in the
// environment (see scripts/signing.cjs) and are skipped otherwise, so the same config builds unsigned locally and
// signed in CI.
const { signing } = require("./scripts/signing.cjs");

const env = process.env;
const { macSigned, macNotarized, azure, winSigned } = signing(env);

/**
 * The name and ids repeat src/core/identity.ts and package.json (productName, desktopName); test/identity.test.ts
 * keeps them in step. Every icon comes from build/icon.png (build/icon-mac.png, with the macOS margin, for the .icns).
 * @type {import("electron-builder").Configuration}
 */
module.exports = {
  appId: "io.guildbook.vigil",
  productName: "Vigil",
  copyright: "Copyright Guildbook contributors",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  extraResources: [
    { from: "resources/addon", to: "addon" },
    // Tray icons (scripts/tray-icons.ts), read from disk by Tray: template PNGs on macOS, .ico on Windows, PNG on Linux.
    { from: "resources/tray", to: "tray" },
    // The window, notification and About panel icon on Windows and Linux (src/main/identity.ts).
    { from: "build/icon.png", to: "icon.png" },
  ],
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
  // The shortcut carries appId as its AppUserModelID; src/main/identity.ts sets the same id at runtime.
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
    shortcutName: "Vigil",
    uninstallDisplayName: "Vigil",
  },

  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    icon: "build/icon.png",
    // vigil.desktop, Icon=vigil and StartupWMClass=vigil, matching package.json's desktopName, which Electron uses
    // as the window's WM_CLASS and Wayland app_id; without the match docks show a generic icon.
    executableName: "vigil",
    syncDesktopName: true,
    desktop: { entry: { Name: "Vigil", StartupWMClass: "vigil" } },
    category: "Utility",
    synopsis: "Live combat log analysis for WoW: Forever",
  },
};
