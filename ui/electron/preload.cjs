/**
 * InfiniBot Electron Preload Script
 * Exposes safe APIs to the renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getGatewayInfo: () => ipcRenderer.invoke('get-gateway-info'),
  
  // Notifications
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  
  // Platform info
  platform: process.platform,
  isElectron: true,
  
  // Window controls (if using frameless window)
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  
  // Multi-window
  createNewWindow: () => ipcRenderer.invoke('create-new-window'),
  getWindowCount: () => ipcRenderer.invoke('get-window-count'),
});

// Inject password and auto-authenticate when DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.add('is-electron');
  document.body.dataset.platform = process.platform;
  
  // Get gateway info including password
  try {
    const gatewayInfo = await ipcRenderer.invoke('get-gateway-info');
    console.log('[Preload] Gateway info:', gatewayInfo.url);
    
    // Store password in sessionStorage for the UI to use
    if (gatewayInfo.password) {
      sessionStorage.setItem('infinibot-electron-password', gatewayInfo.password);
      console.log('[Preload] Gateway password injected for auto-auth');
    }
    
    // Also expose via global for immediate access
    window.__INFINIBOT_GATEWAY_PASSWORD__ = gatewayInfo.password;
    window.__INFINIBOT_GATEWAY_URL__ = gatewayInfo.url;
    
    // STT server URL (dedicated speech-to-text server)
    window.__INFINIBOT_STT_URL__ = gatewayInfo.sttUrl || 'http://localhost:8765/api/stt';
    
    // Override the gateway URL in localStorage settings (correct key: infinibot.control.settings.v1)
    try {
      const SETTINGS_KEY = 'infinibot.control.settings.v1';
      const settingsRaw = localStorage.getItem(SETTINGS_KEY);
      const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
      
      // ALWAYS force-update the gateway URL for Electron (fixes wss:// -> ws:// migration)
      console.log('[Preload] Force-setting gateway URL to', gatewayInfo.url, '(was:', settings.gatewayUrl || '(empty)', ')');
      settings.gatewayUrl = gatewayInfo.url;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('[Preload] Could not update settings:', e);
    }
    
  } catch (e) {
    console.error('[Preload] Failed to get gateway info:', e);
  }
});

console.log('[Preload] InfiniBot Electron preload initialized');
