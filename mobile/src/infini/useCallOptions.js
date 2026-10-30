/**
 * useCallOptions — what the InfiniBot call talks to. Mirrors the web Voice
 * Terminal's selection (ui/src/ui/views/voice-robovoice/*) over the SAME
 * gateway RPCs, so the phone and the web share one routing switch:
 *
 *   target type   Gateway agent  → voice.cliRoute.set { mode: 'api' }
 *                 CLI agent      → voice.cliRoute.set { mode: 'cli', target }   (an open session)
 *                                  voice.cliRoute.start { cli }                   (a new one)
 *   agent         agents.list (default agent first)
 *   session       sessions.list filtered to `agent:<id>:…`; none = the agent's main session
 *   CLI backend   Claude Code / Codex / OpenCode (voice.cliRoute.sessions: open + installed)
 *   voice engine  voice.providers.list / .select — 'auto' (local, default) | 'robovoice' (cloud)
 *   brain         voice.brain.catalog (subscription CLIs, configured API providers with
 *                 live models + Free badges, local models) → voice.cliRoute.set
 *                 { mode: 'api', model } (null = the agent's model). Add key: the
 *                 onboarding checks (quickstart.providers.fetchModels / testModel)
 *                 then auth.profiles.upsert — same as the web picker.
 *
 * Phone-only preferences (agent, session, hands-free, "Hey Infini" wake —
 * off until the user turns it on — its phrases / sensitivity / diagnostics,
 * and the mic + speaker mutes) persist in AsyncStorage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const CALL_OPTIONS_KEY = '@infini/call-options';
export const CLOUD_VOICE_PROVIDER_ID = 'robovoice';

export const CLI_BACKENDS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'grok', label: 'Grok Build' },
];

export const DEFAULTS = {
  agentId: null,
  sessionKey: null,
  handsFree: true,
  wake: false,
  // Mutes (mute-machine.js), per device.
  micMuted: false,
  speakerMuted: false,
  // "Hey Infini" customisation: null = the defaults (wake-phrase DEFAULT_WAKE_PHRASES).
  wakePhrases: null,
  wakeSensitivity: 'normal',
  wakeAgentName: true,
  wakeDebug: false,
};

/** `agent:<id>:<rest>` → `<rest>`, else the key. */
export function sessionShortLabel(session) {
  const title = session?.derivedTitle || session?.label || session?.displayName || session?.title;
  if (title) return String(title);
  const key = String(session?.key || '');
  const parts = key.split(':');
  return parts[0] === 'agent' && parts.length >= 3 ? parts.slice(2).join(':') : key;
}

/** The engine the gateway's voice switch is on. */
export function engineFromProviders(payload) {
  return payload?.active?.realtime === CLOUD_VOICE_PROVIDER_ID ? 'cloud' : 'local';
}

/** One-line description of the current target, for the chip above the face. */
export function describeTarget({ route, agents, agentId, sessionKey, sessions }) {
  if (route?.mode === 'cli' && route.target) {
    const name = CLI_BACKENDS.find((b) => b.id === route.target.cliType)?.label || route.target.cliType || 'CLI';
    return { kind: 'cli', title: name, subtitle: route.target.label || '' };
  }
  const agent = (agents || []).find((a) => a.id === agentId);
  const session = sessionKey ? (sessions || []).find((s) => s.key === sessionKey) : null;
  const base = session ? sessionShortLabel(session) : 'main session';
  // The voice brain model (web chip shows the same): last path segment, no ":latest".
  const model = route?.model ? String(route.model).split('/').pop().replace(/:latest$/, '') : '';
  return { kind: 'agent', title: agent?.name || agentId || 'main', subtitle: model ? `${base} · ${model}` : base };
}

export function useCallOptions(gateway) {
  const [prefs, setPrefs] = useState(DEFAULTS);
  const [agents, setAgents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [route, setRoute] = useState({ mode: 'api' });
  const [routeAlive, setRouteAlive] = useState(null);
  const [catalogue, setCatalogue] = useState({ open: [], installed: [], missing: [] });
  const [engine, setEngineState] = useState('local');
  const [brain, setBrain] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const loaded = useRef(false);
  const connected = gateway?.status === 'connected';

  useEffect(() => {
    AsyncStorage.getItem(CALL_OPTIONS_KEY)
      .then((raw) => {
        if (raw) setPrefs({ ...DEFAULTS, ...JSON.parse(raw) });
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
  }, []);

  const savePrefs = useCallback((patch) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      AsyncStorage.setItem(CALL_OPTIONS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const rpc = useCallback((m, p) => gateway.sendReq(m, p || {}), [gateway]);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setError(null);
    const [a, r, c, v, s, b] = await Promise.allSettled([
      rpc('agents.list'),
      rpc('voice.cliRoute.get'),
      rpc('voice.cliRoute.sessions'),
      rpc('voice.providers.list'),
      rpc('sessions.list', { includeGlobal: false, includeUnknown: false, includeDerivedTitles: true, limit: 80 }),
      rpc('voice.brain.catalog'),
    ]);
    if (a.status === 'fulfilled') {
      const list = (a.value?.agents || []).map((x) => ({ id: x.id, name: x.identity?.name || x.name || x.id }));
      const def = a.value?.defaultId;
      setAgents(def ? [...list.filter((x) => x.id === def), ...list.filter((x) => x.id !== def)] : list);
    } else setError(a.reason?.message || 'Could not load agents');
    if (r.status === 'fulfilled') {
      setRoute(r.value?.route || { mode: 'api' });
      setRouteAlive(r.value?.alive ?? null);
    }
    if (c.status === 'fulfilled') setCatalogue({ open: c.value?.open || [], installed: c.value?.installed || [], missing: c.value?.missing || [] });
    if (v.status === 'fulfilled') setEngineState(engineFromProviders(v.value));
    if (s.status === 'fulfilled') setSessions(Array.isArray(s.value?.sessions) ? s.value.sessions : []);
    if (b.status === 'fulfilled' && Array.isArray(b.value?.api)) setBrain(b.value);
  }, [connected, rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default agent once the roster is known.
  useEffect(() => {
    if (!loaded.current || !agents.length) return;
    if (!prefs.agentId || !agents.some((a) => a.id === prefs.agentId)) savePrefs({ agentId: agents[0].id, sessionKey: null });
  }, [agents, prefs.agentId, savePrefs]);

  const act = useCallback(
    async (key, fn) => {
      setBusy(key);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        setError(err?.message || String(err));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const routeToAgent = useCallback(
    () =>
      act('api', async () => {
        const p = await rpc('voice.cliRoute.set', { mode: 'api' });
        setRoute(p?.route || { mode: 'api' });
        setRouteAlive(p?.alive ?? null);
      }),
    [act, rpc],
  );

  const routeToSession = useCallback(
    (session) =>
      act(`cli:${session.id}`, async () => {
        const target = {
          kind: session.kind,
          ...(session.terminalId ? { terminalId: session.terminalId } : {}),
          ...(session.runId ? { runId: session.runId } : {}),
          cliType: session.cliType,
          label: session.label,
          ...(session.cwd ? { cwd: session.cwd } : {}),
        };
        const p = await rpc('voice.cliRoute.set', { mode: 'cli', target });
        setRoute(p?.route || { mode: 'cli', target });
        setRouteAlive(p?.alive ?? true);
      }),
    [act, rpc],
  );

  const startCli = useCallback(
    (cli) =>
      act(`start:${cli}`, async () => {
        const p = await rpc('voice.cliRoute.start', { cli });
        setRoute(p?.route || route);
        setRouteAlive(p?.alive ?? true);
        await refresh();
      }),
    [act, rpc, refresh, route],
  );

  /** Voice brain for API turns: 'provider/model', or null for the agent's own model. */
  const pickModel = useCallback(
    (model) =>
      act(`model:${model || 'agent'}`, async () => {
        const p = await rpc('voice.cliRoute.set', { mode: 'api', model: model || null });
        setRoute(p?.route || { mode: 'api', model: model || undefined });
        setRouteAlive(p?.alive ?? null);
      }),
    [act, rpc],
  );

  const reloadBrain = useCallback(
    async (fresh) => {
      const b = await rpc('voice.brain.catalog', fresh ? { fresh: true } : {}).catch(() => null);
      if (b && Array.isArray(b.api)) setBrain(b);
    },
    [rpc],
  );

  /** Add key: list models with the key (the provider rejects bad keys). */
  const checkKey = useCallback((provider, apiKey, preferred) => rpc('quickstart.providers.fetchModels', { provider, apiKey, preferred }), [rpc]);

  /** One real test turn, store the key as `<id>:default`, then use the model for voice. */
  const saveKeyAndUse = useCallback(
    (provider, apiKey, model) =>
      act(`key:${provider}`, async () => {
        const test = await rpc('quickstart.providers.testModel', { provider, apiKey, model });
        if (!test?.ok) throw new Error(`${model} didn't answer: ${test?.error || 'unknown error'}`);
        await rpc('auth.profiles.upsert', { profileId: `${provider}:default`, provider, type: 'api_key', key: apiKey.trim() });
        // Providers the runtime doesn't ship: register their OpenAI-compatible endpoint (web: brainRuntimePatch).
        const runtime = (brain?.api || []).find((x) => x.id === provider)?.runtime;
        if (runtime) {
          const snap = await rpc('config.get', {});
          const existing = (snap?.config?.models?.providers?.[provider]?.models || []).map((x) => x.id).filter(Boolean);
          const ids = [...new Set([...existing, model.trim()])];
          const patch = {
            models: {
              providers: {
                [provider]: {
                  baseUrl: runtime.baseUrl,
                  api: runtime.api,
                  models: ids.map((id) => ({ id, name: id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
                },
              },
            },
          };
          if (snap?.hash) await rpc('config.patch', { raw: JSON.stringify(patch), baseHash: snap.hash });
        }
        const ref = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
        const p = await rpc('voice.cliRoute.set', { mode: 'api', model: ref });
        setRoute(p?.route || { mode: 'api', model: ref });
        await reloadBrain(true);
        return true;
      }),
    [act, rpc, reloadBrain, brain],
  );

  const setEngine = useCallback(
    (next) =>
      act('engine', async () => {
        await rpc('voice.providers.select', { id: next === 'cloud' ? CLOUD_VOICE_PROVIDER_ID : 'auto' });
        setEngineState(next);
      }),
    [act, rpc],
  );

  const agentSessions = useMemo(
    () => sessions.filter((s) => typeof s.key === 'string' && prefs.agentId && s.key.startsWith(`agent:${prefs.agentId}:`) && !s.key.endsWith(':main')),
    [sessions, prefs.agentId],
  );

  const target = useMemo(() => ({ agentId: prefs.agentId || 'main', sessionKey: prefs.sessionKey || undefined }), [prefs.agentId, prefs.sessionKey]);
  const label = useMemo(
    () => describeTarget({ route, agents, agentId: target.agentId, sessionKey: target.sessionKey, sessions }),
    [route, agents, target, sessions],
  );

  return {
    prefs,
    savePrefs,
    agents,
    agentSessions,
    route,
    routeAlive,
    catalogue,
    engine,
    brain,
    busy,
    error,
    target,
    label,
    refresh,
    routeToAgent,
    routeToSession,
    startCli,
    setEngine,
    pickModel,
    reloadBrain,
    checkKey,
    saveKeyAndUse,
  };
}
