/**
 * DocumentFrame — renders a report's rendered asset inside the app.
 *
 *   kind="pdf"   base64 PDF bytes painted page-by-page by PDF.js (works on the
 *                iOS WKWebView AND Android System WebView, which has no PDF
 *                engine — an <embed> data URI shows blank there).
 *   kind="html"  a self-contained HTML report (some research reports are
 *                interactive HTML, not PDF) rendered as-is.
 *
 * Native uses react-native-webview; the web export (which has no WebView)
 * uses a sandboxed <iframe srcDoc> with the same viewer page.
 */
import React, { useMemo } from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

// PDF.js pinned to a release that renders cleanly in WKWebView + Android WebView.
const PDFJS_VER = '3.11.174';

export const PDF_VIEWER_HTML = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=4.0">
<style>
  html,body{margin:0;padding:0;background:#050505}
  #pages{display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px}
  canvas{width:100%;max-width:900px;height:auto;background:#fff;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,.5)}
  #msg{color:#cfc6b0;font-family:-apple-system,system-ui,sans-serif;font-size:14px;padding:28px;text-align:center;line-height:1.5}
  #err{display:none;color:#fca5a5;font-family:-apple-system,system-ui,sans-serif;font-size:14px;padding:28px;text-align:center;line-height:1.5}
</style></head>
<body>
<div id="msg">Rendering PDF…</div>
<div id="pages"></div>
<div id="err"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.js"></script>
<script>
(function(){
  function post(o){ try{ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  function fail(m){ document.getElementById('msg').style.display='none'; var e=document.getElementById('err'); e.style.display='block'; e.textContent=m; post({type:'pdf-error',message:m}); }
  try{
    if(!window.pdfjsLib){ return fail('PDF viewer could not load. Check your network connection and try again.'); }
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js';
    var b64 = window.__PDF_BASE64__ || '';
    if(!b64){ return fail('No PDF data was provided.'); }
    var raw = atob(b64); var bytes = new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++){ bytes[i]=raw.charCodeAt(i); }
    pdfjsLib.getDocument({data:bytes}).promise.then(function(pdf){
      document.getElementById('msg').style.display='none';
      var host=document.getElementById('pages'); var scale=2; var seq=Promise.resolve();
      var _loop=function(p){ seq=seq.then(function(){ return pdf.getPage(p).then(function(page){
        var vp=page.getViewport({scale:scale});
        var canvas=document.createElement('canvas');
        canvas.width=vp.width; canvas.height=vp.height; host.appendChild(canvas);
        return page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
      }); }); };
      for(var p=1;p<=pdf.numPages;p++){ _loop(p); }
      seq.then(function(){ post({type:'pdf-ready',pages:pdf.numPages}); })
         .catch(function(e){ fail('Could not render this PDF: '+(e&&e.message||e)); });
    }).catch(function(e){ fail('Could not open this PDF: '+(e&&e.message||e)); });
  }catch(e){ fail('Viewer error: '+(e&&e.message||e)); }
})();
</script></body></html>`;

/** Decode base64 → UTF-8 string (HTML reports arrive base64 from reports.preview). */
export function decodeBase64Utf8(b64) {
  try {
    const bin = globalThis.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    // Fallback: percent-decode
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += '%' + bytes[i].toString(16).padStart(2, '0');
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

export function DocumentFrame({ kind = 'pdf', base64, onMessage, style }) {
  const html = useMemo(() => {
    if (!base64) return '';
    if (kind === 'html') return decodeBase64Utf8(base64);
    return PDF_VIEWER_HTML;
  }, [kind, base64]);

  if (!base64) return null;

  if (Platform.OS === 'web') {
    // Inline the bytes ahead of the viewer scripts (no injectedJavaScript on web).
    const srcDoc =
      kind === 'html'
        ? html
        : html.replace('<body>', `<body><script>window.__PDF_BASE64__=${JSON.stringify(base64)};</script>`);
    return (
      <View style={[styles.fill, style]}>
        {React.createElement('iframe', {
          srcDoc,
          title: 'Report document',
          // HTML reports are third-party-ish content → script-only sandbox.
          // The PDF viewer is our own page and needs a real origin so PDF.js
          // can spin up its (CDN, blob-wrapped) worker.
          ...(kind === 'html' ? { sandbox: 'allow-scripts' } : {}),
          style: { border: 0, width: '100%', height: '100%', background: '#050505' },
        })}
      </View>
    );
  }

  return (
    <View style={[styles.fill, style]}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        injectedJavaScriptBeforeContentLoaded={
          kind === 'pdf' ? `window.__PDF_BASE64__=${JSON.stringify(base64)};true;` : 'true;'
        }
        onMessage={(e) => {
          try {
            onMessage?.(JSON.parse(e.nativeEvent.data));
          } catch {
            /* non-JSON message */
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
