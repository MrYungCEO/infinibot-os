// native-haptic.js — a page's haptic request (`selection` | `light` | `medium`
// | `heavy` | `success` | `warning` | `error`) → expo-haptics. No-op on the web
// export or when the module is missing. Shared by the embedded web surfaces.
import { Platform } from 'react-native';

let Haptics = null;
try {
  // eslint-disable-next-line global-require
  Haptics = require('expo-haptics');
} catch {
  Haptics = null;
}

export function nativeHaptic(style) {
  if (!Haptics || Platform.OS === 'web' || typeof style !== 'string' || !style) return;
  try {
    let p;
    if (style === 'selection') p = Haptics.selectionAsync();
    else if (style === 'success' || style === 'warning' || style === 'error') {
      const T = Haptics.NotificationFeedbackType || {};
      p = Haptics.notificationAsync(T[style[0].toUpperCase() + style.slice(1)]);
    } else {
      const S = Haptics.ImpactFeedbackStyle || {};
      p = Haptics.impactAsync(S[style[0].toUpperCase() + style.slice(1)]);
    }
    p?.catch?.(() => {});
  } catch { /* no haptics */ }
}
