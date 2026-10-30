# 15 · Feedback & Status Systems

## Pattern: Acknowledge within 100 ms
- **When**: Any user input.
- **How**: Visual change within 100 ms (button press state, focus, ripple). If the action takes longer, queue a loading state that begins within 300 ms.
- **Source**: Nielsen 1993 response thresholds.

## Pattern: Toast for non-blocking confirmation
- **When**: Background actions ("Saved", "Copied").
- **How**:
  - Bottom-right (web) / bottom-center (mobile).
  - 4–6 s duration; pause on hover/focus.
  - Single line text + optional action ("Undo").
  - Stack max 3 visible; collapse older toasts.
  - `aria-live="polite"` so screen readers announce.
- **Source**: Material 3 snackbar; ARIA APG.
- **Anti-patterns**: Toast for fatal errors (gets missed).

## Pattern: Undo over confirm (for destructive but recoverable)
- **When**: Delete, archive, send.
- **How**: Execute immediately, show toast with "Undo" for 8–10 s. Reserve modals for irreversible destructive actions.
- **Source**: Gmail undo-send; Aza Raskin "Never use a warning when you mean undo".

## Pattern: Optimistic state with clear failure recovery
- **When**: Network-bound mutations.
- **How**: Apply locally → show subtle "saving" tick → on failure, revert + persistent error chip with retry. Never silently drop a mutation.
- **Source**: Linear, Notion patterns.

## Pattern: Progress for long tasks
- **When**: >3 s actions.
- **How**:
  - Determinate progress bar when % is known.
  - Indeterminate bar + descriptive text when not ("Rendering scene 3 of 8…").
  - Allow background continuation; surface in a status dock or notification center.
- **Source**: Material 3 progress; NN/g long-running tasks.

## Pattern: Persistent status surfaces
- **When**: Long-running jobs (render, deploy, sync).
- **How**: A status drawer / mini-dock listing in-flight jobs with progress + cancel. Never rely on a single toast for multi-minute work.
- **Source**: Vercel deployments; Figma exports.

## Pattern: Connection + sync status
- **When**: Realtime / collaborative tooling.
- **How**: Small status pill in header — "Synced", "Reconnecting…", "Offline". Click to expand details.
- **Source**: Figma, Linear, Notion.

## Pattern: Sound + haptic = restraint
- **When**: Native / PWA confirmation.
- **How**: Single subtle haptic on success/error; never on every keystroke. Sound only for accepted-to-be-sonified tools (recording, video editor, ticketing). Always have a mute toggle.
- **Source**: Apple HIG audio + haptics.

## Anti-pattern checklist
- Spinner for >5 s with no descriptive label.
- Toast disappears in 2 s before the user can react.
- Error banner persists with no dismiss + no path forward.
- "Saved" toast on every keystroke.
- Confirm modal for trivially undoable actions.
