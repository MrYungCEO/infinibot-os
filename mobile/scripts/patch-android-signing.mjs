#!/usr/bin/env node
// Idempotently wire a real release signing config into an Expo-prebuilt
// android/app/build.gradle. Re-run after every `expo prebuild --clean`.
//
// The keystore itself never lives in a repo: build.gradle reads the path of a
// keystore.properties file (storeFile/storePassword/keyAlias/keyPassword) from
// env var INFINIBOT_ANDROID_KEYSTORE_PROPS at build time. If the env var is
// unset or the file is missing, release falls back to debug signing.
//
// Usage: node patch-signing.mjs [path/to/android/app/build.gradle]
import fs from 'node:fs';
import path from 'node:path';

const MARK = '// @infinibot-release-signing';
const gradle = path.resolve(
  process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'mobile/android/app/build.gradle'),
);
let src = fs.readFileSync(gradle, 'utf8');

if (src.includes(MARK)) {
  console.log(`[patch-signing] already patched: ${gradle}`);
  process.exit(0);
}

// 1) Load the properties file (top of file, before `android {`).
const loader = `
${MARK} (loader)
def infinibotSigningProps = new Properties()
def infinibotSigningPropsPath = System.getenv('INFINIBOT_ANDROID_KEYSTORE_PROPS')
def infinibotHasReleaseSigning = false
if (infinibotSigningPropsPath && new File(infinibotSigningPropsPath).isFile()) {
    new File(infinibotSigningPropsPath).withInputStream { infinibotSigningProps.load(it) }
    infinibotHasReleaseSigning = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].every { infinibotSigningProps.getProperty(it) }
}
if (!infinibotHasReleaseSigning) {
    logger.warn('[infinibot] INFINIBOT_ANDROID_KEYSTORE_PROPS not set/invalid - release will be DEBUG-signed')
}
`;
const androidIdx = src.search(/^android\s*\{/m);
if (androidIdx < 0) throw new Error('android { block not found');
src = src.slice(0, androidIdx) + loader + '\n' + src.slice(androidIdx);

// 2) Add a `release` entry to signingConfigs, right after the debug entry.
const debugCfg = /(signingConfigs\s*\{\s*\n\s*debug\s*\{[^}]*\})/m;
if (!debugCfg.test(src)) throw new Error('signingConfigs.debug block not found');
src = src.replace(
  debugCfg,
  `$1
        ${MARK} (config)
        release {
            if (infinibotHasReleaseSigning) {
                storeFile file(infinibotSigningProps.getProperty('storeFile'))
                storePassword infinibotSigningProps.getProperty('storePassword')
                keyAlias infinibotSigningProps.getProperty('keyAlias')
                keyPassword infinibotSigningProps.getProperty('keyPassword')
            }
        }`,
);

// 3) Point buildTypes.release at it (debug fallback).
const relType = /(buildTypes\s*\{[\s\S]*?\n\s*release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/m;
if (!relType.test(src)) throw new Error('buildTypes.release signingConfig not found');
src = src.replace(
  relType,
  `$1${MARK} (buildType)\n            signingConfig infinibotHasReleaseSigning ? signingConfigs.release : signingConfigs.debug`,
);

fs.writeFileSync(gradle, src);
console.log(`[patch-signing] patched: ${gradle}`);
