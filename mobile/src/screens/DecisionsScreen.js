/**
 * DecisionsScreen — KIS Object 6, the CEO decision queue.
 *
 * Mobile parity with ui/src/ui/views/decision.ts: decisions grouped by status in
 * CEO-first lifecycle order, sorted inside each group by urgency (priority, then
 * deadline). The "CEO Queue only" toggle switches to the `decision.ceoQueue` RPC
 * rather than filtering locally, because the server also applies §17 trigger
 * filtering and urgency ordering.
 *
 * The detail sheet renders the §17 CEO REQUEST FORMAT in the order a CEO reads
 * it — decision required, why now, options, recommendation, impact if delayed —
 * and offers the one action that clears the queue: record the decision. Marking
 * a decision `Decided` is terminal-with-record and writes an audit entry (§33)
 * server-side, so the sheet requires the decision text before it will submit.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

import {
  Screen,
  AppHeader,
  Card,
  ListRow,
  StatCard,
  Divider,
  Chip,
  Button,
  Field,
  Tabs,
  BottomSheet,
  useUIKit,
  SPACE,
  staggerDelay,
} from '../ui-kit';
import { RelatedPanel } from '../components/RelatedPanel';
import { useDecisions } from '../hooks/useDecisions';
import { MetaChips, DetailRows, CommonFieldsDetail, ChipPicker, ChipRow, listPlaceholder } from '../kis/ui';
import {
  DECISION_TYPES,
  DECISION_STATUSES,
  CEO_QUEUE_STATUSES,
  PRIORITIES,
  formatMoney,
  formatDate,
  isPastDue,
} from '../kis/vocab';

const ALL = '__all__';
const CEO = '__ceo__';

const emptyDraft = () => ({
  title: '',
  owner: '',
  requestedBy: '',
  decisionType: 'Operational',
  status: 'Preparing',
  priority: 'P2',
  decisionRequired: '',
  whyNow: '',
  options: '',
  recommendation: '',
  decisionDeadline: '',
  impactIfDelayed: '',
  financialImpact: '',
  ceoRequired: false,
});

export function DecisionsScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;

  const [view, setView] = useState(ALL);
  const ceoQueueOnly = view === CEO;

  const {
    decisions,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    decide,
    byStatus,
    ceoQueueCount,
    financialImpact,
  } = useDecisions(sendReq, { ceoQueueOnly });

  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [finalDecision, setFinalDecision] = useState('');
  const [rationale, setRationale] = useState('');

  const selected = useMemo(
    () => decisions.find((d) => d.id === selectedId) || null,
    [decisions, selectedId],
  );

  const resolveLabel = useCallback(
    (nodeType, nodeId) =>
      nodeType === 'decision' ? decisions.find((d) => d.id === nodeId)?.title : undefined,
    [decisions],
  );

  const tabs = useMemo(
    () => [
      { key: ALL, label: 'All', count: decisions.length },
      { key: CEO, label: 'CEO Queue', icon: 'star', count: ceoQueueOnly ? decisions.length : ceoQueueCount },
      ...[...byStatus.keys()]
        .filter((s) => !CEO_QUEUE_STATUSES.includes(s) || !ceoQueueOnly)
        .map((s) => ({ key: s, label: s, count: (byStatus.get(s) || []).length })),
    ],
    [decisions.length, byStatus, ceoQueueCount, ceoQueueOnly],
  );

  const sections = useMemo(() => {
    if (view !== ALL && view !== CEO) {
      const rows = byStatus.get(view) || [];
      return rows.length ? [{ key: view, rows }] : [];
    }
    return [...byStatus.entries()].map(([key, rows]) => ({ key, rows })).filter((s) => s.rows.length);
  }, [view, byStatus]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setSaveError(null);
    setCreating(true);
  };

  const openDetail = (decision) => {
    setSaveError(null);
    setFinalDecision(decision.finalDecision || '');
    setRationale(decision.rationale || '');
    setSelectedId(decision.id);
  };

  const save = async () => {
    if (!draft.title.trim()) {
      setSaveError('Title is required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await create({
        ...draft,
        title: draft.title.trim(),
        financialImpact: Number(draft.financialImpact) || 0,
      });
      setCreating(false);
    } catch (e) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn) => {
    setSaveError(null);
    try {
      await fn();
    } catch (e) {
      setSaveError(e?.message || String(e));
    }
  };

  const placeholder = listPlaceholder({
    loading: loading,
    error: error,
    count: decisions.length,
    onRetry: refresh,
    errorTitle: 'Couldn\'t load decisions',
    emptyIcon: 'git-compare-outline',
    emptyTitle: ceoQueueOnly ? 'Nothing needs the CEO' : 'No decisions logged',
    emptyMessage: ceoQueueOnly
          ? 'A decision reaches this queue when it is Ready for Decision or in CEO Review.'
          : 'Log the judgement calls the business is waiting on, in the structured CEO request format (§17).',
    emptyActionLabel: 'Log a decision',
    onEmptyAction: openCreate,
  });

  return (
    <Screen
      scroll
      dockSpace
      refreshing={loading}
      onRefresh={refresh}
      header={
        <AppHeader
          eyebrow="Business Control Layer"
          title="Decisions"
          subtitle={
            ceoQueueOnly
              ? `${decisions.length} awaiting the CEO`
              : `${decisions.length} logged · ${ceoQueueCount} on the CEO queue`
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[{ key: 'add', icon: 'add', label: 'Log a decision', onPress: openCreate }]}
        >
          <Tabs tabs={tabs} active={view} onSelect={setView} />
        </AppHeader>
      }
    >
      <View style={styles.statRow}>
        <StatCard
          compact
          style={styles.stat}
          label="CEO queue"
          value={String(ceoQueueOnly ? decisions.length : ceoQueueCount)}
          tone={(ceoQueueOnly ? decisions.length : ceoQueueCount) ? 'warning' : 'success'}
          icon="star-outline"
          footnote="ready / in review"
        />
        <StatCard
          compact
          style={styles.stat}
          label="Financial impact"
          value={formatMoney(financialImpact)}
          tone="primary"
          icon="cash-outline"
          footnote="across shown decisions"
        />
      </View>

      {placeholder ||
        sections.map((section, sectionIndex) => (
          <View key={section.key} style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={[type.label, { color: colors.textSecondary }]}>{section.key}</Text>
              <Chip label={String(section.rows.length)} size="sm" />
            </View>
            <Card animated delay={staggerDelay(sectionIndex)}>
              {section.rows.map((decision, i) => (
                <React.Fragment key={decision.id}>
                  {i > 0 && <Divider inset />}
                  <ListRow
                    icon="git-compare-outline"
                    iconTone={
                      CEO_QUEUE_STATUSES.includes(String(decision.status)) ? 'warning' : 'neutral'
                    }
                    title={decision.title}
                    subtitle={decision.decisionRequired || decision.recommendation || decision.owner}
                    meta={
                      <MetaChips
                        record={decision}
                        extra={
                          decision.decisionDeadline ? (
                            <Chip
                              label={formatDate(decision.decisionDeadline)}
                              icon="time-outline"
                              size="sm"
                              tone={isPastDue(decision.decisionDeadline) ? 'danger' : 'neutral'}
                            />
                          ) : null
                        }
                      />
                    }
                    value={decision.financialImpact ? formatMoney(decision.financialImpact) : undefined}
                    onPress={() => openDetail(decision)}
                    accessibilityLabel={`${decision.title}, ${decision.status}`}
                    accessibilityHint="Opens the decision request"
                  />
                </React.Fragment>
              ))}
            </Card>
          </View>
        ))}

      {/* ── Detail: the §17 CEO request format ────────────────────── */}
      <BottomSheet
        visible={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.title || 'Decision'}
        subtitle={selected ? `${selected.decisionType} · ${selected.status}` : undefined}
      >
        {selected ? (
          <View>
            <ChipRow>
              <MetaChips record={selected} size="md" />
            </ChipRow>

            {saveError ? (
              <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
                {saveError}
              </Text>
            ) : null}

            <DetailRows
              title="CEO request (§17)"
              rows={[
                { label: 'Decision required', value: selected.decisionRequired, wide: true, icon: 'help-circle-outline' },
                { label: 'Why now', value: selected.whyNow, wide: true, icon: 'flash-outline' },
                { label: 'Options', value: selected.options, wide: true, icon: 'list-outline' },
                { label: 'Recommendation', value: selected.recommendation, wide: true, icon: 'bulb-outline' },
                {
                  label: 'Deadline',
                  value: formatDate(selected.decisionDeadline),
                  tone: isPastDue(selected.decisionDeadline) ? 'danger' : undefined,
                  icon: 'calendar-outline',
                },
                { label: 'Impact if delayed', value: selected.impactIfDelayed, wide: true, icon: 'trending-down-outline' },
                { label: 'Financial impact', value: selected.financialImpact ? formatMoney(selected.financialImpact) : '', icon: 'cash-outline' },
                { label: 'Requested by', value: selected.requestedBy, icon: 'person-outline' },
              ]}
            />

            {Array.isArray(selected.ceoTriggers) && selected.ceoTriggers.length ? (
              <View style={styles.triggers}>
                <Text style={[type.label, { color: colors.textSecondary }]}>
                  CEO triggers matched
                </Text>
                <View style={styles.triggerRow}>
                  {selected.ceoTriggers.map((trigger) => (
                    <Chip key={trigger} label={trigger} tone="warning" size="sm" icon="alert-outline" />
                  ))}
                </View>
              </View>
            ) : null}

            <ChipPicker
              label="Status"
              options={DECISION_STATUSES.filter((s) => s !== 'Decided')}
              value={selected.status}
              onChange={(status) => act(() => update(selected.id, { status }))}
              helper="Recording the decision below is what sets Decided — it writes the audit entry (§33)."
            />

            {selected.status === 'Decided' ? (
              <DetailRows
                title="Outcome"
                rows={[
                  { label: 'Final decision', value: selected.finalDecision, wide: true, icon: 'checkmark-circle-outline' },
                  { label: 'Rationale', value: selected.rationale, wide: true, icon: 'document-text-outline' },
                  { label: 'Decided on', value: formatDate(selected.decisionDate), icon: 'calendar-outline' },
                ]}
              />
            ) : (
              <View style={styles.record}>
                <Text style={[type.label, { color: colors.textSecondary }]}>Record the decision</Text>
                <Field
                  label="Final decision"
                  multiline
                  rows={3}
                  value={finalDecision}
                  onChangeText={setFinalDecision}
                  placeholder="What was decided?"
                />
                <Field
                  label="Rationale"
                  multiline
                  rows={3}
                  value={rationale}
                  onChangeText={setRationale}
                  placeholder="Why — so the reasoning survives the decision"
                />
                <Button
                  title="Mark decided"
                  icon="checkmark-done"
                  disabled={!finalDecision.trim()}
                  onPress={() =>
                    act(() =>
                      decide(selected.id, {
                        finalDecision: finalDecision.trim(),
                        rationale: rationale.trim(),
                      }),
                    )
                  }
                  accessibilityLabel="Record this decision as decided"
                />
              </View>
            )}

            <CommonFieldsDetail record={selected} />

            <RelatedPanel
              sendReq={sendReq}
              type="decision"
              id={selected.id}
              label={selected.title}
              resolveLabel={resolveLabel}
            />

            <View style={styles.sheetActions}>
              <Button
                title={selected.ceoRequired ? 'Clear CEO required' : 'Mark CEO required'}
                variant="outline"
                icon="star-outline"
                onPress={() => act(() => update(selected.id, { ceoRequired: !selected.ceoRequired }))}
                accessibilityLabel="Toggle whether this decision requires the CEO"
              />
              <Button
                title="Delete"
                variant="danger"
                icon="trash-outline"
                onPress={() =>
                  act(async () => {
                    await remove(selected.id);
                    setSelectedId(null);
                  })
                }
                accessibilityLabel="Delete this decision"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {/* ── Create ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="Log a decision"
        subtitle="The structured CEO request format (§17)"
        footer={
          <Button
            title="Log decision"
            icon="checkmark"
            fullWidth
            loading={saving}
            onPress={save}
            accessibilityLabel="Log this decision"
          />
        }
      >
        <Field
          label="Title"
          required
          value={draft.title}
          onChangeText={(v) => setField('title', v)}
          placeholder="Short name for the decision"
        />
        <Field label="Owner" value={draft.owner} onChangeText={(v) => setField('owner', v)} />
        <Field
          label="Requested by"
          value={draft.requestedBy}
          onChangeText={(v) => setField('requestedBy', v)}
        />
        <ChipPicker
          label="Type"
          options={DECISION_TYPES}
          value={draft.decisionType}
          onChange={(v) => setField('decisionType', v)}
        />
        <ChipPicker
          label="Status"
          options={DECISION_STATUSES.filter((s) => s !== 'Decided')}
          value={draft.status}
          onChange={(v) => setField('status', v)}
        />
        <ChipPicker
          label="Priority"
          options={PRIORITIES}
          value={draft.priority}
          onChange={(v) => setField('priority', v)}
        />
        <Field
          label="Decision required"
          multiline
          rows={3}
          value={draft.decisionRequired}
          onChangeText={(v) => setField('decisionRequired', v)}
          placeholder="The single question to answer"
        />
        <Field
          label="Why now"
          multiline
          rows={2}
          value={draft.whyNow}
          onChangeText={(v) => setField('whyNow', v)}
        />
        <Field
          label="Options"
          multiline
          rows={3}
          value={draft.options}
          onChangeText={(v) => setField('options', v)}
        />
        <Field
          label="Recommendation"
          multiline
          rows={2}
          value={draft.recommendation}
          onChangeText={(v) => setField('recommendation', v)}
        />
        <Field
          label="Decision deadline"
          mono
          value={draft.decisionDeadline}
          onChangeText={(v) => setField('decisionDeadline', v)}
          placeholder="YYYY-MM-DD"
        />
        <Field
          label="Impact if delayed"
          multiline
          rows={2}
          value={draft.impactIfDelayed}
          onChangeText={(v) => setField('impactIfDelayed', v)}
        />
        <Field
          label="Financial impact"
          mono
          keyboardType="numeric"
          value={String(draft.financialImpact)}
          onChangeText={(v) => setField('financialImpact', v.replace(/[^0-9.]/g, ''))}
          placeholder="0"
        />
        <ChipPicker
          label="CEO required"
          options={[
            { key: 'no', label: 'No' },
            { key: 'yes', label: 'Yes' },
          ]}
          value={draft.ceoRequired ? 'yes' : 'no'}
          onChange={(v) => setField('ceoRequired', v === 'yes')}
        />
        {saveError ? (
          <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
            {saveError}
          </Text>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.sm },
  stat: { flex: 1 },
  section: { marginTop: SPACE.xl, gap: SPACE.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  triggers: { marginTop: SPACE.lg, gap: SPACE.sm },
  triggerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  record: { marginTop: SPACE.xl, gap: SPACE.sm },
  sheetActions: { marginTop: SPACE.xl, gap: SPACE.sm },
});

export default DecisionsScreen;
