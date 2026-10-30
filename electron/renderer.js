/**
 * InfiniBot Satellite - Renderer Script
 * 
 * Handles UI interactions and communication with main process.
 */

// DOM elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusDetail = document.getElementById('statusDetail');
const masterUrlInput = document.getElementById('masterUrl');
const nameInput = document.getElementById('name');
const autoStartCheckbox = document.getElementById('autoStart');
const autoRestartCheckbox = document.getElementById('autoRestart');
const logsContainer = document.getElementById('logs');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');

// State
let currentState = 'disconnected';
let cachedHostname = '';
const maxLogEntries = 500;

// Load config on startup
async function loadConfig() {
  try {
    if (!cachedHostname) {
      try { cachedHostname = (await window.platform?.getInfo?.())?.hostname || ''; } catch {}
    }
    const config = await window.api.getConfig();

    masterUrlInput.value = config.masterUrl || '';
    nameInput.value = config.name || cachedHostname || '';
    autoStartCheckbox.checked = config.autoStart !== false;
    autoRestartCheckbox.checked = config.autoRestart !== false;
    
    addLog({ message: 'Configuration loaded', type: 'info' });
  } catch (err) {
    addLog({ message: `Failed to load config: ${err.message}`, type: 'error' });
  }
}

// Save configuration
async function saveConfig() {
  const config = {
    masterUrl: masterUrlInput.value.trim(),
    name: nameInput.value.trim() || cachedHostname || 'satellite',
    autoStart: autoStartCheckbox.checked,
    autoRestart: autoRestartCheckbox.checked,
  };

  // Validate URL
  if (!config.masterUrl) {
    addLog({ message: 'Master URL is required', type: 'error' });
    masterUrlInput.focus();
    return;
  }

  if (!config.masterUrl.startsWith('ws://') && !config.masterUrl.startsWith('wss://')) {
    addLog({ message: 'URL must start with ws:// or wss://', type: 'error' });
    masterUrlInput.focus();
    return;
  }

  try {
    await window.api.saveConfig(config);
    addLog({ message: 'Configuration saved successfully', type: 'info' });
  } catch (err) {
    addLog({ message: `Failed to save config: ${err.message}`, type: 'error' });
  }
}

// Gateway controls
async function startGateway() {
  try {
    await window.api.startGateway();
  } catch (err) {
    addLog({ message: `Failed to start: ${err.message}`, type: 'error' });
  }
}

async function stopGateway() {
  try {
    await window.api.stopGateway();
  } catch (err) {
    addLog({ message: `Failed to stop: ${err.message}`, type: 'error' });
  }
}

async function restartGateway() {
  try {
    await window.api.restartGateway();
  } catch (err) {
    addLog({ message: `Failed to restart: ${err.message}`, type: 'error' });
  }
}

async function openLogs() {
  try {
    await window.api.openLogs();
  } catch (err) {
    addLog({ message: `Failed to open logs: ${err.message}`, type: 'error' });
  }
}

// Update status UI
function updateStatus(state, detail = '') {
  currentState = state;
  
  // Update status dot
  statusDot.className = 'status-dot';
  if (state === 'connected') {
    statusDot.classList.add('connected');
  } else if (state === 'connecting') {
    statusDot.classList.add('connecting');
  }

  // Update text
  const stateLabels = {
    'connected': 'Connected',
    'connecting': 'Connecting...',
    'disconnected': 'Disconnected'
  };
  statusText.textContent = stateLabels[state] || state;
  statusDetail.textContent = detail || getStatusDetail(state);

  // Update buttons
  btnStart.disabled = state !== 'disconnected';
  btnStop.disabled = state === 'disconnected';
}

function getStatusDetail(state) {
  switch (state) {
    case 'connected':
      return `Connected to ${masterUrlInput.value || 'master'}`;
    case 'connecting':
      return 'Establishing connection...';
    default:
      return 'Not connected to any master';
  }
}

// Logging
function addLog(entry) {
  const { timestamp, message, type } = entry;
  const time = timestamp || new Date().toISOString().slice(11, 19);
  
  const div = document.createElement('div');
  div.className = 'log-entry';
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = time;
  
  const msgSpan = document.createElement('span');
  msgSpan.className = `log-message ${type || 'info'}`;
  msgSpan.textContent = message;
  
  div.appendChild(timeSpan);
  div.appendChild(msgSpan);
  logsContainer.appendChild(div);

  // Limit log entries
  while (logsContainer.children.length > maxLogEntries) {
    logsContainer.removeChild(logsContainer.firstChild);
  }

  // Auto-scroll
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function clearLogs() {
  logsContainer.innerHTML = '';
  addLog({ message: 'Logs cleared', type: 'info' });
}

// Poll status periodically
async function pollStatus() {
  try {
    const status = await window.api.getStatus();
    
    if (status.state !== currentState) {
      updateStatus(status.state);
    }
  } catch (err) {
    // Ignore polling errors
  }
}

// Event listeners
window.api.onLog((entry) => {
  addLog(entry);
});

window.api.onConnectionState((state) => {
  updateStatus(state);
});

window.api.onShowConfigNeeded(() => {
  masterUrlInput.focus();
  addLog({ message: 'Please configure the master URL', type: 'warn' });
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl+S to save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveConfig();
  }
  
  // Ctrl+R to restart
  if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
    e.preventDefault();
    restartGateway();
  }
});

// Initialize
loadConfig();
setInterval(pollStatus, 2000);

// Make functions available to onclick handlers
window.saveConfig = saveConfig;
window.startGateway = startGateway;
window.stopGateway = stopGateway;
window.restartGateway = restartGateway;
window.openLogs = openLogs;
window.clearLogs = clearLogs;

// Add initial log
addLog({ message: `InfiniBot Satellite initialized on ${cachedHostname || 'unknown'}`, type: 'info' });
