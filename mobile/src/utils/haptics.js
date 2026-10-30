/**
 * haptics — light tactile feedback for taps that change something.
 *
 * Uses React Native's built-in Vibration so it needs no native module (an
 * OTA/JS-only change). Android gets a short tick; iOS's Vibration API only has
 * a long fixed buzz, which is worse than nothing, so iOS stays silent until
 * expo-haptics is added in a native build.
 */
import { Platform, Vibration } from 'react-native';

function pulse(ms) {
  if (Platform.OS !== 'android') return;
  try {
    Vibration.vibrate(ms);
  } catch {}
}

/** Selection / toggle / navigation tap. */
export function tap() {
  pulse(8);
}

/** A confirmed action (sent, saved, pinned). */
export function success() {
  pulse(16);
}

/** A destructive or failed action. */
export function warn() {
  pulse(28);
}
