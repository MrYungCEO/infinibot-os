import { registerRootComponent } from 'expo';

import App from './App';

// Voice runs on Robovoice only, inside the web Voice page (authed WebView), so
// the app no longer installs LiveKit/WebRTC globals for a native call.

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
