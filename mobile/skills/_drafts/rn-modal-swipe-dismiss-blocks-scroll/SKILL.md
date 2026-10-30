---
name: rn-modal-swipe-dismiss-blocks-scroll
description: Diagnose and fix React Navigation native-stack modal screens where vertical drags dismiss the modal instead of scrolling content
---
# React Native Modal Dismiss Blocks Vertical Scroll
## When to use
- User reports a screen presented as a modal in `@react-navigation/native-stack` cannot be scrolled — vertical drag dismisses the modal instead.
- A screen mounted inside a `Stack.Group` with `presentation: 'modal'` (or `'formSheet'`) is swallowing pan gestures meant for inner content.
- You see `gestureDirection: 'horizontal'` set on a modal screen and assume it disables vertical dismiss — it does not.
## How to apply
1. Locate the `Stack.Screen` (or `Stack.Group`) in the navigator (usually `App.js` / `RootNavigator.js`). Confirm `presentation: 'modal'` is inherited or set.
2. Note that on iOS native-stack, the modal swipe-to-dismiss gesture is **separate** from the card `gestureDirection` prop. Setting `gestureDirection: 'horizontal'` only affects card-style transitions, not the system modal pan-down.
3. Replace `gestureDirection: 'horizontal'` (or add) with `gestureEnabled: false` on the offending screen's `options`.
4. Verify the screen has an explicit dismiss affordance (chevron/back button calling `navigation.goBack()`) so users can still exit. If missing, add one before disabling the gesture.
5. Keep the change scoped to the single screen — do not blanket-disable on the `Stack.Group`, or sibling modals lose their swipe-down too.
6. Reload via Metro/Expo Fast Refresh and verify: vertical drag inside the screen scrolls or no-ops; explicit back button still exits; other modals unchanged.
## Rules
- Never assume `gestureDirection: 'horizontal'` disables modal vertical dismiss on native-stack — it doesn't.
- Never disable the dismiss gesture without confirming an explicit back/close button exists on the screen.
- Always scope `gestureEnabled: false` to the specific screen's `options`, not the parent `Stack.Group`.
- Always check whether the inner content (WebView, horizontal pager, ScrollView) actually needs to own vertical gestures before reaching for `gestureEnabled: false` — sometimes the real fix is wrapping content in a `ScrollView` that claims the gesture.