/**
 * CaptureSheet — quick voice capture from the InfiniBot face.
 *
 *   pick a kind (Note / Idea / Task / Project / Log)
 *     → speak (or type)  → local Whisper (/api/voice/stt)
 *     → capture.structure: AI title / body / tags / project / CRM client /
 *       date (+ priority for tasks), heuristics when no model answers. Dates
 *       are read in the phone's timezone ("by Friday", "next Tuesday at 3").
 *     → confirm card: edit, Save or Discard. Project and client are auto-
 *       associated from what was said (preselected with an "Auto: X · why"
 *       chip when confident, only offered when not; the client also follows
 *       the chosen project), the date shows "Auto: Fri 17 Oct · from “by
 *       Friday”"; all three are changeable through the searchable pickers and
 *       the calendar.
 *     → capture.save (idempotent clientRequestId) → notes / board / ideas
 *       — queued in AsyncStorage and retried when the gateway can't be reached.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';

import { BottomSheet, Button, useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { CAPTURE_ICONS, KeyboardIcon, MicIcon } from './icons';
import { dbToLevel } from './face-math';
import { gatewayHttp, transcribeClip, NOISE } from './voice-client';
import { newClientRequestId } from './capture-queue';
import { ProjectField, ProjectPickerPanel } from '../components/ProjectPicker';
import { ClientField, ClientPickerPanel } from '../components/ClientPicker';
import { DateField, DatePickerPanel } from '../components/DatePicker';
import { useProjectCatalog } from '../lib/useProjectCatalog';
import { useClientCatalog } from '../lib/useClientCatalog';
import { normalizeProjects, resolveAutoProject } from '../lib/project-picker-model';
import { resolveAutoClient } from '../lib/client-picker-model';
import { DATE_FIELD, isHm, isYmd } from '../lib/date-pick';

/** The phone's IANA timezone (the owner's) — capture.structure reads dates in it. */
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export const CAPTURE_KINDS = [
  { kind: 'note', label: 'Note', prompt: 'Say the note…' },
  { kind: 'idea', label: 'Idea', prompt: 'What’s the idea?' },
  { kind: 'task', label: 'Task', prompt: 'What needs doing — and by when?' },
  { kind: 'project', label: 'Project', prompt: 'Name the project and what it’s for' },
  { kind: 'log', label: 'Log', prompt: 'What happened?' },
];

const RECORDING = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64000, isMeteringEnabled: true };
const SILENCE_MS = 1800;

function LevelBars({ level, color }) {
  const bars = [0.5, 0.8, 1, 0.8, 0.5];
  return (
    <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {bars.map((w, i) => (
        <View key={i} style={[styles.bar, { backgroundColor: color, height: 6 + Math.round(30 * Math.min(1, level * w + 0.05)) }]} />
      ))}
    </View>
  );
}

export function CaptureSheet({ kind, visible, onClose, gateway, queue, projects = [], onSaved }) {
  const { colors, type } = useUIKit();
  const { width: winW, height: winH } = useWindowDimensions();
  const meta = CAPTURE_KINDS.find((k) => k.kind === kind) || CAPTURE_KINDS[0];
  const dateMeta = DATE_FIELD[meta.kind] || DATE_FIELD.task;
  const Icon = CAPTURE_ICONS[meta.kind];
  const recorder = useAudioRecorder(RECORDING);
  const [step, setStep] = useState('record'); // record | typing | transcribing | structuring | confirm | saving
  const [level, setLevel] = useState(0);
  const [typed, setTyped] = useState('');
  const [draft, setDraft] = useState(null);
  const [tagsText, setTagsText] = useState('');
  const [error, setError] = useState(null);
  const [recording, setRecording] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [clientSuggestion, setClientSuggestion] = useState(null);
  // Which inline picker replaces the confirm card: null | 'project' | 'client' | 'date'.
  const [picking, setPicking] = useState(null);
  // Once the owner picks a client by hand, a project change no longer moves it.
  const clientTouched = useRef(false);
  // The sheet owns the full project list (every project, cached + shared);
  // the `projects` prop is only a fallback while it loads.
  const catalog = useProjectCatalog(gateway, { enabled: visible });
  const fallbackProjects = useMemo(() => normalizeProjects(projects), [projects]);
  const allProjects = catalog.projects.length ? catalog.projects : fallbackProjects;
  const projectsRef = useRef(allProjects);
  projectsRef.current = allProjects;
  const clientCatalog = useClientCatalog(gateway, { enabled: visible });
  const clientsRef = useRef(clientCatalog.clients);
  clientsRef.current = clientCatalog.clients;
  const r = useRef({ meter: null, heard: false, lastLoud: 0, startedAt: 0, key: newClientRequestId() }).current;

  const stopMeter = () => {
    if (r.meter) clearInterval(r.meter);
    r.meter = null;
  };

  const structure = useCallback(
    async (transcript) => {
      setStep('structuring');
      setError(null);
      let next;
      try {
        const tz = deviceTimeZone();
        const res = await gateway.sendReq('capture.structure', { kind: meta.kind, transcript, ...(tz ? { timeZone: tz } : {}) });
        next = res.draft;
        setTagsText((res.draft?.tags || []).join(', '));
      } catch (err) {
        // Offline / old gateway: keep the words, structure by hand.
        next = { kind: meta.kind, title: transcript.split(/[.!?]/)[0].slice(0, 70), body: transcript, tags: [], transcript, structuredBy: 'heuristic', aiError: err?.message };
        setTagsText('');
      }
      if (meta.kind !== 'project') {
        // Auto-association: confident → preselected; weak → offered only; never an unknown id.
        const list = projectsRef.current.length ? projectsRef.current : await catalog.refresh(false).catch(() => []);
        const auto = resolveAutoProject({ ...next, kind: meta.kind, transcript: next?.transcript || transcript }, list);
        next = { ...next, projectId: auto.projectId, projectName: auto.projectName };
        setSuggestion(auto.suggestion);
      }
      {
        const clients = clientsRef.current.length ? clientsRef.current : await clientCatalog.refresh(false).catch(() => []);
        const autoClient = resolveAutoClient({ ...next, transcript: next?.transcript || transcript }, clients);
        next = { ...next, clientId: autoClient.clientId, clientName: autoClient.clientName };
        setClientSuggestion(autoClient.suggestion);
      }
      if (!isYmd(next?.dueDate)) {
        delete next.dueDate;
        delete next.dueTime;
        delete next.dateSuggestion;
      } else if (!isHm(next.dueTime)) delete next.dueTime;
      setDraft(next);
      setStep('confirm');
    },
    [gateway, meta.kind, catalog, clientCatalog],
  );

  /** Project changed: the client follows the project's own client unless one was picked by hand. */
  const setProject = useCallback(
    async (p) => {
      setDraft((d) => (d ? { ...d, projectId: p?.id, projectName: p?.name } : d));
      if (!p?.id || clientTouched.current || meta.kind === 'project') return;
      try {
        const res = await gateway.sendReq('capture.clientForProject', { projectId: p.id });
        const c = res?.client;
        if (!c?.id) return;
        const s = { id: c.id, name: c.name, confidence: 0.8, reason: `client of “${p.name}”`, source: 'project', auto: true };
        setClientSuggestion(s);
        setDraft((d) => (d && !clientTouched.current ? { ...d, clientId: c.id, clientName: c.name } : d));
      } catch {
        /* older gateway: leave the client as it is */
      }
    },
    [gateway, meta.kind],
  );

  const finishRecording = useCallback(async () => {
    stopMeter();
    if (!recording) return;
    setRecording(false);
    setLevel(0);
    try {
      await recorder.stop();
    } catch {
      /* already stopped */
    }
    const uri = recorder.uri;
    if (!uri) return setError('Nothing was recorded.');
    setStep('transcribing');
    try {
      const http = await gatewayHttp();
      const text = await transcribeClip(http, { uri });
      if (!text || NOISE.test(text)) {
        setStep('record');
        return setError('I didn’t catch that — tap the mic and try again, or type it.');
      }
      await structure(text);
    } catch (err) {
      setStep('typing');
      setError(`Speech-to-text isn’t available (${err?.message || err}). Type it instead.`);
    }
  }, [recording, recorder, structure]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm?.granted) throw new Error('Microphone permission denied');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (err) {
      setStep('typing');
      setError(`Can’t use the microphone (${err?.message || err}). Type it instead.`);
      return;
    }
    setRecording(true);
    r.heard = false;
    r.startedAt = Date.now();
    stopMeter();
    r.meter = setInterval(() => {
      let lv = 0;
      try {
        lv = dbToLevel(recorder.getStatus()?.metering);
      } catch {
        lv = 0;
      }
      setLevel(lv);
      const now = Date.now();
      if (lv > 0.3) {
        r.heard = true;
        r.lastLoud = now;
      }
      if ((r.heard && now - r.lastLoud > SILENCE_MS) || now - r.startedAt > 90_000) void finishRef.current?.();
    }, 90);
  }, [recorder, r]);

  const finishRef = useRef(finishRecording);
  finishRef.current = finishRecording;

  // Fresh state each time the sheet opens; recording starts right away.
  useEffect(() => {
    if (!visible) {
      stopMeter();
      if (recording) recorder.stop().catch(() => {});
      setRecording(false);
      return;
    }
    r.key = newClientRequestId();
    setDraft(null);
    setSuggestion(null);
    setClientSuggestion(null);
    setPicking(null);
    clientTouched.current = false;
    setTyped('');
    setError(null);
    setStep('record');
    void startRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, kind]);

  const save = useCallback(async () => {
    if (!draft?.title?.trim()) return setError('Give it a title first.');
    setStep('saving');
    const final = {
      ...draft,
      tags: tagsText
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, '').trim().toLowerCase())
        .filter(Boolean),
    };
    if (final.projectId) catalog.markUsed(final.projectId);
    else delete final.projectName;
    if (final.clientId) clientCatalog.markUsed(final.clientId);
    else delete final.clientName;
    if (!final.dueDate) {
      delete final.dueDate;
      delete final.dueTime;
    }
    try {
      const res = await queue.submit(final, r.key);
      onSaved?.(res, final);
      onClose?.();
    } catch (err) {
      setStep('confirm');
      setError(err?.message || String(err));
    }
  }, [draft, tagsText, queue, r, onSaved, onClose, catalog, clientCatalog]);

  const field = (label, value, onChange, opts = {}) => (
    <View style={{ gap: 6 }}>
      <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={opts.placeholder}
        placeholderTextColor={withAlpha(colors.text, 0.3)}
        multiline={opts.multiline}
        accessibilityLabel={label}
        testID={opts.testID}
        style={[
          styles.input,
          type.body,
          { color: colors.text, borderColor: withAlpha(colors.text, 0.12), backgroundColor: withAlpha('#000000', 0.35) },
          opts.multiline ? { minHeight: 96, textAlignVertical: 'top' } : null,
        ]}
      />
    </View>
  );

  const busyText = step === 'transcribing' ? 'Transcribing…' : step === 'structuring' ? 'Structuring with AI…' : step === 'saving' ? 'Saving…' : null;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={picking === 'project' ? 'Choose project' : picking === 'client' ? 'Choose client' : picking === 'date' ? dateMeta.label : `New ${meta.label.toLowerCase()}`}
      subtitle={picking ? `For: ${draft?.title || meta.label}` : step === 'confirm' ? 'Check it, then save' : meta.prompt}
      scroll={picking !== 'project' && picking !== 'client'}
      maxHeightRatio={0.9}
      side={winW > winH}
      testID={`capture-sheet-${meta.kind}`}
    >
      {step === 'record' || step === 'typing' ? (
        <View style={{ gap: SPACE.lg }}>
          {step === 'record' ? (
            <View style={styles.recordWrap}>
              <Pressable
                onPress={() => (recording ? void finishRecording() : void startRecording())}
                accessibilityRole="button"
                accessibilityLabel={recording ? 'Done speaking' : 'Start recording'}
                testID="capture-mic"
                style={[styles.mic, { borderColor: withAlpha(colors.primary, recording ? 0.9 : 0.4), backgroundColor: withAlpha(colors.primary, recording ? 0.18 : 0.06) }]}
              >
                <MicIcon size={34} color={colors.primary} />
              </Pressable>
              <LevelBars level={recording ? level : 0} color={colors.primary} />
              <Text style={[type.small, { color: colors.textSecondary, textAlign: 'center' }]}>
                {recording ? 'Listening — pause or tap the mic when you’re done' : 'Tap the mic to speak'}
              </Text>
            </View>
          ) : null}
          {step === 'typing' ? field('Type it', typed, setTyped, { multiline: true, placeholder: meta.prompt, testID: 'capture-typed' }) : null}
          <View style={styles.row}>
            {step === 'record' ? (
              <Button
                title="Type instead"
                variant="outline"
                icon="create-outline"
                onPress={() => {
                  stopMeter();
                  if (recording) recorder.stop().catch(() => {});
                  setRecording(false);
                  setStep('typing');
                }}
                testID="capture-type-instead"
              />
            ) : (
              <Button title="Structure it" onPress={() => typed.trim() && void structure(typed.trim())} disabled={!typed.trim()} testID="capture-structure" />
            )}
          </View>
        </View>
      ) : null}

      {busyText ? (
        <View style={styles.busy}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[type.small, { color: colors.textSecondary }]}>{busyText}</Text>
        </View>
      ) : null}

      {step === 'confirm' && draft && picking === 'client' ? (
        <ClientPickerPanel
          clients={clientCatalog.clients}
          usage={clientCatalog.usage}
          loading={clientCatalog.loading}
          error={clientCatalog.error}
          onRetry={() => void clientCatalog.refresh()}
          selectedId={draft.clientId}
          suggestion={clientSuggestion}
          height={Math.min(520, Math.round(winH * 0.6))}
          onCancel={() => setPicking(null)}
          onSelect={(c) => {
            clientTouched.current = true;
            setDraft({ ...draft, clientId: c?.id, clientName: c?.name });
            setPicking(null);
          }}
          testID="capture-client-picker"
        />
      ) : null}

      {step === 'confirm' && draft && picking === 'date' ? (
        <DatePickerPanel
          date={draft.dueDate}
          time={draft.dueTime}
          onCancel={() => setPicking(null)}
          onDone={({ date, time }) => {
            setDraft({ ...draft, dueDate: date || undefined, dueTime: date && time ? time : undefined });
            setPicking(null);
          }}
          testID="capture-date-picker"
        />
      ) : null}

      {step === 'confirm' && draft && picking === 'project' ? (
        <ProjectPickerPanel
          projects={allProjects}
          usage={catalog.usage}
          loading={catalog.loading}
          error={catalog.error}
          onRetry={() => void catalog.refresh()}
          selectedId={draft.projectId}
          suggestion={suggestion}
          height={Math.min(520, Math.round(winH * 0.6))}
          onCancel={() => setPicking(null)}
          onSelect={(p) => {
            void setProject(p);
            setPicking(null);
          }}
          testID="capture-project-picker"
        />
      ) : null}

      {step === 'confirm' && draft && !picking ? (
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: SPACE.md }} keyboardShouldPersistTaps="handled">
          <View style={[styles.card, { borderColor: withAlpha(colors.primary, 0.35), backgroundColor: withAlpha(colors.primary, 0.05) }]} testID="capture-confirm-card">
            <View style={styles.cardHead}>
              <Icon size={20} color={colors.primary} />
              <Text style={[type.label, { color: colors.primary }]}>{meta.label}</Text>
              <Text style={[type.caption, { color: colors.textMuted, marginLeft: 'auto' }]}>
                {draft.structuredBy === 'ai' ? 'Structured by AI' : 'Structured without AI'}
              </Text>
            </View>
            {field('Title', draft.title, (v) => setDraft({ ...draft, title: v }), { testID: 'capture-title' })}
            {field('Details', draft.body, (v) => setDraft({ ...draft, body: v }), { multiline: true, testID: 'capture-body' })}
            {field('Tags', tagsText, setTagsText, { placeholder: 'comma separated', testID: 'capture-tags' })}
            <DateField
              label={dateMeta.label}
              empty={dateMeta.empty}
              date={draft.dueDate}
              time={draft.dueTime}
              suggestion={draft.dateSuggestion}
              onOpen={() => setPicking('date')}
              onChange={({ date, time }) => setDraft({ ...draft, dueDate: date || undefined, dueTime: date && time ? time : undefined })}
              testID="capture-date"
            />
            {meta.kind === 'task' ? (
              <View style={styles.row}>
                <View style={{ gap: 6 }}>
                  <Text style={[type.label, { color: colors.textMuted }]}>Priority</Text>
                  <View style={styles.row}>
                    {['low', 'medium', 'high'].map((p) => (
                      <Pressable
                        key={p}
                        onPress={() => setDraft({ ...draft, priority: p })}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: draft.priority === p }}
                        style={[styles.chip, { borderColor: draft.priority === p ? colors.primary : withAlpha(colors.text, 0.15) }]}
                      >
                        <Text style={[type.caption, { color: draft.priority === p ? colors.primary : colors.textSecondary }]}>{p}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            ) : null}
            {meta.kind !== 'project' ? (
              <ProjectField
                projectId={draft.projectId}
                projectName={draft.projectName}
                projects={allProjects}
                suggestion={suggestion}
                onOpen={() => setPicking('project')}
                onChange={(p) => void setProject(p)}
                testID="capture-project"
              />
            ) : null}
            <ClientField
              clientId={draft.clientId}
              clientName={draft.clientName}
              clients={clientCatalog.clients}
              suggestion={clientSuggestion}
              onOpen={() => setPicking('client')}
              onChange={(c) => {
                clientTouched.current = true;
                setDraft({ ...draft, clientId: c?.id, clientName: c?.name });
              }}
              testID="capture-client"
            />
            {draft.transcript ? (
              <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={3}>
                You said: “{draft.transcript}”
              </Text>
            ) : null}
          </View>
          <View style={styles.row}>
            <Button title="Discard" variant="ghost" onPress={onClose} testID="capture-discard" />
            <View style={{ flex: 1 }} />
            <Button title={`Save ${meta.label.toLowerCase()}`} icon="checkmark" onPress={save} testID="capture-save" />
          </View>
        </ScrollView>
      ) : null}

      {error ? <Text style={[type.small, { color: colors.error, marginTop: SPACE.sm }]}>{error}</Text> : null}
      {step === 'record' ? (
        <Pressable onPress={() => setStep('typing')} style={styles.typeLink} accessibilityRole="button" accessibilityLabel="Type instead">
          <KeyboardIcon size={16} color={colors.textMuted} />
          <Text style={[type.caption, { color: colors.textMuted }]}>Prefer typing? Use “Type instead”.</Text>
        </Pressable>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  recordWrap: { alignItems: 'center', gap: SPACE.md, paddingVertical: SPACE.md },
  mic: { width: 96, height: 96, borderRadius: 48, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 38 },
  bar: { width: 6, borderRadius: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  busy: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.lg, justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  input: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: 10, minHeight: 44 },
  chip: { minHeight: 36, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  typeLink: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', marginTop: SPACE.md, minHeight: 44 },
});
