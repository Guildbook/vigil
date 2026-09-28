/**
 * The app's name and ids, in one place. electron-builder.config.cjs and package.json repeat them (they can't import
 * TypeScript); test/identity.test.ts keeps all three in step.
 */
export const APP_NAME = "Vigil";

/** electron-builder's appId: the macOS bundle id, and the Windows AppUserModelID its installer gives the shortcuts. */
export const APP_ID = "io.guildbook.vigil";

/** The bundle id of the renamed Electron.app that `pnpm dev` runs on macOS (scripts/dev-app.mjs). */
export const DEV_APP_ID = `${APP_ID}.dev`;

/**
 * The name 0.1.0 ran under (package.json's `name`, before it had a productName). Two things are keyed on it and
 * must not move, or players lose their pairing: the settings folder `<appData>/vigil` (Linux paths are
 * case-sensitive), and the safeStorage key that encrypts the device token, which Electron names
 * "<app name> Safe Storage" in the macOS Keychain and the Linux secret service.
 */
export const LEGACY_NAME = "vigil";

export const WEBSITE = "https://guildbook.io/vigil";

export const COPYRIGHT = "Copyright Guildbook contributors";
