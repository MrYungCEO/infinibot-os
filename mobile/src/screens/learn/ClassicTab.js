/**
 * Learn › Classic & admin — the original server-backed stepper tracks
 * (learn.* v1, web views/learn-classic.ts + controllers/learn.ts):
 *   My Tracks · Library · Certification · All Users (admin) · Author (admin),
 *   plus the stepper (set current / mark complete / notes / step CTA).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useUIKit, SPACE, RADIUS, HIT, Card, Chip, Button, Field, Tabs, SectionTitle, EmptyState, ProgressBar,
  SkeletonRow, Divider, BottomSheet, Modal,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  classicTabs, classicMyTracks, classicLibrary, classicStepper, stepCtaTarget, classicEligibilityPill,
  newTrackTemplate, authorDraftFor, parseAuthorDraft, TIER_TITLE, fmtDate, errorText, isUnknownMethod,
} from './learn-model';
import { Md, Flash } from './parts';

function ClassicCard({ track, onOpen }) {
  const { colors, type } = useUIKit();
  const done = track.percent === 100;
  return (
    <Card padded tint={done ? 'success' : 'neutral'} onPress={() => onOpen(track.id)} accessibilityLabel={`${track.title}, ${track.percent}%`} style={{ marginTop: SPACE.sm }}>
      <View style={styles.rowWrap}>
        <Chip label={track.category || 'General'} size="sm" />
        {done ? <Chip label="Complete" tone="success" size="sm" /> : null}
        {track.audience === 'admin' ? <Chip label="Admin" tone="warning" size="sm" /> : null}
      </View>
      <Text style={[type.h3, { color: colors.text, marginTop: SPACE.sm }]}>{track.title}</Text>
      {track.description ? <Text style={[type.small, { color: colors.textSecondary, marginTop: 2 }]}>{track.description}</Text> : null}
      <View style={[styles.rowWrap, { marginTop: SPACE.sm }]}>
        <ProgressBar value={track.percent || 0} style={{ flex: 1 }} />
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>
          {track.completedCount ?? 0}/{track.totalSteps ?? (track.steps || []).length} · {track.percent || 0}%
        </Text>
      </View>
    </Card>
  );
}

function StepperSheet({ active, currentStepId, notes, notesDirty, busy, error, success, onClose, onSetCurrent, onComplete, onNotes, onSaveNotes, onCta }) {
  const { colors, type } = useUIKit();
  if (!active) return null;
  const { track, progress } = active;
  const v = classicStepper(track, progress, currentStepId);
  const cta = v.step ? stepCtaTarget(v.step.cta) : null;
  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={track.title}
      subtitle={`${track.category || 'General'} · ${v.footer}`}
      maxHeightRatio={0.94}
      footer={
        <View style={styles.row}>
          <Button title="Prev" icon="chevron-back" variant="ghost" size="sm" disabled={v.isFirst || Boolean(busy)} onPress={() => onSetCurrent(v.prevId)} accessibilityLabel="Previous step" />
          <Button
            title={v.completeLabel}
            variant="primary"
            style={{ flex: 1 }}
            disabled={!v.step || Boolean(busy)}
            loading={busy === 'complete'}
            onPress={() => onComplete(v.step.id)}
          />
          <Button title="Next" iconRight="chevron-forward" variant="ghost" size="sm" disabled={v.isLast || Boolean(busy)} onPress={() => onSetCurrent(v.nextId)} accessibilityLabel="Next step" />
        </View>
      }
    >
      <Flash text={error} tone="danger" />
      <Flash text={success} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.sm }}>
        {v.rail.map((r) => (
          <Pressable
            key={r.id}
            onPress={() => onSetCurrent(r.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: r.active }}
            accessibilityLabel={`Step ${r.n}: ${r.title}${r.done ? ', done' : ''}`}
            style={({ pressed }) => [
              styles.railItem,
              { borderColor: r.active ? colors.primary : colors.border, backgroundColor: r.active ? withAlpha(colors.primary, 0.08) : 'transparent' },
              pressed && { opacity: 0.8 },
            ]}
          >
            <View style={[styles.num, r.done ? { backgroundColor: colors.success, borderColor: colors.success } : { borderColor: colors.primary }]}>
              {r.done ? <Ionicons name="checkmark" size={13} color={colors.background} /> : <Text style={[type.monoSmall, { color: colors.primary }]}>{r.n}</Text>}
            </View>
            <Text style={[type.caption, { color: colors.text, maxWidth: 140 }]} numberOfLines={2}>{r.title}</Text>
            {r.estMinutes ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{r.estMinutes}m</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
      {v.step ? (
        <View>
          <Text style={[type.h2, { color: colors.text }]}>{v.step.title}</Text>
          {v.step.estMinutes ? <Text style={[type.caption, { color: colors.textMuted }]}>~ {v.step.estMinutes} min</Text> : null}
          <View style={{ marginTop: SPACE.sm }}>
            <Md>{v.step.body}</Md>
          </View>
          {cta ? (
            <Button title={cta.label || 'Open'} icon="arrow-forward" variant="outline" onPress={() => onCta(cta)} style={{ marginTop: SPACE.xs }} />
          ) : null}
        </View>
      ) : (
        <Text style={[type.small, { color: colors.textMuted }]}>Empty track.</Text>
      )}
      {v.trackComplete ? <Chip label="Track complete" tone="success" style={{ marginTop: SPACE.md, alignSelf: 'flex-start' }} /> : null}
      <SectionTitle title="My notes for this track" />
      <Field
        multiline
        rows={4}
        value={notes}
        onChangeText={onNotes}
        placeholder="Anything you want the agent (and future-you) to remember about this track."
        accessibilityLabel="Track notes"
      />
      <View style={[styles.row, { marginTop: SPACE.sm }]}>
        <Button title="Save notes" size="sm" variant="outline" disabled={!notesDirty || Boolean(busy)} loading={busy === 'notes'} onPress={onSaveNotes} />
        {notesDirty ? <Text style={[type.caption, { color: colors.textMuted }]}>unsaved</Text> : null}
      </View>
    </BottomSheet>
  );
}

export function ClassicTab({ gateway, isAdmin, onViewCert, onOpenWeb, onOpenUrl }) {
  const { colors, type } = useUIKit();
  const reqRef = useRef(gateway?.sendReq);
  reqRef.current = gateway?.sendReq;
  // gateway.sendReq may be a new function every render; route calls through a
  // ref so effects/callbacks don't re-fire (and re-fetch) on each render.
  const sendReq = useCallback((m, p) => (reqRef.current ? reqRef.current(m, p) : Promise.reject(new Error('Not connected'))), []);
  const [tab, setTab] = useState('my-tracks');
  const [tracks, setTracks] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [cert, setCert] = useState({ eligibility: [], certificates: [], loaded: false });
  const [adminUsers, setAdminUsers] = useState(null);
  const [active, setActive] = useState(null);
  const [currentStepId, setCurrentStepId] = useState(null);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [busy, setBusy] = useState(null);
  const [authorDraft, setAuthorDraft] = useState('');
  const [authorTrackId, setAuthorTrackId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const flash = useCallback((kind, text) => {
    if (kind === 'error') setError(text);
    else setSuccess(text);
    setTimeout(() => (kind === 'error' ? setError((e) => (e === text ? null : e)) : setSuccess((s) => (s === text ? null : s))), 3000);
  }, []);

  const loadTracks = useCallback(async () => {
    if (!sendReq) return;
    setLoading(true);
    try {
      const res = await sendReq('learn.tracks.list', {});
      setTracks(res?.tracks || []);
      setUnavailable(false);
    } catch (e) {
      if (isUnknownMethod(e)) setUnavailable(true);
      else flash('error', errorText(e));
      setTracks((t) => t || []);
    } finally {
      setLoading(false);
    }
  }, [sendReq, flash]);

  const loadCert = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('learn.certificate.status', {});
      setCert({ eligibility: res?.eligibility || [], certificates: res?.certificates || [], loaded: true });
    } catch (e) {
      setCert((c) => ({ ...c, loaded: true }));
      if (!isUnknownMethod(e)) flash('error', errorText(e));
    }
  }, [sendReq, flash]);

  const loadAdminUsers = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('learn.admin.allUsers', {});
      setAdminUsers(res?.users || []);
    } catch (e) {
      setAdminUsers([]);
      flash('error', errorText(e));
    }
  }, [sendReq, flash]);

  useEffect(() => {
    if (gateway?.status !== 'connected') return;
    loadTracks();
    loadCert();
  }, [gateway?.status, loadTracks, loadCert]);

  const selectTab = (k) => {
    setTab(k);
    if (k === 'admin-users') loadAdminUsers();
  };

  const openTrack = async (id) => {
    try {
      const res = await sendReq('learn.track.get', { id });
      setActive(res);
      setCurrentStepId(res?.progress?.currentStepId ?? res?.track?.steps?.[0]?.id ?? null);
      setNotes(res?.progress?.notes ?? '');
      setNotesDirty(false);
    } catch (e) {
      flash('error', errorText(e));
    }
  };

  const setCurrent = async (stepId) => {
    if (!active || !stepId) return;
    setCurrentStepId(stepId);
    try {
      await sendReq('learn.progress.setCurrent', { trackId: active.track.id, stepId });
    } catch {
      /* non-fatal, as on the web */
    }
  };

  const completeStep = async (stepId) => {
    if (!active) return;
    setBusy('complete');
    try {
      const res = await sendReq('learn.progress.completeStep', { trackId: active.track.id, stepId });
      setActive({ track: active.track, progress: res.progress });
      setCurrentStepId(res.progress?.currentStepId ?? stepId);
      flash('success', res.progress?.completedAt ? 'Track complete!' : 'Step complete');
      loadTracks();
    } catch (e) {
      flash('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const saveNotes = async () => {
    if (!active) return;
    setBusy('notes');
    try {
      await sendReq('learn.progress.setNotes', { trackId: active.track.id, notes });
      setNotesDirty(false);
      flash('success', 'Notes saved');
    } catch (e) {
      flash('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const viewCert = async (tier, mint) => {
    if (mint) await loadCert();
    try {
      const res = await sendReq('learn.certificate.svg', { tier });
      const c = cert.certificates.find((x) => x.tier === tier) || res?.certificate;
      onViewCert({ tier, svg: res?.svg, displayName: c?.displayName });
    } catch (e) {
      flash('error', errorText(e));
    }
  };

  const saveAuthor = async () => {
    const parsed = parseAuthorDraft(authorDraft);
    if (!parsed.ok) {
      flash('error', parsed.error);
      return;
    }
    setBusy('author');
    try {
      await sendReq('learn.admin.upsertTrack', { track: parsed.track });
      setAuthorTrackId(parsed.track.id);
      flash('success', 'Track saved');
      loadTracks();
    } catch (e) {
      flash('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const deleteAuthor = async () => {
    setConfirmDelete(false);
    if (!authorTrackId) return;
    setBusy('delete');
    try {
      await sendReq('learn.admin.deleteTrack', { id: authorTrackId });
      flash('success', 'Deleted');
      loadTracks();
    } catch (e) {
      flash('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const tabs = useMemo(() => classicTabs(isAdmin).map((t) => ({ key: t.key, label: t.label })), [isAdmin]);
  const trackById = useMemo(() => new Map((tracks || []).map((t) => [t.id, t])), [tracks]);

  if (unavailable) {
    return (
      <EmptyState
        icon="cloud-offline-outline"
        title="Classic tracks aren't available"
        message="This gateway doesn't serve the classic learn.* tracks."
        actionLabel="Retry"
        onAction={loadTracks}
      />
    );
  }

  const renderBody = () => {
    if (tab === 'my-tracks') {
      const mine = classicMyTracks(tracks);
      if (tracks == null) return <Card><SkeletonRow /><Divider inset /><SkeletonRow /></Card>;
      if (!mine.length) {
        return (
          <EmptyState
            compact
            icon="albums-outline"
            title="No tracks assigned yet"
            message="Pop into the Library tab and pick one."
            actionLabel="Open Library"
            onAction={() => setTab('library')}
          />
        );
      }
      return mine.map((t) => <ClassicCard key={t.id} track={t} onOpen={openTrack} />);
    }
    if (tab === 'library') {
      if (tracks == null) return <Card><SkeletonRow /><Divider inset /><SkeletonRow /></Card>;
      if (!tracks.length) return <EmptyState compact icon="albums-outline" title="No tracks available" />;
      return classicLibrary(tracks).map((g) => (
        <View key={g.category}>
          <SectionTitle title={g.category} count={g.tracks.length} />
          {g.tracks.map((t) => <ClassicCard key={t.id} track={t} onOpen={openTrack} />)}
        </View>
      ));
    }
    if (tab === 'certification') {
      if (!cert.loaded) return <Card><SkeletonRow /></Card>;
      if (!cert.eligibility.length) {
        return (
          <EmptyState
            compact
            icon="ribbon-outline"
            title="No classic certification ladder"
            message="The classic ladder is per user. Sign in as a named user (Settings › Users) to earn classic certificates. The guided Certification tab works for the owner."
          />
        );
      }
      return (
        <View>
          <Card padded tint="neutral">
            <Text style={[type.h3, { color: colors.text }]}>InfiniBot AI Agent Systems Master Certification</Text>
            <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.xs }]}>
              Three tiers, awarded automatically as you complete the bundled walkthroughs. Every track flagged required for the
              certificate counts toward the next tier — finish them all and the Master cert mints. Certificates are SVG-rendered,
              downloadable, and carry a verification fingerprint.
            </Text>
          </Card>
          {cert.eligibility.map((e) => {
            const pill = classicEligibilityPill(e);
            return (
              <Card key={e.tier} padded tint={e.awarded ? 'primary' : 'neutral'} style={{ marginTop: SPACE.sm }}>
                <View style={styles.rowBetween}>
                  <Text style={[type.h3, { color: colors.text }]}>{TIER_TITLE[e.tier] || e.tier}</Text>
                  <Chip label={pill.label} tone={pill.tone} size="sm" />
                </View>
                <View style={[styles.rowWrap, { marginTop: SPACE.sm }]}>
                  <ProgressBar value={e.percent || 0} style={{ flex: 1 }} />
                  <Text style={[type.monoSmall, { color: colors.textMuted }]}>{(e.earned || []).length}/{e.total}</Text>
                </View>
                {(e.missing || []).length ? (
                  <View style={{ marginTop: SPACE.sm }}>
                    <Text style={[type.caption, { color: colors.textMuted }]}>Still to complete:</Text>
                    {e.missing.map((id) => {
                      const t = trackById.get(id);
                      return (
                        <Pressable
                          key={id}
                          disabled={!t}
                          onPress={() => t && openTrack(t.id)}
                          accessibilityRole="link"
                          accessibilityLabel={`Open ${t?.title || id}`}
                          style={({ pressed }) => [styles.link, pressed && { opacity: 0.75 }]}
                        >
                          <Ionicons name="ellipse-outline" size={14} color={colors.textMuted} />
                          <Text style={[type.small, { color: t ? colors.primary : colors.text }]}>{t?.title || id}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                {e.awarded ? (
                  <Button title="View certificate" variant="outline" icon="ribbon-outline" onPress={() => viewCert(e.tier)} style={{ marginTop: SPACE.sm }} />
                ) : e.percent === 100 ? (
                  <Button title="Mint & view" variant="primary" icon="ribbon" onPress={() => viewCert(e.tier, true)} style={{ marginTop: SPACE.sm }} />
                ) : null}
              </Card>
            );
          })}
          {cert.certificates.length ? (
            <>
              <SectionTitle title="Awarded" count={cert.certificates.length} />
              <Card>
                {cert.certificates.map((c, i) => (
                  <View key={c.id || c.tier}>
                    {i ? <Divider /> : null}
                    <View style={[styles.rowBetween, { padding: SPACE.md }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[type.smallStrong, { color: colors.text }]}>{TIER_TITLE[c.tier] || c.tier}</Text>
                        <Text style={[type.monoSmall, { color: colors.textMuted }]}>
                          {fmtDate(c.awardedAt)} · {String(c.hash || '').slice(0, 16)}…
                        </Text>
                      </View>
                      <Button title="View" size="sm" variant="ghost" onPress={() => viewCert(c.tier)} accessibilityLabel={`View ${c.tier} certificate`} />
                    </View>
                  </View>
                ))}
              </Card>
            </>
          ) : null}
        </View>
      );
    }
    if (tab === 'admin-users' && isAdmin) {
      if (adminUsers == null) return <Card><SkeletonRow /><Divider inset /><SkeletonRow /></Card>;
      if (!adminUsers.length) {
        return <EmptyState compact icon="people-outline" title="No users yet" message="Create one from Settings › Users." />;
      }
      return adminUsers.map((row) => (
        <Card key={row.user.id} padded tint="neutral" style={{ marginTop: SPACE.sm }}>
          <View style={styles.rowWrap}>
            <Text style={[type.bodyStrong, { color: colors.text }]}>{row.user.username}</Text>
            <Chip label={row.user.role} tone={row.user.role === 'admin' ? 'warning' : 'neutral'} size="sm" />
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>{row.user.language || 'en'}</Text>
          </View>
          {!row.progress?.length ? (
            <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>No progress yet.</Text>
          ) : (
            row.progress.map((t) => (
              <View key={t.id} style={{ marginTop: SPACE.sm }}>
                <Text style={[type.small, { color: colors.text }]}>{t.title}</Text>
                <View style={styles.rowWrap}>
                  <ProgressBar value={t.percent || 0} style={{ flex: 1 }} />
                  <Text style={[type.monoSmall, { color: colors.textMuted }]}>{t.completedCount}/{t.totalSteps}</Text>
                </View>
              </View>
            ))
          )}
        </Card>
      ));
    }
    if (tab === 'author' && isAdmin) {
      return (
        <View>
          <SectionTitle title="Tracks" count={(tracks || []).length} actionLabel="New track" actionIcon="add" onAction={() => { setAuthorDraft(JSON.stringify(newTrackTemplate(), null, 2)); setAuthorTrackId(null); }} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.sm, paddingVertical: SPACE.xs }}>
            {(tracks || []).map((t) => (
              <Chip
                key={t.id}
                label={t.title}
                selected={authorTrackId === t.id}
                tone={authorTrackId === t.id ? 'primary' : 'neutral'}
                onPress={() => { setAuthorDraft(authorDraftFor(t)); setAuthorTrackId(t.id); }}
                accessibilityLabel={`Edit ${t.title} (${t.id})`}
              />
            ))}
          </ScrollView>
          <Field
            mono
            multiline
            rows={14}
            value={authorDraft}
            onChangeText={setAuthorDraft}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder="Pick a track above, or tap New track."
            accessibilityLabel="Track JSON"
            style={{ marginTop: SPACE.sm }}
          />
          <View style={[styles.row, { marginTop: SPACE.sm }]}>
            <Button title="Save" variant="primary" disabled={!authorDraft.trim() || Boolean(busy)} loading={busy === 'author'} onPress={saveAuthor} />
            {authorTrackId ? (
              <Button title="Delete" variant="danger" disabled={Boolean(busy)} loading={busy === 'delete'} onPress={() => setConfirmDelete(true)} />
            ) : null}
          </View>
          <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.sm }]}>
            Saving writes to {'<state>'}/learn/tracks/{'<id>'}.json. Admin-authored tracks shadow bundled ids.
          </Text>
        </View>
      );
    }
    return null;
  };

  return (
    <View>
      <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.md }]}>
        The original step-by-step reading tracks, per-user assignment and admin authoring. Guided walkthroughs live on the Tracks tab.
      </Text>
      <Tabs tabs={tabs} active={tab} onSelect={selectTab} style={{ marginTop: SPACE.sm }} />
      <View style={{ marginTop: SPACE.md }}>
        <Flash text={error} tone="danger" />
        <Flash text={success} />
        {renderBody()}
      </View>
      <StepperSheet
        active={active}
        currentStepId={currentStepId}
        notes={notes}
        notesDirty={notesDirty}
        busy={busy}
        error={error}
        success={success}
        onClose={() => { setActive(null); setCurrentStepId(null); }}
        onSetCurrent={setCurrent}
        onComplete={completeStep}
        onNotes={(v) => { setNotes(v); setNotesDirty(true); }}
        onSaveNotes={saveNotes}
        onCta={(cta) => (cta.kind === 'url' ? onOpenUrl(cta.url) : onOpenWeb(cta.path, cta.label))}
      />
      <Modal
        visible={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete track "${authorTrackId}"?`}
        subtitle="Bundled tracks can't be deleted — only admin-authored copies."
        footer={
          <View style={styles.row}>
            <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={() => setConfirmDelete(false)} />
            <Button title="Delete" variant="danger" style={{ flex: 1 }} onPress={deleteAuthor} />
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
  link: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: HIT.min },
  railItem: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.sm, minHeight: HIT.min, borderRadius: RADIUS.md, borderWidth: 1 },
  num: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
