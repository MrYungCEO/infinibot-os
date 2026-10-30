/**
 * perf-tier — how much visual effect the Infini page can afford on this device,
 * and whether its animations should be running at all.
 *
 *   high  iOS, web, and recent / well-equipped Android phones
 *   low   Android with < 3 GB RAM or a device year class before 2019
 *
 * The low tier keeps the same look but trims the cost: fewer thinking
 * particles, a still (not drifting) backdrop and a lighter one (no near
 * dust layer, no violet nebula blob). Unknown values never
 * downgrade — we only cap effects when the device tells us it is modest.
 */
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

const GB = 1024 * 1024 * 1024;

/** Pure: pick a tier from what the platform reports. */
export function perfTierFor({ os, totalMemory, yearClass } = {}) {
  if (os !== 'android') return 'high';
  if (typeof totalMemory === 'number' && totalMemory > 0 && totalMemory < 3 * GB) return 'low';
  if (typeof yearClass === 'number' && yearClass > 0 && yearClass < 2019) return 'low';
  return 'high';
}

/** Per-tier effect budget for the face and backdrop. */
export function effectBudget(tier) {
  return tier === 'low' ? { particles: 8, auroraMotion: false, backdropLite: true } : { particles: 14, auroraMotion: true, backdropLite: false };
}

let cachedTier = null;
/** The device's tier (computed once; expo-device is optional). */
export function devicePerfTier() {
  if (cachedTier) return cachedTier;
  let totalMemory = null;
  let yearClass = null;
  if (Platform.OS === 'android') {
    try {
      const Device = require('expo-device');
      totalMemory = Device.totalMemory;
      yearClass = Device.deviceYearClass;
    } catch {
      /* not available — assume capable */
    }
  }
  cachedTier = perfTierFor({ os: Platform.OS, totalMemory, yearClass });
  return cachedTier;
}

/** True while the app is in the foreground (AppState 'active'). */
export function useAppActive() {
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub?.remove?.();
  }, []);
  return active;
}
