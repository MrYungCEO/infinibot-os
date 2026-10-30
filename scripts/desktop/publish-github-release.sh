#!/usr/bin/env bash
# Publish staged InfiniBot Desktop installers as a GitHub Release on the PUBLIC
# installers-only repo. OUTWARD-FACING: run only after owner approval.
#
#   scripts/desktop/publish-github-release.sh --candidate <artifact-dir> <version>
#       uploads the installers to a DRAFT release (never public, never Latest)
#       so the release gate can test them on real Windows + Linux runners:
#         gh workflow run release-gate.yml -R <repo> -f tag=v<version>
#       Build candidates with the FINAL version (2026.10.19, not -rc.N): the
#       gate is bound to the sha256s, so the gated files are what ships, and a
#       prerelease version makes electron-updater look for prereleases.
#   scripts/desktop/publish-github-release.sh <artifact-dir> <version>
#       publishes + marks Latest. Checks for a passing release-gate run for
#       these exact exe + AppImage sha256s (release-gate/check-gate.sh): warns
#       when there is none, REFUSES when REQUIRE_RELEASE_GATE=1.
#   scripts/desktop/publish-github-release.sh --force-unsafe <artifact-dir> <version>
#       skips the gate. Don't: 2026.10.18 shipped broken onboarding + voice on
#       real Windows that Wine and unit tests never saw.
#
# <artifact-dir> must contain InfiniBot-Setup-x64.exe, InfiniBot-x86_64.AppImage,
# infinibot_amd64.deb, SHA256SUMS, latest.yml, latest-linux.yml and
# RELEASE_NOTES.md. Asset names are version-less, so
#   https://github.com/$REPO/releases/latest/download/<name>
# (and the infinibotos.com /download/* 302s) always point at the newest build.
# latest*.yml feed electron-updater (publish config in
# electron/electron-builder.release.cjs). The source repo stays private: the
# releases repo only ever holds a README and release assets.
set -euo pipefail
MODE=publish
case "${1:-}" in
  --candidate) MODE=candidate; shift ;;
  --force-unsafe) MODE=unsafe; shift ;;
esac
DIR=${1:?artifact dir}; VERSION=${2:?version}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${IB_DESKTOP_RELEASE_REPO_FULL:-MrYungCEO/infinibot-desktop-releases}
TAG="v$VERSION"
cd "$DIR"
FILES=(InfiniBot-Setup-x64.exe InfiniBot-x86_64.AppImage infinibot_amd64.deb SHA256SUMS latest.yml latest-linux.yml)
if [ "$MODE" = candidate ]; then
  # The gate only needs the two installers it tests; upload whatever else exists.
  for f in InfiniBot-Setup-x64.exe InfiniBot-x86_64.AppImage; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done
  CAND=()
  for f in "${FILES[@]}"; do [ -f "$f" ] && CAND+=("$f"); done
  FILES=("${CAND[@]}")
  [ -f RELEASE_NOTES.md ] || echo "Release-gate candidate $VERSION (draft, never public)." > RELEASE_NOTES.md
else
  for f in "${FILES[@]}" RELEASE_NOTES.md; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done
  sha256sum -c SHA256SUMS
  grep -q "^version: $VERSION$" latest.yml && grep -q "^version: $VERSION$" latest-linux.yml \
    || { echo "latest*.yml version != $VERSION"; exit 1; }
fi

# 1. Public installers-only repo (once). --add-readme gives it the first commit a
#    tag needs; the README is then replaced with download instructions.
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public --add-readme \
    --description "InfiniBot Desktop installers" \
    --homepage "https://infinibotos.com/download"
  if [ -f README.releases.md ]; then
    gh api -X PUT "repos/$REPO/contents/README.md" -f message="README: download links" \
      -f content="$(base64 -w0 README.releases.md)" \
      -f sha="$(gh api "repos/$REPO/contents/README.md" --jq .sha)" >/dev/null
  fi
fi

# 2a. Candidate: a draft release the gate downloads from. Drafts are invisible
#     to the public, the download page and electron-updater.
if [ "$MODE" = candidate ]; then
  if gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null | grep -qx false; then
    echo "$TAG is already PUBLISHED; refusing to overwrite its assets"; exit 1
  fi
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber
  else
    gh release create "$TAG" "${FILES[@]}" --repo "$REPO" --draft --prerelease \
      --title "InfiniBot Desktop $VERSION (release-gate candidate)" --notes-file RELEASE_NOTES.md
  fi
  echo "draft $TAG uploaded. Run the gate:"
  echo "  gh workflow run release-gate.yml -R $REPO -f tag=$TAG"
  exit 0
fi

# 2b. Release gate: a real-Windows + real-Linux end-to-end run must have
#     passed for these exact installers.
if [ "$MODE" = unsafe ]; then
  printf '\n\033[1;41;97m%s\033[0m\n' \
    "  !!! --force-unsafe: PUBLISHING WITHOUT THE RELEASE GATE !!!  " \
    "  Nobody has proven this build installs, onboards, talks and   " \
    "  speaks on a real Windows/Linux machine. 2026.10.18 shipped   " \
    "  three broken first-run features this way.                    " >&2
  "$HERE/release-gate/check-gate.sh" InfiniBot-Setup-x64.exe InfiniBot-x86_64.AppImage \
    || echo "(gate: no passing run; publishing anyway in 10 s, Ctrl-C to abort)" >&2
  sleep 10
elif [ "${REQUIRE_RELEASE_GATE:-0}" = 1 ]; then
  "$HERE/release-gate/check-gate.sh" InfiniBot-Setup-x64.exe InfiniBot-x86_64.AppImage || {
    echo "REFUSING to publish $TAG: the release gate has not passed for these installers." >&2
    echo "(--force-unsafe overrides; it is never the right call for a public release.)" >&2
    exit 1
  }
else
  # Owner decision 2026-10-17: warn-only until the gate is the norm.
  # REQUIRE_RELEASE_GATE=1 makes a missing pass a hard refusal.
  if ! "$HERE/release-gate/check-gate.sh" InfiniBot-Setup-x64.exe InfiniBot-x86_64.AppImage; then
    printf '\n\033[1;43;30m%s\033[0m\n' \
      "  WARNING: no passing release-gate run for these installers.   " \
      "  Publishing anyway (set REQUIRE_RELEASE_GATE=1 to refuse).     " >&2
    sleep 5
  fi
fi

# 2c. Release + assets, marked latest (promotes the gate's draft if present).
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber
  gh release edit "$TAG" --repo "$REPO" --draft=false --prerelease=false --latest \
    --title "InfiniBot Desktop $VERSION" --notes-file RELEASE_NOTES.md
else
  gh release create "$TAG" "${FILES[@]}" --repo "$REPO" \
    --title "InfiniBot Desktop $VERSION" --notes-file RELEASE_NOTES.md --latest
fi

# 3. Verify what GitHub serves: latest/download resolves + same SHA-256.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for f in InfiniBot-Setup-x64.exe InfiniBot-x86_64.AppImage infinibot_amd64.deb SHA256SUMS; do
  curl -fsSL -o "$TMP/$f" "https://github.com/$REPO/releases/latest/download/$f"
done
(cd "$TMP" && sha256sum -c SHA256SUMS)
echo "published $TAG to https://github.com/$REPO/releases/tag/$TAG"
