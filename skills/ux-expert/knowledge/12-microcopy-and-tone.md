# 12 · Microcopy & Tone

## Pattern: Verbs on buttons
- **When**: Any action button.
- **How**: Start with the user's verb + object: "Create project", "Generate video", "Add member". Never "OK", "Submit", "Continue" (when a more specific verb is available).
- **Source**: NN/g button labels; Mailchimp Content Style Guide.

## Pattern: Sentence case for UI
- **When**: All UI labels, menus, buttons.
- **How**: Sentence case improves scan speed + feels less corporate. Title Case reserved for proper nouns and product page titles. Avoid ALL CAPS except for very short tags / status badges.
- **Source**: Material 3; Polaris content.

## Pattern: Error messages — blame the system, not the user
- **When**: Form / API errors.
- **How**:
  - Bad: "Invalid input."
  - Good: "We couldn't find an account with that email. Try another or [create one]."
  - Use plain language; avoid "error", "invalid", "failed" when a friendly verb works.
- **Source**: Mailchimp; GOV.UK content design.

## Pattern: Brevity > cleverness
- **When**: Empty states, tooltips, hints.
- **How**: ≤12 words wherever possible. Cut "please". Cut "you can".
- **Source**: GOV.UK style; *Strategic Writing for UX* (Podmajersky).

## Pattern: Match brand voice
- **When**: Any user-facing string.
- **How**: Pin 3 axes (formal↔casual, serious↔playful, reserved↔enthusiastic) in a voice guide. Audit every new string against it. Consistency > cleverness.
- **Source**: Mailchimp voice & tone.

## Pattern: Numbers for clarity, words for delight
- **When**: Counts, times, sizes.
- **How**: "3 items selected" not "Three items selected." Use words for marketing copy ("ten thousand creators").
- **Source**: AP / Chicago style; tech writing convention.

## Pattern: Localizable from day one
- **When**: Writing any string.
- **How**: Never concatenate. Use ICU MessageFormat for plurals/genders. Leave room for ~30% expansion in containers (German, Finnish).
- **Source**: ICU spec; W3C i18n.

## Pattern: Don't lecture
- **When**: Banners, modals, onboarding.
- **How**: One sentence + action. If you need a second sentence, you probably need a tooltip on a smaller piece.
- **Source**: GOV.UK; Linear's product principles.

## Anti-pattern checklist
- "Oops! Something went wrong." with no recovery.
- "Click here" links.
- Tooltips longer than 2 lines.
- Inconsistent capitalization between menu and page heading.
- Friendly tone on serious errors (data loss should NOT be cheery).
