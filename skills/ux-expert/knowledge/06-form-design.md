# 06 · Form Design

## Pattern: One thing per page (for serious forms)
- **When**: Multi-step flows (signup, checkout, onboarding).
- **How**: One question per screen on critical paths reduces cognitive load + isolates validation errors. Bundle only when grouping is semantically obvious (street + city + zip).
- **Source**: Adam Silver *Form Design Patterns*; GOV.UK Design System.
- **Anti-patterns**: 12-field single-page signup.

## Pattern: Visible labels above inputs
- **When**: Always.
- **How**:
  - Top-aligned label above the field, never placeholder-as-label.
  - Placeholder = example value or hint; disappears on focus.
  - Required marker is a word ("required"), not just an asterisk; or invert and mark optional fields.
- **Source**: NN/g "Placeholders Are Harmful"; GOV.UK.
- **Anti-patterns**: Floating labels that overlap content; placeholder-only fields.

## Pattern: Inline validation — on blur, not on keystroke
- **When**: Form fields with constraints.
- **How**:
  - Validate format on `blur`; clear errors on `input` once the user starts correcting.
  - Show success affirmation only for high-stakes fields (password strength, username availability).
  - Errors appear BELOW the field, in `text-danger`, prefixed by an icon.
- **Source**: Baymard checkout research.
- **Anti-patterns**: Red border on every empty field before submit.

## Pattern: Autofill-friendly markup
- **When**: Any auth / address / payment form.
- **How**:
  - `autocomplete="email" / "current-password" / "new-password" / "one-time-code" / "cc-number" / "postal-code"` etc.
  - Use `inputmode="email|numeric|decimal|tel"` for mobile keyboards.
  - Don't break paste on OTP / password fields.
- **Source**: WHATWG autofill spec; Baymard checkout 2024.

## Pattern: Error summary at top + jump links
- **When**: Submit-time validation.
- **How**: Render an error summary above the form listing each error with a link to its field; focus the summary on submit; set `aria-live="assertive"`.
- **Source**: GOV.UK error summary pattern.

## Pattern: Confirm vs. cancel destructive
- **When**: Destructive submit.
- **How**: Destructive button on the LEFT or with danger color; non-destructive default focus; type-to-confirm for high-risk ("type 'DELETE'").
- **Source**: NN/g "Confirmation Dialogs".

## Anti-pattern checklist
- Password field forbidding paste.
- "Submit" as button label (use the verb of the action: "Create account").
- Captcha before validation feedback.
- Errors only at top with no per-field highlight.
- Required asterisk with no legend explanation.
