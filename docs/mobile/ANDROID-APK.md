# Building the Android APK locally

The Setup › Mobile page offers the APK published under
`<state dir>/mobile/apk/` (see `scripts/mobile-apk-publish.mjs`). To build a
release APK without EAS:

```bash
cd mobile
npm install --legacy-peer-deps          # a pre-existing @testing-library/react-hooks peer conflict needs this
export JAVA_HOME=~/.infinibot/android-build-tools/jdk-17
export ANDROID_HOME=~/.infinibot/android-build-tools/android-sdk   # needs ndk;27.1.12297006 + cmake;3.22.1
# optional, public values: InfiniBot Cloud sign-in in the app
export INFINIBOT_CLERK_PUBLISHABLE_KEY=pk_live_…  INFINIBOT_CLOUD_ORCHESTRATOR_URL=https://<orchestrator>
npx expo prebuild --platform android --no-install --clean
INFINIBOT_ANDROID_KEYSTORE_PROPS=/path/outside/repo/keystore.properties \
  node scripts/patch-android-signing.mjs android/app/build.gradle
cd android && NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64
cd ../.. && node scripts/mobile-apk-publish.mjs mobile/android/app/build/outputs/apk/release/app-release.apk
```

Never build with `mobile/.env.local` present: Expo inlines `EXPO_PUBLIC_*`
values into the bundle, and a distributed APK must not carry a gateway token.

`keystore.properties` holds `storeFile`, `storePassword`, `keyAlias` and
`keyPassword`. Keep the keystore and the properties file outside the repo; if
`INFINIBOT_ANDROID_KEYSTORE_PROPS` is unset the patch falls back to debug
signing. Updates must be signed with the same key.

The build needs about 12 GB of free disk (NDK, Gradle caches, intermediates).

## App Links (https alert links open the app)

`https://<host>/m/<path>` links are declared as verified App Links for the
hosts in `app.json` / `INFINIBOT_APP_LINK_HOSTS`. Verification requires the
host to serve `/.well-known/assetlinks.json`:

```json
[{"relation":["delegate_permission/common.handle_all_urls"],
  "target":{"namespace":"android_app","package_name":"<android package>",
  "sha256_cert_fingerprints":["<signing cert SHA-256, colon-separated>"]}}]
```

A gateway serves it when `INFINIBOT_ANDROID_APP_LINKS_JSON` is set. Without
verification the `/m/` opener page still hands off to the app (Android
`intent://`, iOS `infinibot://`) and falls back to the web UI.
