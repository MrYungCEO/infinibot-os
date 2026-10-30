/**
 * Canvas Pro keybindings.
 *
 *   V select   T text   R rect   O ellipse   L line   H hand
 *   Space (hold)  temporary hand
 *   Cmd+D duplicate   Cmd+A select-all   Cmd+G group   Cmd+Shift+G ungroup
 *   Delete / Backspace remove
 *   Arrow keys nudge 1px / Shift+Arrow nudge 10px
 *   Cmd+0 fit to content   Cmd+= zoom in   Cmd+- zoom out
 *   Cmd+Z undo   Cmd+Shift+Z redo
 *
 * The handler is intentionally engine-agnostic: it emits a normalized
 * `KeymapIntent` that the shell dispatches against the active
 * Excalidraw API (or queues if the canvas isn't mounted yet).
 */

import type { CanvasProToolId } from "./types";

export type KeymapIntent =
  | { kind: "tool"; tool: CanvasProToolId }
  | { kind: "temp-hand-down" }
  | { kind: "temp-hand-up" }
  | { kind: "duplicate" }
  | { kind: "select-all" }
  | { kind: "group" }
  | { kind: "ungroup" }
  | { kind: "delete" }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "fit" }
  | { kind: "zoom"; delta: number }
  | { kind: "undo" }
  | { kind: "redo" };

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

function modPressed(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/**
 * Attach a keymap to the given root element. Returns a disposer.
 * Skips events when focus is in an input/textarea/contenteditable to
 * avoid eating typing in the Excalidraw text tool, layer-name fields,
 * etc.
 */
export function attachKeymap(
  root: HTMLElement | Document,
  dispatch: (intent: KeymapIntent) => void
): () => void {
  let spaceDown = false;

  const isEditable = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditable(e.target)) return;

    const mod = modPressed(e);

    // Space → temporary hand tool while held.
    if (e.code === "Space" && !spaceDown && !mod) {
      spaceDown = true;
      dispatch({ kind: "temp-hand-down" });
      e.preventDefault();
      return;
    }

    if (mod) {
      switch (e.key.toLowerCase()) {
        case "d":
          dispatch({ kind: "duplicate" });
          e.preventDefault();
          return;
        case "a":
          dispatch({ kind: "select-all" });
          e.preventDefault();
          return;
        case "g":
          dispatch({ kind: e.shiftKey ? "ungroup" : "group" });
          e.preventDefault();
          return;
        case "z":
          dispatch({ kind: e.shiftKey ? "redo" : "undo" });
          e.preventDefault();
          return;
        case "0":
          dispatch({ kind: "fit" });
          e.preventDefault();
          return;
        case "=":
        case "+":
          dispatch({ kind: "zoom", delta: 0.1 });
          e.preventDefault();
          return;
        case "-":
          dispatch({ kind: "zoom", delta: -0.1 });
          e.preventDefault();
          return;
      }
    }

    // Tool keys.
    switch (e.key.toLowerCase()) {
      case "v":
        dispatch({ kind: "tool", tool: "select" });
        return;
      case "h":
        dispatch({ kind: "tool", tool: "hand" });
        return;
      case "t":
        dispatch({ kind: "tool", tool: "text" });
        return;
      case "r":
        dispatch({ kind: "tool", tool: "rectangle" });
        return;
      case "o":
        dispatch({ kind: "tool", tool: "ellipse" });
        return;
      case "l":
        dispatch({ kind: "tool", tool: "line" });
        return;
      case "p":
        dispatch({ kind: "tool", tool: "polygon" });
        return;
      case "s":
        dispatch({ kind: "tool", tool: "star" });
        return;
      case "a":
        dispatch({ kind: "tool", tool: "arrow" });
        return;
      case "d":
        dispatch({ kind: "tool", tool: "freehand" });
        return;
      case "i":
        dispatch({ kind: "tool", tool: "image" });
        return;
      case "f":
        dispatch({ kind: "tool", tool: "frame" });
        return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      dispatch({ kind: "delete" });
      return;
    }

    if (e.key.startsWith("Arrow")) {
      const step = e.shiftKey ? 10 : 1;
      const map: Record<string, [number, number]> = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      };
      const m = map[e.key];
      if (m) {
        dispatch({ kind: "nudge", dx: m[0], dy: m[1] });
        e.preventDefault();
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" && spaceDown) {
      spaceDown = false;
      dispatch({ kind: "temp-hand-up" });
    }
  };

  root.addEventListener("keydown", onKeyDown as EventListener);
  root.addEventListener("keyup", onKeyUp as EventListener);

  return () => {
    root.removeEventListener("keydown", onKeyDown as EventListener);
    root.removeEventListener("keyup", onKeyUp as EventListener);
  };
}
