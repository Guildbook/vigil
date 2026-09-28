// Which signing credentials are in the environment. electron-builder.config.cjs switches signing and notarization
// on from this, and the release workflow runs it directly (`node scripts/signing.cjs mac`) to record in the release
// notes whether each build is signed, which the download page reads.
//
//   macOS signing:        CSC_LINK (base64 or path of a Developer ID Application .p12) + CSC_KEY_PASSWORD, or CSC_NAME
//   macOS notarization:   APPLE_API_KEY (path to the .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER,
//                         or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//   Windows, Azure:       AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TRUSTED_SIGNING_ENDPOINT
//                         + AZURE_TRUSTED_SIGNING_ACCOUNT + AZURE_TRUSTED_SIGNING_PROFILE + AZURE_TRUSTED_SIGNING_PUBLISHER
//   Windows, certificate: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (read by electron-builder itself)

function signing(env = process.env) {
  const all = (...keys) => keys.every((k) => Boolean(env[k] && env[k].trim()));
  const macSigned = all("CSC_LINK") || all("CSC_NAME");
  const macNotarized =
    macSigned && (all("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") || all("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"));
  const azure = all(
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT",
    "AZURE_TRUSTED_SIGNING_PROFILE",
    "AZURE_TRUSTED_SIGNING_PUBLISHER",
  );
  return { macSigned, macNotarized, azure, winSigned: azure || all("WIN_CSC_LINK") };
}

module.exports = { signing };

if (require.main === module) {
  // Prints e.g. `mac=signed`. A Mac build only counts as signed when it is also notarized: otherwise Gatekeeper
  // still stops it on first launch.
  const s = signing();
  const platform = process.argv[2];
  if (platform === "mac") console.log(`mac=${s.macNotarized ? "signed" : "unsigned"}`);
  else if (platform === "windows") console.log(`windows=${s.winSigned ? "signed" : "unsigned"}`);
  else if (platform === "linux") console.log("");
  else console.log(JSON.stringify(s));
}
