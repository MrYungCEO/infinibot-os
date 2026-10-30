/**
 * Terminal-Style Clock with Alarms & Timers
 * Sleek expandable controls for the topbar
 */

import { html, nothing } from "lit";
import { icons } from "../icons";
import { ensureClockStyles } from "./terminal-clock.styles";

// ============================================================
// Types
// ============================================================

export interface Alarm {
  id: string;
  time: string; // HH:MM format
  label: string;
  enabled: boolean;
  days: number[]; // 0-6, Sunday = 0
  sound: string;
}

export interface Timer {
  id: string;
  label: string;
  durationMs: number;
  remainingMs: number;
  running: boolean;
  startedAt: number | null;
}

export interface ClockState {
  expanded: boolean;
  activeTab: 'clock' | 'alarms' | 'timers';
  alarms: Alarm[];
  timers: Timer[];
  newAlarmTime: string;
  newAlarmLabel: string;
  newTimerMinutes: string;
  newTimerLabel: string;
  use24Hour: boolean;
  showSeconds: boolean;
}

// ============================================================
// Storage
// ============================================================

const STORAGE_KEY = 'infinibot-terminal-clock';

export function loadClockState(): ClockState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        ...getDefaultState(),
        ...parsed,
        expanded: false, // Always start collapsed
      };
    }
  } catch (e) {
    console.error('[TerminalClock] Failed to load state:', e);
  }
  return getDefaultState();
}

export function saveClockState(state: ClockState): void {
  try {
    const toStore = {
      alarms: state.alarms,
      timers: state.timers,
      use24Hour: state.use24Hour,
      showSeconds: state.showSeconds,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.error('[TerminalClock] Failed to save state:', e);
  }
}

function getDefaultState(): ClockState {
  return {
    expanded: false,
    activeTab: 'clock',
    alarms: [],
    timers: [],
    newAlarmTime: '',
    newAlarmLabel: '',
    newTimerMinutes: '5',
    newTimerLabel: '',
    use24Hour: true,
    showSeconds: true,
  };
}

// ============================================================
// Time Formatting
// ============================================================

export function formatTime(date: Date, use24Hour: boolean, showSeconds: boolean): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  
  let h = hours;
  let suffix = '';
  
  if (!use24Hour) {
    suffix = hours >= 12 ? ' PM' : ' AM';
    h = hours % 12 || 12;
  }
  
  const hStr = use24Hour ? h.toString().padStart(2, '0') : h.toString();
  const mStr = minutes.toString().padStart(2, '0');
  const sStr = seconds.toString().padStart(2, '0');
  
  if (showSeconds) {
    return `${hStr}:${mStr}:${sStr}${suffix}`;
  }
  return `${hStr}:${mStr}${suffix}`;
}

export function formatTimerDisplay(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// ============================================================
// Alarm Firing & Notifications
// ============================================================

// Track which alarms have fired today to prevent repeated firing
const firedAlarmsToday = new Set<string>();

// Reset fired alarms at midnight
let lastResetDay = new Date().getDate();

function resetFiredAlarmsIfNewDay(): void {
  const today = new Date().getDate();
  if (today !== lastResetDay) {
    firedAlarmsToday.clear();
    lastResetDay = today;
  }
}

// Looping alarm sound state
let alarmAudioContext: AudioContext | null = null;
let alarmLoopInterval: ReturnType<typeof setInterval> | null = null;

// Play loud looping alarm sound until stopped
function playAlarmSound(): void {
  try {
    if (!alarmAudioContext) {
      alarmAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    // Clear any existing loop
    if (alarmLoopInterval) {
      clearInterval(alarmLoopInterval);
    }
    
    let toggle = false;
    alarmLoopInterval = setInterval(() => {
      if (!alarmAudioContext) return;
      
      const osc = alarmAudioContext.createOscillator();
      const gain = alarmAudioContext.createGain();
      
      osc.connect(gain);
      gain.connect(alarmAudioContext.destination);
      
      // Loud alternating siren
      osc.frequency.value = toggle ? 880 : 1100;
      osc.type = 'square';
      toggle = !toggle;
      
      gain.gain.setValueAtTime(0.5, alarmAudioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, alarmAudioContext.currentTime + 0.25);
      
      osc.start();
      osc.stop(alarmAudioContext.currentTime + 0.25);
    }, 300);
    
  } catch (e) {
    console.error('[TerminalClock] Failed to play alarm sound:', e);
  }
}

// Stop the looping alarm sound
export function stopAlarmSound(): void {
  if (alarmLoopInterval) {
    clearInterval(alarmLoopInterval);
    alarmLoopInterval = null;
  }
}

// Check if alarm is currently sounding
export function isAlarmSounding(): boolean {
  return alarmLoopInterval !== null;
}

// Global stop function
(window as any).stopInfiniBotAlarm = stopAlarmSound;

// Show browser notification
async function showBrowserNotification(alarm: Alarm): Promise<void> {
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      
      if (Notification.permission === 'granted') {
        new Notification(`⏰ Alarm: ${alarm.label}`, {
          body: `It's ${alarm.time}`,
          icon: '/infinibot-logo.png',
          tag: alarm.id,
          requireInteraction: true,
        });
      }
    }
  } catch (e) {
    console.error('[TerminalClock] Failed to show notification:', e);
  }
}

// Resolve the Telegram chat the clock should notify. The gateway's `send`
// RPC needs an explicit `to`; the clock has no per-alarm recipient, so it
// uses the operator's configured Telegram default chat.
async function resolveTelegramTarget(gatewayClient: any): Promise<string | null> {
  try {
    const snapshot = await gatewayClient.request('config.get', {});
    const accounts = snapshot?.config?.channels?.telegram?.accounts ?? {};
    for (const account of Object.values(accounts) as any[]) {
      const chatId = account?.defaultChatId;
      if (typeof chatId === 'string' && chatId.trim()) return chatId.trim();
    }
  } catch {
    // fall through — caller reports "not configured"
  }
  return null;
}

// Send alarm notification to Telegram via gateway
async function sendAlarmToTelegram(alarm: Alarm, gatewayClient: any): Promise<void> {
  if (!gatewayClient) return;
  
  try {
    const to = await resolveTelegramTarget(gatewayClient);
    if (!to) {
      console.warn('[TerminalClock] No Telegram default chat configured — skipping alarm send');
      return;
    }
    // Served method is `send` — `message.send` is the MCP tool name and was
    // never an RPC. `to` and `idempotencyKey` are required.
    await gatewayClient.request('send', {
      channel: 'telegram',
      to,
      message: `⏰ **ALARM: ${alarm.label}**\n\nTime: ${alarm.time}\n\n_Sent from Infinibot Terminal Clock_`,
      idempotencyKey: `clock-alarm:${alarm.id}:${alarm.time}`,
    });
    console.log('[TerminalClock] Alarm sent to Telegram:', alarm.label);
  } catch (e) {
    console.error('[TerminalClock] Failed to send alarm to Telegram:', e);
  }
}

// Show in-app alarm notification
function showInAppNotification(alarm: Alarm, onNotify?: (alarm: Alarm) => void): void {
  // Call the callback if provided
  if (onNotify) {
    onNotify(alarm);
  }
  
  // Also dispatch a custom event that the app can listen to
  window.dispatchEvent(new CustomEvent('terminal-clock-alarm', {
    detail: { alarm, time: new Date().toLocaleTimeString() }
  }));
}

// Check if any alarms should fire
export function checkAlarms(
  state: ClockState,
  gatewayClient?: any,
  onAlarmFired?: (alarm: Alarm) => void
): Alarm[] {
  resetFiredAlarmsIfNewDay();
  
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const currentDay = now.getDay();
  
  const firedAlarms: Alarm[] = [];
  
  for (const alarm of state.alarms) {
    if (!alarm.enabled) continue;
    if (!alarm.days.includes(currentDay)) continue;
    if (alarm.time !== currentTime) continue;
    
    // Create unique key for this alarm + today
    const firedKey = `${alarm.id}-${now.toDateString()}`;
    if (firedAlarmsToday.has(firedKey)) continue;
    
    // Mark as fired
    firedAlarmsToday.add(firedKey);
    firedAlarms.push(alarm);
    
    console.log('[TerminalClock] 🔔 ALARM FIRING:', alarm.label, 'at', alarm.time);
    
    // Play sound
    playAlarmSound();
    
    // Show browser notification
    showBrowserNotification(alarm);
    
    // Show in-app notification
    showInAppNotification(alarm, onAlarmFired);
    
    // Send to Telegram
    sendAlarmToTelegram(alarm, gatewayClient);
  }
  
  return firedAlarms;
}

// ============================================================
// Alarm Operations
// ============================================================

export function createAlarm(state: ClockState): ClockState {
  if (!state.newAlarmTime) return state;
  
  const newAlarm: Alarm = {
    id: `alarm-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    time: state.newAlarmTime,
    label: state.newAlarmLabel || 'Alarm',
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6], // All days by default
    sound: 'default',
  };
  
  const newState = {
    ...state,
    alarms: [...state.alarms, newAlarm],
    newAlarmTime: '',
    newAlarmLabel: '',
  };
  
  saveClockState(newState);
  return newState;
}

export function toggleAlarm(state: ClockState, alarmId: string): ClockState {
  const newState = {
    ...state,
    alarms: state.alarms.map(a =>
      a.id === alarmId ? { ...a, enabled: !a.enabled } : a
    ),
  };
  saveClockState(newState);
  return newState;
}

export function deleteAlarm(state: ClockState, alarmId: string): ClockState {
  const newState = {
    ...state,
    alarms: state.alarms.filter(a => a.id !== alarmId),
  };
  saveClockState(newState);
  return newState;
}

// ============================================================
// Timer Operations
// ============================================================

export function createTimer(state: ClockState): ClockState {
  const minutes = parseInt(state.newTimerMinutes, 10);
  if (isNaN(minutes) || minutes <= 0) return state;
  
  const durationMs = minutes * 60 * 1000;
  
  const newTimer: Timer = {
    id: `timer-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    label: state.newTimerLabel || `${minutes}min Timer`,
    durationMs,
    remainingMs: durationMs,
    running: false,
    startedAt: null,
  };
  
  const newState = {
    ...state,
    timers: [...state.timers, newTimer],
    newTimerMinutes: '5',
    newTimerLabel: '',
  };
  
  saveClockState(newState);
  return newState;
}

export function startTimer(state: ClockState, timerId: string): ClockState {
  const newState = {
    ...state,
    timers: state.timers.map(t =>
      t.id === timerId ? { ...t, running: true, startedAt: Date.now() } : t
    ),
  };
  saveClockState(newState);
  return newState;
}

export function pauseTimer(state: ClockState, timerId: string): ClockState {
  const timer = state.timers.find(t => t.id === timerId);
  if (!timer || !timer.running) return state;
  
  const elapsed = timer.startedAt ? Date.now() - timer.startedAt : 0;
  const remaining = Math.max(0, timer.remainingMs - elapsed);
  
  const newState = {
    ...state,
    timers: state.timers.map(t =>
      t.id === timerId ? { ...t, running: false, startedAt: null, remainingMs: remaining } : t
    ),
  };
  saveClockState(newState);
  return newState;
}

export function resetTimer(state: ClockState, timerId: string): ClockState {
  const newState = {
    ...state,
    timers: state.timers.map(t =>
      t.id === timerId ? { ...t, running: false, startedAt: null, remainingMs: t.durationMs } : t
    ),
  };
  saveClockState(newState);
  return newState;
}

export function deleteTimer(state: ClockState, timerId: string): ClockState {
  const newState = {
    ...state,
    timers: state.timers.filter(t => t.id !== timerId),
  };
  saveClockState(newState);
  return newState;
}

// Play timer complete sound
function playTimerCompleteSound(): void {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    const playTone = (freq: number, startTime: number, duration: number) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.value = freq;
      oscillator.type = 'sine';
      
      gainNode.gain.setValueAtTime(0.25, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };
    
    // Play completion melody
    const now = audioContext.currentTime;
    playTone(523, now, 0.15);        // C
    playTone(659, now + 0.15, 0.15); // E
    playTone(784, now + 0.3, 0.15);  // G
    playTone(1047, now + 0.45, 0.4); // High C
  } catch (e) {
    console.error('[TerminalClock] Failed to play timer sound:', e);
  }
}

// Show timer complete browser notification
async function showTimerNotification(timer: Timer): Promise<void> {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`⏱️ Timer Complete: ${timer.label}`, {
        body: `Your timer has finished!`,
        icon: '/infinibot-logo.png',
        tag: timer.id,
        requireInteraction: true,
      });
    }
  } catch (e) {
    console.error('[TerminalClock] Failed to show timer notification:', e);
  }
}

// Send timer complete notification to Telegram
async function sendTimerToTelegram(timer: Timer, gatewayClient: any): Promise<void> {
  if (!gatewayClient) return;
  
  try {
    const to = await resolveTelegramTarget(gatewayClient);
    if (!to) {
      console.warn('[TerminalClock] No Telegram default chat configured — skipping timer send');
      return;
    }
    // Served method is `send` — `message.send` is the MCP tool name and was
    // never an RPC. `to` and `idempotencyKey` are required.
    await gatewayClient.request('send', {
      channel: 'telegram',
      to,
      message: `⏱️ **TIMER COMPLETE: ${timer.label}**\n\nYour timer has finished!\n\n_Sent from Infinibot Terminal Clock_`,
      idempotencyKey: `clock-timer:${timer.id}:${timer.durationMs}`,
    });
    console.log('[TerminalClock] Timer notification sent to Telegram:', timer.label);
  } catch (e) {
    console.error('[TerminalClock] Failed to send timer to Telegram:', e);
  }
}

export function updateTimerRemaining(
  state: ClockState,
  gatewayClient?: any,
  onTimerComplete?: (timer: Timer) => void
): ClockState {
  const now = Date.now();
  let changed = false;
  const completedTimers: Timer[] = [];
  
  const updatedTimers = state.timers.map(t => {
    if (t.running && t.startedAt) {
      const elapsed = now - t.startedAt;
      const remaining = Math.max(0, t.remainingMs - elapsed);
      
      if (remaining !== t.remainingMs) {
        changed = true;
        
        // Timer completed
        if (remaining === 0 && t.remainingMs > 0) {
          completedTimers.push(t);
          return { ...t, running: false, startedAt: null, remainingMs: 0 };
        }
        
        return { ...t, remainingMs: remaining, startedAt: now };
      }
    }
    return t;
  });
  
  // Handle completed timers
  for (const timer of completedTimers) {
    console.log('[TerminalClock] ⏱️ TIMER COMPLETE:', timer.label);
    
    // Play sound
    playTimerCompleteSound();
    
    // Show browser notification
    showTimerNotification(timer);
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('terminal-clock-timer', {
      detail: { timer, completedAt: new Date().toLocaleTimeString() }
    }));
    
    // Call callback
    if (onTimerComplete) {
      onTimerComplete(timer);
    }
    
    // Send to Telegram
    sendTimerToTelegram(timer, gatewayClient);
  }
  
  if (changed) {
    return { ...state, timers: updatedTimers };
  }
  return state;
}

// ============================================================
// Render Functions
// ============================================================

export interface ClockProps {
  state: ClockState;
  currentTime: Date;
  onStateChange: (state: ClockState) => void;
  /**
   * Extra content for the Clock tab (plugin clock sections — see
   * clock-sections.ts). Called only while the panel is open.
   */
  renderSections?: () => unknown;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Clock digits split for the pill: hours, minutes and the 12h suffix. */
export function clockDigits(date: Date, use24Hour: boolean): { hh: string; mm: string; ss: string; suffix: string } {
  const h = date.getHours();
  return {
    hh: use24Hour ? pad2(h) : String(h % 12 || 12),
    mm: pad2(date.getMinutes()),
    ss: pad2(date.getSeconds()),
    suffix: use24Hour ? '' : h >= 12 ? 'PM' : 'AM',
  };
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "UTC+7" / "UTC-3:30" for the viewer's zone at `date`. */
function utcOffsetLabel(date: Date): string {
  const off = -date.getTimezoneOffset();
  const a = Math.abs(off);
  return `UTC${off < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${pad2(a % 60)}` : ''}`;
}

const WORLD_CLOCKS: Array<{ code: string; label: string; tz: string }> = [
  { code: 'UTC', label: 'UTC', tz: 'UTC' },
  { code: 'NYC', label: 'New York', tz: 'America/New_York' },
  { code: 'LON', label: 'London', tz: 'Europe/London' },
  { code: 'TYO', label: 'Tokyo', tz: 'Asia/Tokyo' },
];

function worldClock(date: Date, tz: string, use24Hour: boolean): { time: string; dayDelta: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', year: 'numeric', month: 'numeric', day: 'numeric',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  const there = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const here = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const h = Number(p.hour) % 24;
  const time = use24Hour ? `${pad2(h)}:${p.minute}` : `${h % 12 || 12}:${p.minute} ${h >= 12 ? 'PM' : 'AM'}`;
  return { time, dayDelta: Math.round((there - here) / 86_400_000) };
}

function renderClockDisplay(props: ClockProps) {
  const now = props.currentTime;
  const d = clockDigits(now, props.state.use24Hour);
  const tz = localTimeZone();
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return html`
    <div class="ibc-hero">
      <div class="ibc-hero__time" aria-hidden="true">
        <span>${d.hh}</span><span class="ibc-hero__colon">:</span><span>${d.mm}</span>${props.state.showSeconds
          ? html`<span class="ibc-hero__sec">${d.ss}</span>`
          : nothing}${d.suffix ? html`<span class="ibc-hero__suffix">${d.suffix}</span>` : nothing}
      </div>
      <div class="ibc-hero__date">${dateStr}</div>
      <div class="ibc-hero__tz"><span>${tz}</span><span class="ibc-dot-sep" aria-hidden="true"></span><span>${utcOffsetLabel(now)}</span></div>
    </div>
    <ul class="ibc-world" aria-label="World clocks">
      ${WORLD_CLOCKS.map((w) => {
        const t = worldClock(now, w.tz, props.state.use24Hour);
        return html`<li class="ibc-world__item" title=${`${w.label} (${w.tz})`}>
          <span class="ibc-world__code">${w.code}</span>
          <span class="ibc-world__time">${t.time}${t.dayDelta ? html`<sup>${t.dayDelta > 0 ? '+1' : '-1'}</sup>` : nothing}</span>
        </li>`;
      })}
    </ul>
    <div class="tc-settings ibc-settings">
      <label class="ibc-chip">
        <input
          type="checkbox"
          .checked=${props.state.use24Hour}
          @change=${() => {
            const newState = { ...props.state, use24Hour: !props.state.use24Hour };
            saveClockState(newState);
            props.onStateChange(newState);
          }}
        />
        <span>24-hour</span>
      </label>
      <label class="ibc-chip">
        <input
          type="checkbox"
          .checked=${props.state.showSeconds}
          @change=${() => {
            const newState = { ...props.state, showSeconds: !props.state.showSeconds };
            saveClockState(newState);
            props.onStateChange(newState);
          }}
        />
        <span>Seconds</span>
      </label>
    </div>
    ${props.renderSections ? props.renderSections() : nothing}
  `;
}

function renderAlarmsTab(props: ClockProps) {
  return html`
    <div class="tc-alarms">
      <div class="tc-add-form">
        <input 
          type="time" 
          class="tc-input"
          .value=${props.state.newAlarmTime}
          @input=${(e: InputEvent) => {
            props.onStateChange({ ...props.state, newAlarmTime: (e.target as HTMLInputElement).value });
          }}
        />
        <input 
          type="text" 
          class="tc-input tc-input--text"
          placeholder="Label..."
          .value=${props.state.newAlarmLabel}
          @input=${(e: InputEvent) => {
            props.onStateChange({ ...props.state, newAlarmLabel: (e.target as HTMLInputElement).value });
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              props.onStateChange(createAlarm(props.state));
            }
          }}
        />
        <button 
          class="tc-btn tc-btn--add"
          @click=${() => props.onStateChange(createAlarm(props.state))}
          ?disabled=${!props.state.newAlarmTime}
        >+</button>
      </div>
      
      ${props.state.alarms.length === 0 ? html`
        <div class="tc-empty">No alarms set</div>
      ` : props.state.alarms.map(alarm => html`
        <div class="tc-alarm-item ${alarm.enabled ? '' : 'tc-alarm-item--disabled'}">
          <div class="tc-alarm-time">${alarm.time}</div>
          <div class="tc-alarm-label">${alarm.label}</div>
          <div class="tc-alarm-actions">
            <button 
              class="tc-btn tc-btn--toggle ${alarm.enabled ? 'active' : ''}"
              @click=${() => props.onStateChange(toggleAlarm(props.state, alarm.id))}
              title="${alarm.enabled ? 'Disable' : 'Enable'}"
            >${alarm.enabled ? '●' : '○'}</button>
            <button 
              class="tc-btn tc-btn--delete"
              @click=${() => props.onStateChange(deleteAlarm(props.state, alarm.id))}
              title="Delete"
            >×</button>
          </div>
        </div>
      `)}
    </div>
  `;
}

function renderTimersTab(props: ClockProps) {
  return html`
    <div class="tc-timers">
      <div class="tc-add-form">
        <div class="tc-input-group">
          <input 
            type="number" 
            class="tc-input tc-input--number"
            min="1"
            max="999"
            placeholder="5"
            .value=${props.state.newTimerMinutes}
            @input=${(e: InputEvent) => {
              props.onStateChange({ ...props.state, newTimerMinutes: (e.target as HTMLInputElement).value });
            }}
          />
          <span class="tc-input-suffix">min</span>
        </div>
        <input 
          type="text" 
          class="tc-input tc-input--text"
          placeholder="Label..."
          .value=${props.state.newTimerLabel}
          @input=${(e: InputEvent) => {
            props.onStateChange({ ...props.state, newTimerLabel: (e.target as HTMLInputElement).value });
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              props.onStateChange(createTimer(props.state));
            }
          }}
        />
        <button 
          class="tc-btn tc-btn--add"
          @click=${() => props.onStateChange(createTimer(props.state))}
        >+</button>
      </div>
      
      <div class="tc-quick-timers">
        ${[1, 5, 10, 15, 25, 30].map(min => html`
          <button 
            class="tc-quick-btn"
            @click=${() => {
              const newState = { ...props.state, newTimerMinutes: min.toString() };
              props.onStateChange(createTimer(newState));
            }}
          >${min}m</button>
        `)}
      </div>
      
      ${props.state.timers.length === 0 ? html`
        <div class="tc-empty">No active timers</div>
      ` : props.state.timers.map(timer => {
        const remaining = timer.running && timer.startedAt 
          ? Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt))
          : timer.remainingMs;
        const progress = 1 - (remaining / timer.durationMs);
        const isComplete = remaining === 0;
        
        return html`
          <div class="tc-timer-item ${isComplete ? 'tc-timer-item--complete' : ''} ${timer.running ? 'tc-timer-item--running' : ''}">
            <div class="tc-timer-progress" style="--progress: ${progress * 100}%"></div>
            <div class="tc-timer-content">
              <div class="tc-timer-display">${formatTimerDisplay(remaining)}</div>
              <div class="tc-timer-label">${timer.label}</div>
            </div>
            <div class="tc-timer-actions">
              ${timer.running ? html`
                <button 
                  class="tc-btn tc-btn--pause"
                  @click=${() => props.onStateChange(pauseTimer(props.state, timer.id))}
                  title="Pause"
                >⏸</button>
              ` : html`
                <button 
                  class="tc-btn tc-btn--play"
                  @click=${() => props.onStateChange(startTimer(props.state, timer.id))}
                  title="Start"
                  ?disabled=${isComplete}
                >▶</button>
              `}
              <button 
                class="tc-btn tc-btn--reset"
                @click=${() => props.onStateChange(resetTimer(props.state, timer.id))}
                title="Reset"
              >↺</button>
              <button 
                class="tc-btn tc-btn--delete"
                @click=${() => props.onStateChange(deleteTimer(props.state, timer.id))}
                title="Delete"
              >×</button>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

// ── open/close wiring: Esc + outside click, attached only while open ──────
let latestProps: ClockProps | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let outsideHandler: ((e: Event) => void) | null = null;

function detachClockListeners(): void {
  if (escHandler) document.removeEventListener('keydown', escHandler, true);
  if (outsideHandler) document.removeEventListener('pointerdown', outsideHandler, true);
  escHandler = null;
  outsideHandler = null;
}

function closePanel(focusTrigger: boolean): void {
  detachClockListeners();
  const p = latestProps;
  if (!p || !p.state.expanded) return;
  p.onStateChange({ ...p.state, expanded: false });
  if (focusTrigger) document.querySelector<HTMLElement>('.ibc-pill')?.focus();
}

function syncClockListeners(expanded: boolean): void {
  if (!expanded) {
    detachClockListeners();
    return;
  }
  if (escHandler) return;
  escHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Leave Escape alone while another dialog/menu or a text field owns focus.
    const active = document.activeElement as HTMLElement | null;
    if (active && !active.closest?.('.terminal-clock')) {
      if (active.closest?.('[role="dialog"], [role="menu"], dialog')) return;
      if (active.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    }
    e.stopPropagation();
    closePanel(true);
  };
  outsideHandler = (e: Event) => {
    const path = e.composedPath?.() ?? [];
    if (!path.some((n) => n instanceof HTMLElement && n.classList.contains('terminal-clock'))) closePanel(false);
  };
  document.addEventListener('keydown', escHandler, true);
  document.addEventListener('pointerdown', outsideHandler, true);
}

export function renderTerminalClock(props: ClockProps, alarmSounding?: boolean) {
  ensureClockStyles();
  latestProps = props;
  const now = props.currentTime;
  const d = clockDigits(now, props.state.use24Hour);
  const hasActiveTimers = props.state.timers.some(t => t.running);
  const enabledAlarms = props.state.alarms.filter(a => a.enabled).length;
  const weekday = now.toLocaleDateString(undefined, { weekday: 'short' });
  const date = now.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const longDate = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const sec = now.getSeconds();
  const expanded = props.state.expanded && !alarmSounding;
  syncClockListeners(expanded);

  // If alarm is sounding, show prominent STOP button
  if (alarmSounding) {
    return html`
      <div class="terminal-clock terminal-clock--alarm-active">
        <button
          class="ibc-stop"
          @click=${() => {
            stopAlarmSound();
            props.onStateChange({ ...props.state }); // trigger re-render
          }}
          title="Stop alarm"
        >
          ${icons.alert} STOP ALARM
        </button>
      </div>
    `;
  }

  return html`
    <div class="terminal-clock ibc ${expanded ? 'terminal-clock--expanded' : ''}">
      <button
        type="button"
        class="ibc-pill"
        aria-haspopup="dialog"
        aria-expanded=${expanded ? 'true' : 'false'}
        aria-label=${`${d.hh}:${d.mm}${d.suffix ? ` ${d.suffix}` : ''}, ${longDate}. Open clock, alarms and timers`}
        title="Clock, alarms & timers"
        @click=${() => props.onStateChange({ ...props.state, expanded: !props.state.expanded })}
      >
        <span class="ibc-pill__time" aria-hidden="true"
          ><span class="ibc-pill__hh">${d.hh}</span><span class="ibc-pill__colon">:</span><span class="ibc-pill__mm">${d.mm}</span>${d.suffix
            ? html`<span class="ibc-pill__suffix">${d.suffix}</span>`
            : nothing}</span
        >
        <span class="ibc-pill__meta" aria-hidden="true">
          <span class="ibc-pill__wd">${weekday}</span>
          <span class="ibc-pill__date">${date}</span>
        </span>
        ${hasActiveTimers ? html`<span class="ibc-pill__flag" title="Timer running">${icons.clock}</span>` : nothing}
        ${enabledAlarms > 0 ? html`<span class="ibc-pill__flag ibc-pill__flag--alarm" title="${enabledAlarms} alarm(s) set">${icons.alert}</span>` : nothing}
        <span class="ibc-pill__tick ${sec === 0 ? 'is-reset' : ''}" style=${`--ibc-sec:${(sec / 59).toFixed(4)}`} aria-hidden="true"></span>
      </button>

      ${expanded ? html`
        <div class="ibc-panel" role="dialog" aria-label="Clock, alarms and timers" @click=${(e: Event) => e.stopPropagation()}>
          <div class="ibc-tabs" role="tablist">
            <button
              role="tab"
              aria-selected=${props.state.activeTab === 'clock' ? 'true' : 'false'}
              class="ibc-tab ${props.state.activeTab === 'clock' ? 'active' : ''}"
              @click=${() => props.onStateChange({ ...props.state, activeTab: 'clock' })}
            >Clock</button>
            <button
              role="tab"
              aria-selected=${props.state.activeTab === 'alarms' ? 'true' : 'false'}
              class="ibc-tab ${props.state.activeTab === 'alarms' ? 'active' : ''}"
              @click=${() => props.onStateChange({ ...props.state, activeTab: 'alarms' })}
            >Alarms ${enabledAlarms > 0 ? html`<span class="ibc-badge">${enabledAlarms}</span>` : nothing}</button>
            <button
              role="tab"
              aria-selected=${props.state.activeTab === 'timers' ? 'true' : 'false'}
              class="ibc-tab ${props.state.activeTab === 'timers' ? 'active' : ''}"
              @click=${() => props.onStateChange({ ...props.state, activeTab: 'timers' })}
            >Timers ${props.state.timers.length > 0 ? html`<span class="ibc-badge">${props.state.timers.length}</span>` : nothing}</button>
            <button class="ibc-close" type="button" aria-label="Close clock" title="Close (Esc)" @click=${() => closePanel(true)}>×</button>
          </div>

          <div class="ibc-content">
            ${props.state.activeTab === 'clock' ? renderClockDisplay(props) : nothing}
            ${props.state.activeTab === 'alarms' ? renderAlarmsTab(props) : nothing}
            ${props.state.activeTab === 'timers' ? renderTimersTab(props) : nothing}
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}
