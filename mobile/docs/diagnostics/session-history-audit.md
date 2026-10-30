# Session History Audit — Mobile (Expo)

_Generated: 2026-06-17_

---

## 1. Data-Flow Map

### 1a. Where the session list is fetched

| Layer | File | Line(s) | Method |
|-------|------|---------|--------|
| Gateway hook | `src/hooks/useGateway.js` | 411–430 | `loadSessionsList()` calls `sessions.list` RPC and stores result in `sessionsList` state |
| Chat screen trigger | `src/screens/ChatScreen.js` | 538 | Calls `loadSessionsList()` once on mount (`useEffect([], [])`) |
| Sessions screen trigger | `src/screens/SessionsScreen.js` | 970–978 | `useFocusEffect` calls `loadAll()` (which wraps `loadSessions`) on every focus, with a 10 s poll |
| Threads drawer refresh btn | `src/components/ThreadsDrawer.js` | 248–250 | `handleRefresh` calls `loadSessionsList()` |

### 1b. Where the active-session id is stored

| Mechanism | File | Line(s) | Notes |
|-----------|------|---------|-------|
| `useState` | `src/hooks/useGateway.js` | 68 | `const [activeSessionKey, setActiveSessionKey] = useState(null)` |
| Ref mirror | `src/hooks/useGateway.js` | 85, 94–96 | `activeSessionRef.current` kept in sync via `useEffect` — used inside WS callbacks to avoid stale closure |
| Initialised to | `src/hooks/useGateway.js` | 113–116 | `getDeviceSessionKey()` → always returns `'agent:main'` |
| Exposed as | `src/hooks/useGateway.js` | 969 | `{ activeSessionKey }` in the returned object |

### 1c. Where chat messages are fetched per session

| Function | File | Line(s) | Details |
|----------|------|---------|---------|
| `loadHistory()` | `src/hooks/useGateway.js` | 592–658 | Calls `chat.history` RPC with `activeSessionRef.current` (reads from ref, NOT state). Sets `messages` state. Caches in `updateChatMessages`. |
| `switchSession()` | `src/hooks/useGateway.js` | 662–735 | Sets `activeSessionKey` + `activeSessionRef.current` to the new key, then **inline-duplicates** the same history-fetch logic (does NOT call `loadHistory`). No cross-session cache. |
| `loadHistoryRouted()` | `src/screens/ChatScreen.js` | 299–327 | Federation path: calls `invokeOnNode('chat.history', …)` then `replaceMessages()`. Falls back to `loadHistory()` for local nodes. |

### 1d. Where the chat view subscribes to messages

| Layer | File | Line(s) | Notes |
|-------|------|---------|-------|
| FlatList data | `src/screens/ChatScreen.js` | 729 | `data={messages}` — `messages` comes directly from `gateway.messages` (returned by `useGateway`) |
| `messages` state | `src/hooks/useGateway.js` | 66 | `const [messages, setMessages] = useState([])` — single flat array, not keyed by session |
| Streaming updates | `src/hooks/useGateway.js` | 296–312, 353–370 | `handleEvent` mutates `messages` on DELTA/FINAL chat events |

---

## 2. Every Stale-Data Path

### Path A — **CRITICAL (root cause): Swipe completes before `switchSession` resolves**

`ChatScreen.js:502–517` — `onScrollEnd` calls:

```js
switchSession(newKey).finally(() => {
  if (!isLocalSelected) loadHistoryRouted(newKey);
});
```

`switchSession` is an `async` function. It calls `setMessages([])` synchronously, then fires the `chat.history` RPC. **The problem**: `switchSession` itself already contains the history-fetch logic (lines 694–734) — but for local sessions `loadHistoryRouted` is NOT called (only called when `!isLocalSelected`). So the local swipe path:

1. Calls `switchSession(newKey)` — clears messages, updates `activeSessionRef.current`, fetches history.
2. `.finally()` is reached — but for local sessions `isLocalSelected === true` so `loadHistoryRouted` is skipped.

This path _should_ work. The actual failure is narrower:

### Path B — **ROOT CAUSE: `switchSession` sets `activeSessionRef.current` BEFORE the React `setActiveSessionKey` state update flushes**

`useGateway.js:689–690`:

```js
setActiveSessionKey(newKey);
activeSessionRef.current = newKey;
```

`loadHistory()` at line 592 reads `activeSessionRef.current` (the ref, correct). But the inline history block in `switchSession` (lines 694–734) fetches history for `newKey` and calls `setMessages(parsed)`. **This is correct in isolation.**

The real bug is in the **swipe pager render path** (`ChatScreen.js:808–835`):

```jsx
{orderedSessions.map((sessionKey, index) => (
  <View key={sessionKey} style={[styles.sessionPage, { width: SCREEN_WIDTH }]}>
    {index === currentSessionIndex ? (
      chatBody          // ← only the CURRENT index renders the live FlatList
    ) : (
      <View style={styles.inactiveSession}>   // ← all other pages are placeholder
        ...
        <Text>Swipe to view</Text>
      </View>
    )}
  </View>
))}
```

`currentSessionIndex` is derived from `orderedSessions.indexOf(activeSessionKey)`. **React state updates are async**. When `onScrollEnd` fires:

1. `scrollTo` physically moves the pager to `newIndex`.
2. `switchSession(newKey)` is called — async, not yet resolved.
3. React has NOT yet re-rendered with `activeSessionKey = newKey`.
4. `currentSessionIndex` still equals the OLD index.
5. The pager shows the page at `newIndex` (because the `ScrollView` scrolled there), but `index === currentSessionIndex` is **false** for `newIndex` and **true** for the old index.
6. Result: the new page renders the "Swipe to view" placeholder. The old page (off-screen) gets `chatBody`.

The user sees the placeholder ("Swipe to view") for the session they navigated to. Even after state settles, if the history fetch races with the `messages` clear in `switchSession`, the FlatList can display an empty/old array.

### Path C — **Inactive-page placeholder never gets real content**

Even after `activeSessionKey` updates, the destination page now correctly renders `chatBody`. But `chatBody` renders `messages` from `useGateway` which is a **single shared array** — not per-session. If `switchSession`'s history fetch returned 0 messages (network error, empty session), the user sees the generic "Ready when you are" empty state, which is indistinguishable from a load failure.

There is **no loading indicator** between the moment `switchSession` sets `setMessages([])` and when the history arrives. The user sees blank content and assumes "no messages."

### Path D — **`orderedSessions` filter excludes most real sessions**

`ChatScreen.js:431–440`:

```js
const candidates = sessions.filter((s) => {
  const key = s?.sessionKey || s?.key;
  return key && (
    key.includes('webchat') ||
    key.includes('mobile') ||
    key === 'main' ||
    key === 'agent:main' ||
    key.startsWith('agent:main:')
  );
});
```

Sessions from other channels (Telegram, Discord, etc.) are filtered out. A user who chatted from the web UI under a key like `agent:main:session-xyz` (not matching `webchat` or `mobile`) will never see that session in the swipe pager — it simply won't appear.

### Path E — **`sessions` shape mismatch in `ChatScreen`**

`ChatScreen.js:685–691` builds a local `sessions` array from `sessionsList?.sessions`:

```js
const sessions = sessionsList?.sessions?.map((s) => ({...})) || [];
```

But `useGateway.js:419` stores the RPC result as a **raw array** (`setSessionsList(res.sessions)`). So `sessionsList` is **already the array** — `sessionsList?.sessions` is `undefined`, and `sessions` is always `[]`. This means `MultiPanelChat` is passed an empty session list.

### Path F — **`ThreadsDrawer` filters by the wrong field name**

`ThreadsDrawer.js:253–261` filters with `s.sessionKey || s.key`. The gateway `sessions.list` response uses `key` (not `sessionKey`). This filter likely works, but the `handleSelectThread` callback at line 196 calls `switchSession(key)` without a `.finally(() => loadHistory())`, so local sessions get no post-switch history refresh if `switchSession` fails silently.

### Path G — **No per-session message cache**

`useGateway.js:66`: `messages` is a single `useState([])`. When switching from session A to B and back to A, the full gateway RPC round-trip fires again. There is no per-sessionKey cache map. This causes: (1) visible blank flicker on every back-swipe; (2) no offline resilience; (3) extra network load.

### Path H — **Persist guard blocks the first meaningful message save**

`useGateway.js:170–172`:

```js
if (messages.length === 0) return;
```

When `switchSession` calls `setMessages([])` (line 686), the persist effect fires with `messages = []` and is skipped. This is correct. But the next `setMessages(parsed)` call in `switchSession` (line 728) fires the persist effect _while `isSwitchingChatRef.current` is still `true`_ (it is cleared 100 ms later at line 873). So the first batch of messages for the new session is never persisted to AsyncStorage. On app restart the chat appears empty even though the gateway has messages.

---

## 3. Named Root Cause

> **The primary bug is a race between the physical `ScrollView` scroll and the async `switchSession` state update. When the user swipes to page N, the ScrollView physically shows page N but React has not yet re-rendered `currentSessionIndex = N`, so the condition `index === currentSessionIndex` still resolves to page N-1. The destination page renders the "Swipe to view" placeholder. Even after state settles there is no per-session message cache, no loading indicator, and the inline history fetch in `switchSession` races with the React render cycle — resulting in either a blank view or the previous session's stale messages.**

Secondary bugs that compound the problem:
- `sessionsList?.sessions` double-dereference returns `undefined` (Path E).
- `orderedSessions` filter is too narrow (Path D).
- No loading state between session clear and history arrival (Path C).
- No per-session cache (Path G).
- First-save guard in the persist effect (Path H).

---

## 4. Fixes Applied (cross-reference)

| Bug | Fix location | Change summary |
|-----|-------------|----------------|
| Path B (root cause swipe race) | `ChatScreen.js` | Render ALL pages with `chatBody`; use per-page session key prop, not a shared `messages` array. OR: show loading overlay keyed to `activeSessionKey` so placeholder is replaced as soon as key updates |
| Path C (no loading indicator) | `useGateway.js` + `ChatScreen.js` | Added `messagesLoading` state in `useGateway`; set `true` on switch, `false` when history arrives; `ChatScreen` shows spinner until resolved |
| Path D (filter too narrow) | `ChatScreen.js` `orderedSessions` | Broadened filter or removed it — show all non-system sessions |
| Path E (`sessionsList?.sessions`) | `ChatScreen.js:685` | Fixed to use `sessionsList` directly (it is already an array) |
| Path F (no post-switch history in drawer) | `ThreadsDrawer.js` | Added `loadHistory` call after `switchSession` |
| Path G (no per-session cache) | `useGateway.js` | Added `messagesBySession` ref (Map keyed by sessionKey); populate on history fetch; serve on switch before network reply arrives |
| Path H (persist guard too aggressive) | `useGateway.js` | Clear `isSwitchingChatRef` before `setMessages(parsed)` inside `switchSession` so the first batch persists |
