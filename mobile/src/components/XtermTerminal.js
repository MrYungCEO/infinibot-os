/**
 * XtermTerminal — embeds a real xterm.js inside a WebView.
 *
 * AnsiText (the previous renderer) only handled SGR escapes and stripped
 * everything else, which mangled the TUIs claude-code / opencode / codex
 * draw with cursor positioning, alternate-screen-buffer, scroll regions, etc.
 * This component delegates the VT emulation to xterm.js for full fidelity.
 *
 * Bridge protocol:
 *   native → web:  webviewRef.injectJavaScript(`window.__termWrite(<json>)`)
 *                  also: __termClear, __termResize(cols, rows), __termTheme(t)
 *   web → native:  postMessage(JSON.stringify({ type, ... }))
 *                  types: 'ready' | 'input' | 'resize' | 'error'
 *
 * Initial buffer (scrollback) is flushed in a single write() once the page
 * signals 'ready'. Subsequent deltas are written via the imperative ref.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  XTERM_CSS,
  XTERM_FIT_JS,
  XTERM_JS,
} from '../assets/xterm-bundle.generated';
import { TERMINAL_COLORS as C, ANSI_COLORS } from '../constants/terminal-theme';
import { COLORS } from '../constants/theme';

const DEFAULT_THEME = {
  background: C.bg0,
  foreground: C.text,
  cursor: C.gold,
  cursorAccent: C.bg0,
  selectionBackground: COLORS.primaryStrong,
  black: ANSI_COLORS.black,
  red: ANSI_COLORS.red,
  green: ANSI_COLORS.green,
  yellow: ANSI_COLORS.yellow,
  blue: ANSI_COLORS.blue,
  magenta: ANSI_COLORS.magenta,
  cyan: ANSI_COLORS.cyan,
  white: ANSI_COLORS.white,
  brightBlack: ANSI_COLORS.brightBlack,
  brightRed: ANSI_COLORS.brightRed,
  brightGreen: ANSI_COLORS.brightGreen,
  brightYellow: ANSI_COLORS.brightYellow,
  brightBlue: ANSI_COLORS.brightBlue,
  brightMagenta: ANSI_COLORS.brightMagenta,
  brightCyan: ANSI_COLORS.brightCyan,
  brightWhite: ANSI_COLORS.brightWhite,
};

function buildHtml({ theme, initialCols, initialRows }) {
  const themeJson = JSON.stringify(theme);
  const initJson = JSON.stringify({ cols: initialCols, rows: initialRows });
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${XTERM_CSS}</style>
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: ${theme.background}; overflow: hidden; }
  body { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
  #term { position: absolute; inset: 0; }
  .xterm { padding: 6px; height: 100%; }
  .xterm-viewport { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; background: ${theme.background} !important; }
  .xterm .xterm-screen canvas { display: block; touch-action: none; }
</style>
</head>
<body>
<div id="term"></div>
<script>${XTERM_JS}</script>
<script>${XTERM_FIT_JS}</script>
<script>
(function () {
  function post(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch (e) {}
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  try {
    var THEME = ${themeJson};
    var INIT = ${initJson};
    var term = new window.Terminal({
      theme: THEME,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
      macOptionIsMeta: true,
      cols: INIT.cols || 80,
      rows: INIT.rows || 24,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term'));

    function safeFit() {
      try { fit.fit(); } catch (e) {}
    }

    window.__term = term;
    window.__fit = fit;
    window.__termWrite = function (data) { try { term.write(data); } catch (e) {} };
    window.__termClear = function () { try { term.clear(); } catch (e) {} };
    window.__termFit = safeFit;
    window.__termResize = function (cols, rows) {
      try { term.resize(cols, rows); } catch (e) {}
    };
    window.__termTheme = function (t) {
      try { term.options.theme = t; } catch (e) {}
    };
    window.__termFocus = function () { try { term.focus(); } catch (e) {} };

    term.onData(function (data) { post({ type: 'input', data: data }); });
    term.onResize(function (size) {
      post({ type: 'resize', cols: size.cols, rows: size.rows });
    });

    var onResize = debounce(safeFit, 50);
    window.addEventListener('resize', onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }

    setTimeout(function () {
      safeFit();
      post({ type: 'ready', cols: term.cols, rows: term.rows });
    }, 20);

    // Touch-to-scroll patch: translate finger drags into xterm scrollback so
    // scrollback works on mobile WebView regardless of pointer-event support in
    // the bundled xterm version.
    //
    // IMPORTANT: the .xterm-viewport node is recreated by xterm on every fit()/
    // resize(), so it must be re-queried per gesture — a cached reference goes
    // stale (detached) and scrollTop writes silently no-op, which left dragging
    // the scrollbar thumb as the only working scroll path. We resolve the live
    // viewport on each touchstart and, as a fallback, drive term.scrollLines()
    // (the canonical xterm API) by accumulating pixel delta into whole rows.
    (function () {
      var lastY = 0;
      var moved = false;
      var vp = null;            // live viewport for this gesture (re-resolved)
      var rowPx = 17;           // px per row; refined from the live viewport
      var accum = 0;            // sub-row pixel remainder for scrollLines path
      var TAP_SLOP = 4;         // px before a drag counts as a scroll

      document.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { vp = null; return; }
        lastY = e.touches[0].clientY;
        moved = false;
        accum = 0;
        vp = document.querySelector('.xterm-viewport');
        if (vp) {
          var rows = term.rows || 24;
          var h = vp.clientHeight || 0;
          if (h > 0 && rows > 0) rowPx = h / rows;
        }
      }, { passive: true });

      document.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 1) return;
        var y = e.touches[0].clientY;
        var delta = lastY - y;            // finger up (delta>0) => scroll down
        lastY = y;
        if (!moved && Math.abs(delta) < TAP_SLOP) return;
        moved = true;
        // Primary path: drive the live viewport's native scroll (xterm syncs
        // its render off the resulting 'scroll' event).
        if (vp && vp.isConnected) {
          vp.scrollTop += delta;
          return;
        }
        // Fallback: no live viewport node — convert pixels to rows and use the
        // public API. Negative lines scroll up (toward older output).
        accum += delta;
        var lines = (accum / rowPx) | 0;
        if (lines !== 0) {
          accum -= lines * rowPx;
          try { term.scrollLines(lines); } catch (e2) {}
        }
      }, { passive: true });
    })();
  } catch (e) {
    post({ type: 'error', message: String((e && e.message) || e) });
  }
})();
true;
</script>
</body>
</html>`;
}

export const XtermTerminal = forwardRef(function XtermTerminal(
  {
    initialBuffer = '',
    theme,
    initialCols = 80,
    initialRows = 24,
    onInput,
    onResize,
    onReady,
    style,
  },
  ref,
) {
  const webRef = useRef(null);
  const readyRef = useRef(false);
  const pendingRef = useRef([]); // chunks queued until 'ready'
  const initialBufferRef = useRef(initialBuffer);
  // Keep the latest initialBuffer in a ref so the (later) ready handler reads
  // the current value, without re-building the HTML payload on every change.
  useEffect(() => {
    initialBufferRef.current = initialBuffer;
  }, [initialBuffer]);

  const mergedTheme = useMemo(
    () => ({ ...DEFAULT_THEME, ...(theme || {}) }),
    [theme],
  );

  // The HTML is built once per mount — changing theme/cols later goes through
  // the imperative bridge, not a re-render of the WebView source.
  const html = useMemo(
    () => buildHtml({ theme: mergedTheme, initialCols, initialRows }),
    // Intentionally exclude mergedTheme/initialCols/initialRows from deps so
    // that switching themes mid-session doesn't tear down the terminal. Theme
    // updates flow through `__termTheme` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const inject = useCallback((js) => {
    if (!webRef.current) return;
    webRef.current.injectJavaScript(js + '\ntrue;');
  }, []);

  const writeImpl = useCallback(
    (data) => {
      if (data == null || data === '') return;
      if (!readyRef.current) {
        pendingRef.current.push(data);
        return;
      }
      inject(`window.__termWrite(${JSON.stringify(data)});`);
    },
    [inject],
  );

  useImperativeHandle(
    ref,
    () => ({
      write: writeImpl,
      clear: () => inject('window.__termClear && window.__termClear();'),
      resize: (cols, rows) =>
        inject(`window.__termResize && window.__termResize(${cols}, ${rows});`),
      fit: () => inject('window.__termFit && window.__termFit();'),
      focus: () => inject('window.__termFocus && window.__termFocus();'),
      setTheme: (t) =>
        inject(`window.__termTheme && window.__termTheme(${JSON.stringify(t)});`),
      isReady: () => readyRef.current,
    }),
    [inject, writeImpl],
  );

  // Push theme updates through the bridge when the prop changes post-mount.
  useEffect(() => {
    if (!readyRef.current) return;
    inject(
      `window.__termTheme && window.__termTheme(${JSON.stringify(mergedTheme)});`,
    );
  }, [mergedTheme, inject]);

  const handleMessage = useCallback(
    (event) => {
      let msg;
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready': {
          readyRef.current = true;
          const initial = initialBufferRef.current;
          if (initial) {
            inject(`window.__termWrite(${JSON.stringify(initial)});`);
          }
          while (pendingRef.current.length) {
            const chunk = pendingRef.current.shift();
            inject(`window.__termWrite(${JSON.stringify(chunk)});`);
          }
          onReady?.({ cols: msg.cols, rows: msg.rows });
          break;
        }
        case 'input':
          onInput?.(msg.data);
          break;
        case 'resize':
          onResize?.(msg.cols, msg.rows);
          break;
        case 'error':
          console.warn('[XtermTerminal] webview error:', msg.message);
          break;
        default:
          break;
      }
    },
    [inject, onInput, onResize, onReady],
  );

  return (
    <View style={[styles.container, { backgroundColor: mergedTheme.background }, style]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'about:blank' }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={true}
        nestedScrollEnabled={true}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={true}
        showsHorizontalScrollIndicator={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        androidLayerType="hardware"
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        textZoom={100}
        style={[styles.web, { backgroundColor: mergedTheme.background }]}
        // Don't escalate JS errors — the bridge already postMessages them.
        onError={(e) => console.warn('[XtermTerminal] webview error', e?.nativeEvent)}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: 'transparent' },
});

export default XtermTerminal;
