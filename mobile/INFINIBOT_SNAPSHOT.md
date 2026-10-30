# InfiniBot Mobile (Expo)

This `mobile/` directory is the InfiniBot Expo client. It pairs with the
gateway at the InfiniBot repo root. It is on Expo SDK 58 and runs in Expo Go;
remote push and custom bundle ids need a development build (EAS or `expo run:*`).
See README.md for build steps and how to set your own bundle ids / EAS project.

## How the dashboard finds this directory

The `/mobile` page in the InfiniBot UI drives this project from the
backend handler at `src/gateway/server-methods/mobile.ts`. Discovery
order, in `readConfig()` → `discoverExpoProjectDir()`:

1. Whatever path the operator wrote with `mobile.config.set` (persisted
   to `state/mobile.json`, gitignored).
2. `INFINIBOT_MOBILE_EXPO_DIR` env var.
3. **`<repo>/mobile/`** — this directory. Default after a fresh clone.
4. Sibling `infinibot_mobile_expo/` next to the InfiniBot repo (the
   common dev layout).

So this directory is the canonical, in-repo Expo project. It works out
of the box; no `mobile.config.set` call is required.

## Origin

Snapshotted from a sibling `infinibot_mobile_expo/` Expo project at
import time (the original lived at
`<dev-root>/infinibot_mobile_expo/`). It was its own git repo; this is
a flat copy of the source tree, not a submodule. `node_modules/`,
`dist/`, `dist-check/`, `.expo/`, `test-build/`, and `whiteboards/`
were excluded — see the rsync command in the commit that introduced
this directory for the full filter.

## Working in here

```sh
cd mobile
npm install   # or pnpm install
npx expo start --tunnel   # or use the /mobile page in the dashboard
```

For builds: `npx eas build --profile preview --platform ios`. Same
flow the `/mobile` page exposes via `mobile.eas.build`.
