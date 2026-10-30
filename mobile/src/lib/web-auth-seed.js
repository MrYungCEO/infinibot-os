// web-auth-seed.js — seed the served control UI with the app's gateway
// credential so an embedded page boots signed in (no password / profile gate).
// Pure: shared by WebSurface and the embedded Knowledge Graph.

// ws://host:port  ->  http://host:port   (wss -> https). Anything else is
// returned untouched so a mis-entered http URL still works.
export function wsToHttp(url) {
  if (!url) return '';
  if (url.startsWith('wss://')) return 'https://' + url.slice(6);
  if (url.startsWith('ws://')) return 'http://' + url.slice(5);
  return url;
}

// The credential/profile-gate seed. Runs before the page's own scripts so the
// control UI finds a populated settings blob on first read and never paints a
// gate. `token`/`password` may be empty — on a trusted-LAN gateway the UI (like
// the mobile WS client) is issued a device token tokenlessly, so an empty
// password still connects.
//
// `authMode` (self-hosted profiles) says which field the secret belongs in.
// Seeding a password as `token` too makes the web client try a bad token
// first, which the gateway counts against its auth rate limit.
export function buildBeforeContentJS(wsUrl, token, authMode) {
  const settings = {
    password: authMode === 'token' ? '' : token || '',
    gatewayUrl: wsUrl || '',
    token: authMode === 'password' ? '' : token || '',
  };
  const json = JSON.stringify(settings);
  return `(function(){try{
    localStorage.setItem('infinibot.control.settings.v1', ${JSON.stringify(json)});
    localStorage.setItem('infinibot.profiles.gateEnabled.v1','0');
  }catch(e){}})();
  true;`;
}

