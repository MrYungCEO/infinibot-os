# 09 · Empty / Error / Loading States

## Pattern: Skeleton over spinner for >300 ms loads
- **When**: Async content that will render in a known shape.
- **How**:
  - <100 ms: nothing (just render).
  - 100–300 ms: nothing or a delayed shimmer.
  - 300 ms–3 s: skeleton matching the final layout.
  - >3 s: skeleton + progress text ("Generating frames…").
  - >10 s: skeleton + cancel.
- **Source**: NN/g "Response Times"; Nielsen 1993 thresholds.
- **Anti-patterns**: Full-page spinner on every navigation.

## Pattern: Optimistic UI with rollback
- **When**: Likes, todos, drag-reorder, kanban moves.
- **How**: Apply the change immediately client-side; show transient "Saving…" indicator only on slow connections; on failure, revert + toast with "Retry".
- **Source**: Linear, Notion patterns; framer-motion `AnimatePresence`.

## Pattern: First-run empty state = onboarding
- **When**: A user lands on an empty list.
- **How**:
  - Illustration / icon + one-sentence value prop.
  - One primary CTA = the action that creates the first item.
  - Optional "Watch 30s tour" / sample-data button.
- **Source**: Growth.Design empty state studies.
- **Anti-patterns**: "No items found." with no path forward.

## Pattern: Search-zero-result state
- **When**: User query returns nothing.
- **How**: Show what they searched, suggest spelling fixes, recent searches, broader filters, and "Clear filters" button.
- **Source**: Baymard search UX 2024.

## Pattern: Error states — what / why / how to recover
- **When**: Every error surface.
- **How**:
  - WHAT: "Couldn't generate video"
  - WHY: "The render server is offline."
  - HOW: "Retry" + "Save draft" buttons; "Contact support" link.
  - Include correlation ID for support; don't surface stack traces.
- **Source**: NN/g error message guidelines.

## Pattern: Partial / degraded states
- **When**: Some-but-not-all data loads (federation, multi-source).
- **How**: Render what loaded; mark missing tiles as "Couldn't load · Retry"; never hide partial data behind one global failure.
- **Source**: Distributed system UX (CockroachDB, Vercel patterns).

## Pattern: Connection-lost banner
- **When**: Realtime app loses websocket / sync.
- **How**: Sticky top banner: "Working offline · Reconnecting…". Disable destructive actions when offline; queue retries.
- **Source**: Linear, Figma offline patterns.

## Anti-pattern checklist
- Toast as the ONLY error surface (gone in 4 s, user missed it).
- Identical generic message ("Something went wrong") with no recovery.
- Loading state masking failure indefinitely (never times out).
- Empty state that's literally "No data".
