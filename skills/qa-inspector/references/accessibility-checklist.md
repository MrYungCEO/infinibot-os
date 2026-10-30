# Accessibility Testing Checklist (WCAG 2.1 AA)

## Quick Checklist

### Perceivable
- [ ] All images have meaningful alt text (or empty alt="" for decorative)
- [ ] Color contrast is 4.5:1 for normal text, 3:1 for large text
- [ ] Information is not conveyed by color alone
- [ ] Audio/video has captions or transcripts
- [ ] Content can be resized to 200% without loss of functionality

### Operable
- [ ] All functionality available via keyboard
- [ ] Focus order is logical (left-to-right, top-to-bottom)
- [ ] Focus indicators are visible and styled
- [ ] No keyboard traps
- [ ] Skip links available for navigation
- [ ] Page title is descriptive
- [ ] Link purpose is clear from link text
- [ ] Touch targets are 44x44px minimum

### Understandable
- [ ] Language is declared on `<html>` element
- [ ] Form labels are properly associated
- [ ] Error messages are clear and helpful
- [ ] Required fields are indicated
- [ ] Consistent navigation across pages

### Robust
- [ ] Valid HTML (no duplicate IDs)
- [ ] ARIA used correctly where needed
- [ ] Works with screen readers

---

## Detailed Testing Procedures

### 1. Keyboard Navigation Test

**Test procedure:**
1. Put mouse aside
2. Tab through entire page
3. Note focus order
4. Test all interactive elements

**Check:**
```
□ Tab moves forward through focusable elements
□ Shift+Tab moves backward
□ Enter activates buttons and links
□ Space activates buttons and checkboxes
□ Arrow keys navigate menus, tabs, radio groups
□ Escape closes modals and dropdowns
□ No element is unreachable
□ No focus traps (can always tab out)
□ Focus indicator always visible
```

**Common failures:**
- Custom components without keyboard support
- Modal doesn't trap focus
- Dropdown menu not keyboard accessible
- Focus goes behind modal
- Skip to content link missing

---

### 2. Screen Reader Test

**Tools:**
- macOS: VoiceOver (Cmd+F5)
- Windows: NVDA (free) or JAWS
- Mobile: VoiceOver (iOS) or TalkBack (Android)

**Test procedure:**
1. Enable screen reader
2. Navigate page using screen reader commands
3. Complete primary user task

**Check:**
```
□ Page title is announced
□ Headings create logical outline
□ Landmarks are present (header, main, nav, footer)
□ Images announced with alt text
□ Links and buttons have accessible names
□ Forms announced correctly with labels
□ Dynamic content announced (ARIA live regions)
□ Errors associated with inputs
□ Tables have headers
```

**Common failures:**
- Icon buttons without labels
- Images without alt text
- Form inputs without labels
- Unlabeled close buttons
- Dynamic updates not announced

---

### 3. Visual Inspection

#### Color Contrast

**Tools:**
- Chrome DevTools (Inspect element > Color picker)
- WebAIM Contrast Checker
- axe DevTools extension

**Requirements:**
| Element | Minimum Ratio |
|---------|--------------|
| Normal text (<24px) | 4.5:1 |
| Large text (≥24px or ≥18.5px bold) | 3:1 |
| UI components & graphics | 3:1 |

**Check:**
```
□ Body text meets 4.5:1
□ Links are distinguishable and meet contrast
□ Placeholder text meets 4.5:1
□ Error text meets 4.5:1
□ Button text meets 4.5:1
□ Disabled states meet 3:1 (or clearly disabled)
□ Focus indicators meet 3:1
```

#### Color Independence

**Check:**
```
□ Links have underline (not just color)
□ Required fields have indicator (not just color)
□ Errors have icon or text (not just red)
□ Success has icon or text (not just green)
□ Charts have patterns/labels (not just colors)
```

---

### 4. HTML Structure Audit

#### Headings
```
□ H1 present and unique per page
□ Headings follow hierarchy (no skipping levels)
□ Headings describe section content
□ No headings used for styling only
```

**Good:**
```html
<h1>Dashboard</h1>
  <h2>Recent Activity</h2>
  <h2>Statistics</h2>
    <h3>Revenue</h3>
    <h3>Users</h3>
```

**Bad:**
```html
<h1>Dashboard</h1>
  <h4>Recent Activity</h4>  <!-- Skipped h2, h3 -->
  <h2>Statistics</h2>
```

#### Landmarks
```
□ <header> or role="banner" for site header
□ <nav> or role="navigation" for navigation
□ <main> or role="main" for main content
□ <footer> or role="contentinfo" for footer
□ <aside> or role="complementary" for sidebars
```

#### Lists
```
□ Related items in <ul> or <ol>
□ Navigation links in <nav><ul>
□ Definition terms in <dl>
```

---

### 5. Form Accessibility

**Check:**
```
□ Every input has a <label>
□ Labels are visible (not placeholder only)
□ Required fields indicated visually and programmatically
□ Error messages associated with inputs (aria-describedby)
□ Error messages are specific and helpful
□ Form validation on submit, not just on blur
□ Autocomplete attributes present where appropriate
□ Fieldsets group related inputs
□ Legends describe fieldset groups
```

**Good form structure:**
```html
<form>
  <div class="field">
    <label for="email">Email Address *</label>
    <input 
      type="email" 
      id="email" 
      name="email" 
      required
      aria-required="true"
      aria-describedby="email-error"
      autocomplete="email"
    >
    <span id="email-error" class="error" role="alert">
      Please enter a valid email
    </span>
  </div>
</form>
```

---

### 6. Images & Media

#### Images
```
□ Meaningful images have descriptive alt text
□ Decorative images have alt=""
□ Complex images have extended descriptions
□ Text in images is also in alt text
□ No images of text (use real text)
```

#### Videos
```
□ Captions provided
□ Transcript provided
□ Audio description for visual content
□ Player controls are keyboard accessible
□ No autoplay with sound
```

---

### 7. Dynamic Content

#### ARIA Live Regions
```html
<!-- For status messages -->
<div role="status" aria-live="polite">
  Form submitted successfully
</div>

<!-- For errors/alerts -->
<div role="alert" aria-live="assertive">
  Error: Please fix the following issues
</div>
```

**Check:**
```
□ Success messages announced
□ Error messages announced
□ Loading states announced
□ New content announced
□ Live regions not overused (annoying)
```

#### Modals
```
□ Focus moves to modal when opened
□ Focus trapped within modal
□ Escape key closes modal
□ Focus returns to trigger when closed
□ Background content hidden (aria-hidden)
```

---

### 8. Responsive & Zoom

**Test at 200% zoom:**
```
□ All content still visible
□ No horizontal scroll
□ Text doesn't overflow
□ No overlapping elements
□ Functionality preserved
```

**Test with text-only zoom:**
```
□ Text scales appropriately
□ Layout accommodates larger text
□ No truncation/cutting off
```

---

## Quick Commands

### Axe DevTools (Chrome)
```
F12 → axe tab → Scan page
```

### Lighthouse Accessibility
```
F12 → Lighthouse → Accessibility → Analyze
```

### VoiceOver (Mac)
```
Cmd+F5 to toggle
Ctrl+Option+A to read page
```

### Check Focus Order
```javascript
document.addEventListener('focusin', e => console.log(e.target));
```

### Find Missing Labels
```javascript
document.querySelectorAll('input:not([aria-label]):not([id])')
```
