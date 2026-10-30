# Clawdbot (iOS)

Internal-only SwiftUI app scaffold.

## Lint/format (required)
```bash
brew install swiftformat swiftlint
```

## Generate the Xcode project
```bash
cd apps/ios
xcodegen generate
open Moltbot.xcodeproj
```

## Code signing
Signing settings are not in `project.yml`. They live in `Config/Signing.xcconfig`
(neutral defaults: automatic signing, no team). To build on a device, set your
own team and bundle id:

```bash
cd apps/ios
cp Config/Local.xcconfig.example Config/Local.xcconfig   # gitignored
# edit DEVELOPMENT_TEAM and PRODUCT_BUNDLE_IDENTIFIER
xcodegen generate
```

For fastlane, set `IOS_DEVELOPMENT_TEAM` and `IOS_BUNDLE_ID` in `fastlane/.env`.

## Shared packages
- `../shared/ClawdbotKit` — shared types/constants used by iOS (and later macOS bridge + gateway routing).

## fastlane
```bash
brew install fastlane

cd apps/ios
fastlane lanes
```

See `apps/ios/fastlane/SETUP.md` for App Store Connect auth + upload lanes.
