# Brief · COPY-01 · Verb-first CTA microcopy pass

## Files
- All button labels under `app/studio/**`
- Confirm-dialog primitives shared across the app

## Brand-system constraints
- Sentence case (not Title Case).
- Brand voice: confident, plain, action-oriented (creator-tool tone).
- Localizable strings — never concatenate.

## Problem
Generic verbs ("Submit", "OK", "Continue", "Cancel") leak into storyboard dialogs. Per `knowledge/07` + `knowledge/12`, button labels should be the user's verb + object.

## Acceptance criteria
- Replacement table (extend as found):
  | Before | After |
  |---|---|
  | Submit | Render video / Generate scene (context-specific) |
  | OK (confirm delete) | Delete scene |
  | Continue (next step) | Add voiceover |
  | Cancel (in destructive) | Keep scene |
  | Save | Save draft |
  | Close | Close (only for non-action dismiss) |
- Sentence case across the board.
- Destructive verbs colored `danger`, paired with a non-destructive default-focused button.
- No "Click here" or "Learn more" without context.

## Verification
- Grep for `>Submit<`, `>OK<`, `>Continue<` in `app/studio/**` → zero remaining.
- Manual walkthrough of every dialog → buttons match the action.
- No string concatenation introduced (i18n-safe).

## Knowledge refs
- `knowledge/07-conversion-patterns.md` → Verb-first CTA microcopy
- `knowledge/12-microcopy-and-tone.md` → Verbs on buttons; Sentence case
