/**
 * orientation — the app is portrait-only, except the Infini call screen,
 * which may rotate to landscape (bigger face, side panels).
 *
 * Runtime locks (expo-screen-orientation) rather than app.json alone, because
 * Expo Go doesn't apply the app's orientation setting and native builds need
 * app.json "default" for landscape to be possible at all:
 *
 *   lockPortrait()              — app start + whenever the Infini screen blurs
 *   useRotationWhileFocused()   — unlock while the Infini screen is focused
 *
 * All calls are best-effort: no-ops on web and when the native module is
 * missing (an older dev client), never throw.
 */
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

let SO = null;
try {
  // eslint-disable-next-line global-require
  SO = Platform.OS === 'web' ? null : require('expo-screen-orientation');
} catch {
  SO = null;
}

export function lockPortrait() {
  if (!SO?.lockAsync) return Promise.resolve(false);
  return SO.lockAsync(SO.OrientationLock.PORTRAIT_UP).then(
    () => true,
    () => false,
  );
}

export function allowRotation() {
  if (!SO?.unlockAsync) return Promise.resolve(false);
  return SO.unlockAsync().then(
    () => true,
    () => false,
  );
}

/** Let the focused screen rotate freely; snap back to portrait on blur/unmount. */
export function useRotationWhileFocused() {
  useFocusEffect(
    useCallback(() => {
      void allowRotation();
      return () => {
        void lockPortrait();
      };
    }, []),
  );
}
