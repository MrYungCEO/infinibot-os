// Release config for the public desktop installers (Windows NSIS + Linux
// AppImage/.deb). Extends the `build` block in package.json and swaps the
// gateway payload for a per-platform PRODUCTION bundle staged by
// scripts/desktop/stage-bundle.mjs, instead of copying the repo's
// node_modules (dev deps + build-host-only native binaries).
//
//   IB_DESKTOP_STAGE=<abs dir from stage-bundle.mjs> \
//     npx electron-builder --config electron-builder.release.cjs --linux AppImage deb
//
// Asset names are version-less so the download page can link to
// github.com/<repo>/releases/latest/download/<name> forever. The version is
// still inside each artifact (exe VersionInfo, deb control, AppImage desktop
// file) and in the GitHub release tag.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const base = require("./package.json").build;

const stage = process.env.IB_DESKTOP_STAGE;
if (!stage || !fs.existsSync(path.join(stage, "dist", "entry.js"))) {
  throw new Error("IB_DESKTOP_STAGE must point at a staged bundle (scripts/desktop/stage-bundle.mjs)");
}
const releaseRepo = process.env.IB_DESKTOP_RELEASE_REPO || "infinibot-desktop-releases";

module.exports = {
  ...base,
  // "store" made 1.1 GB AppImages; normal compression roughly thirds that.
  compression: "normal",
  directories: { output: process.env.IB_DESKTOP_OUT || "dist" },
  extraResources: [
    {
      // electron-builder resolves `from` relative to this dir; a relative
      // path keeps it from being joined onto electron/ twice.
      from: path.relative(__dirname, stage),
      to: "app",
      filter: ["**/*", "!**/*.map", "!**/.env*"],
    },
  ],
  win: {
    ...base.win,
    target: [{ target: "nsis", arch: ["x64"] }],
    // No code-signing certificate yet: installers are unsigned (SmartScreen
    // shows "Windows protected your PC" → More info → Run anyway).
    signAndEditExecutable: true,
    // publisherName lands in app-update.yml, and electron-updater then
    // rejects any update whose Authenticode status isn't Valid, i.e. every
    // unsigned installer. Put it back together with the signing cert.
    publisherName: null,
  },
  nsis: { ...base.nsis, artifactName: "InfiniBot-Setup-x64.${ext}" },
  linux: {
    ...base.linux,
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
  },
  // scripts/appimage-finalize.mjs re-packs this afterwards: static type-2
  // runtime (no libfuse2 on Ubuntu 22.04+/24.04) + build/appimage/AppRun,
  // which adds --no-sandbox only where no Chromium sandbox can work.
  appImage: { ...base.appImage, artifactName: "InfiniBot-x86_64.${ext}" },
  // Maintainer scripts (build/deb/*.sh, ported from Robovoice Desktop):
  // chrome-sandbox root:root 4755 + an AppArmor `userns` profile, so the
  // sandbox works on Ubuntu 24.04 without --no-sandbox.
  deb: {
    ...base.deb,
    artifactName: "infinibot_amd64.${ext}",
    depends: [...base.deb.depends, "libasound2"],
  },
  // Auto-update feed = the PUBLIC releases repo (the source repo is private,
  // so electron-updater could never read its releases).
  publish: [{ provider: "github", owner: "MrYungCEO", repo: releaseRepo, releaseType: "release" }],
};
