/**
 * ui-kit/a11y — accessibility primitives shared by every animated component.
 *
 * `useReducedMotion()` reads the OS "Reduce Motion" switch and subscribes to
 * changes. Every kit component that animates checks it and renders the final
 * state immediately instead of tweening. This is a hard requirement, not a
 * nicety: motion sensitivity is a real accessibility failure mode.
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => {
        if (mounted) setReduced(!!value);
      })
      .catch(() => {});

    const sub = AccessibilityInfo.addEventListener?.(
      'reduceMotionChanged',
      (value) => setReduced(!!value),
    );
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);

  return reduced;
}

/**
 * Build the standard accessibility prop bag for an interactive element.
 * Always pass a label — an icon-only control with no label is invisible to
 * a screen reader.
 */
export function a11yPress({ label, hint, role = 'button', disabled, selected, busy }) {
  return {
    accessible: true,
    accessibilityRole: role,
    accessibilityLabel: label,
    accessibilityHint: hint,
    accessibilityState: {
      disabled: !!disabled,
      ...(selected === undefined ? {} : { selected: !!selected }),
      ...(busy === undefined ? {} : { busy: !!busy }),
    },
  };
}

export default { useReducedMotion, a11yPress };
