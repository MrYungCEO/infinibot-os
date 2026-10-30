# Bug Report Template

Use this template when filing bugs as kanban tasks.

## Quick Bug Template (for kanban task description)

```markdown
**Severity:** [Critical/High/Medium/Low]
**Browser:** [Chrome 120 / Safari 17 / Firefox 121]
**Device:** [Desktop 1280px / iPhone 14 375px / etc.]
**Component:** [Header / Form / Modal / etc.]

### Description
[1-2 sentence description of the bug]

### Steps to Reproduce
1. Go to [URL]
2. [Action]
3. [Action]
4. Observe: [what happens]

### Expected Behavior
[What should happen]

### Actual Behavior
[What actually happens]

### Screenshot
[Attach or link screenshot]

### Console Errors (if any)
```
[paste console errors]
```
```

---

## Detailed Bug Template (for complex issues)

```markdown
# Bug Report: [Short Title]

**Date:** YYYY-MM-DD
**Reporter:** Inspector
**Project:** [Project Name]
**URL:** [Full URL where bug occurs]

---

## Classification

| Field | Value |
|-------|-------|
| Severity | Critical / High / Medium / Low |
| Type | Visual / Functional / Performance / Accessibility |
| Browser | Chrome 120, Safari 17, Firefox 121 |
| OS | Windows 11 / macOS 14 / iOS 17 / Android 14 |
| Device | Desktop / Tablet / Mobile |
| Viewport | 1920x1080 / 1280x720 / 768x1024 / 375x667 |

---

## Description

[Detailed description of the bug]

---

## Steps to Reproduce

1. Navigate to [URL]
2. [Specific action with selector or location]
3. [Specific action]
4. [Specific action]
5. Observe the bug

**Reproduction rate:** [Always / Sometimes / Rarely] ([X/10] attempts)

---

## Expected Behavior

[What should happen according to requirements/design]

---

## Actual Behavior

[What actually happens - be specific]

---

## Visual Evidence

### Screenshot
![Bug Screenshot](path/to/screenshot.png)

### Video (if interaction bug)
[Link to screen recording]

---

## Technical Details

### Console Output
```javascript
// Paste any console errors or warnings
```

### Network Issues
```
// Paste any failed network requests
```

### Element Inspection
```html
<!-- Relevant HTML structure -->
```

```css
/* Relevant CSS causing issue */
```

---

## Environment

- **Browser:** Chrome 120.0.6099.109
- **OS:** Windows 11 23H2
- **Device:** Desktop
- **Screen Resolution:** 2560x1440 @ 125% scale
- **Network:** Fast 4G simulation / Offline

---

## Impact Assessment

- **User Impact:** [How many users affected? All? Subset?]
- **Business Impact:** [Revenue? Conversion? Brand?]
- **Workaround:** [Is there a workaround? Describe it]

---

## Related Issues

- Related to: #[issue number]
- Possibly caused by: [recent change/commit]
- Affects: [list affected pages/features]

---

## Suggested Fix (if known)

[Optional: If you have insight into the cause/fix]

```javascript
// Suggested code change
```
```

---

## Severity Guidelines

### Critical (P0)
- Data loss or corruption
- Security vulnerability
- Complete feature failure
- Payment/checkout blocked
- App crash / white screen

### High (P1)  
- Core feature broken
- No workaround exists
- Significant UX impact
- Mobile layout unusable
- Accessibility blocker (keyboard users can't proceed)

### Medium (P2)
- Feature partially working
- Workaround exists
- Visual inconsistency
- Performance degradation
- Confusing but usable

### Low (P3)
- Minor polish issues
- Typos
- Edge case
- Enhancement opportunity
- Slightly off spacing/alignment
