/**
 * launchpadStore — global open/close state for the Launchpad page switcher.
 *
 * The Launchpad is mounted ONCE at the root (beside the NavigationContainer) so it can
 * overlay any route and drive the root navigator directly. Every trigger — the
 * dock's launcher button, a header action, a future keyboard shortcut — needs
 * to open it without being anywhere near it in the tree, so the open/close bit
 * lives here rather than in React state.
 *
 * Shape: subscribe / snapshot / hook — a tiny global-overlay store.
 */

import { useEffect, useState } from 'react';

const internal = {
  /** Is the Launchpad overlay showing. */
  open: false,
  /**
   * Bumped on every open. The component keys its "reset query + focus input"
   * effect on this, so re-opening always starts from a clean search field even
   * though the component never unmounts.
   */
  openCount: 0,
};

const listeners = new Set();

function snapshot() {
  return { ...internal };
}

function emit() {
  const snap = snapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      // A bad subscriber must not stop the others from updating.
    }
  }
}

export const launchpadStore = {
  getState: () => snapshot(),

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  open() {
    if (internal.open) return;
    internal.open = true;
    internal.openCount += 1;
    emit();
  },

  close() {
    if (!internal.open) return;
    internal.open = false;
    emit();
  },

  toggle() {
    if (internal.open) this.close();
    else this.open();
  },
};

/** React hook: subscribe a component to the Launchpad store. */
export function useLaunchpad() {
  const [state, setState] = useState(launchpadStore.getState());
  useEffect(() => launchpadStore.subscribe(setState), []);
  return state;
}

export default launchpadStore;
