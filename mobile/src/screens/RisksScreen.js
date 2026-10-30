/**
 * RisksScreen — KIS Object 7, the risk register.
 *
 * Mobile parity with ui/src/ui/views/risk.ts. The register reads by severity:
 * every row carries a P×I score chip (Probability × Impact on the 1–5 matrix,
 * so 1–25) toned by its band — Critical >= 12, High >= 8, Medium >= 4, Low.
 *
 * `riskScore` and the derived `riskLevel` band are computed by the store and
 * never entered, so the re-score control writes `probability` and `impact` only
 * and lets the server recalculate. The score shown while a write is in flight is
 * the previous server value, not an optimistic guess — a wrong severity is worse
 * than a stale one.
 *
 * "Overdue review" switches to `risk.overdue`, which applies the §29 cadence
 * (3-day review for critical risks, 14-day for the rest) that a local date
 * filter could not reproduce.
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
import { useRisks } from '../hooks/useRisks';
import { MetaChips, DetailRows, CommonFieldsDetail, ChipPicker, ChipRow, listPlaceholder } from '../kis/ui';
import {
  RISK_CATEGORIES,
  RISK_STATUSES,
  RISK_MATRIX_MIN,
  RISK_MATRIX_MAX,
  PRIORITIES,
  CRITICAL_RISK_SCORE,
  computeRiskScore,
  riskBand,
  riskBandTone,
  formatDate,
  formatMoney,
  isPastDue,
} from '../kis/vocab';

const ALL = '__all__';
const OVERDUE = '__overdue__';
const MATRIX = Array.from({ length: RISK_MATRIX_MAX - RISK_MATRIX_MIN + 1 }, (_, i) => ({
  key: String(RISK_MATRIX_MIN + i),
  label: String(RISK_MATRIX_MIN + i),
}));

const emptyDraft = () => ({
  title: '',
  owner: '',
  category: 'Delivery',
  status: 'Open',
  priority: 'P2',
  probability: '3',
  impact: '3',
  mitigation: '',
  nextReviewDate: '',
  nextAction: '',
});

/** The score chip that heads every risk row — the register's primary signal. */
function ScoreChip({ score, size = 'sm' }) {
  const value = Number(score) || 0;
  if (!value) return null;
  return (
    <Chip
      label={`${value} · ${riskBand(value)}`}
      tone={riskBandTone(value)}
      size={size}
      dot
      accessibilityLabel={`Risk score ${value}, ${riskBand(value)}`}
    />
  );
}

export function RisksScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;

  const [view, setView] = useState(ALL);
  const overdueOnly = view === OVERDUE;

  const {
    risks,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    score,
    byScore,
    byStatus,
    criticalCount,
    openCount,
    topBand,
  } = useRisks(sendReq, { overdueOnly });

  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const selected = useMemo(() => risks.find((r) => r.id === selectedId) || null, [risks, selectedId]);

  const resolveLabel = useCallback(
    (nodeType, nodeId) => (nodeType === 'risk' ? risks.find((r) => r.id === nodeId)?.title : undefined),
    [risks],
  );

  const tabs = useMemo(
    () => [
      { key: ALL, label: 'Register', count: risks.length },
      { key: OVERDUE, label: 'Overdue review', icon: 'alarm-outline' },
      ...RISK_STATUSES.filter((s) => (byStatus.get(s) || []).length).map((s) => ({
        key: s,
        label: s,
        count: (byStatus.get(s) || []).length,
      })),
    ],
    [risks.length, byStatus],
  );

  // The register itself is one severity-ordered list; a status tab narrows it.
  const rows = useMemo(() => {
    if (view === ALL || view === OVERDUE) return byScore;
    return byStatus.get(view) || [];
  }, [view, byScore, byStatus]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setSaveError(null);
    setCreating(true);
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
        probability: Number(draft.probability) || RISK_MATRIX_MIN,
        impact: Number(draft.impact) || RISK_MATRIX_MIN,
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

  const draftScore = computeRiskScore(draft.probability, draft.impact);

  const placeholder = listPlaceholder({
    loading: loading,
    error: error,
    count: rows.length,
    onRetry: refresh,
    errorTitle: 'Couldn\'t load the risk register',
    emptyIcon: 'shield-checkmark-outline',
    emptyTitle: overdueOnly ? 'No risk reviews overdue' : 'No risks registered',
    emptyMessage: overdueOnly
          ? 'Critical risks are reviewed every 3 days and the rest every 14 (§29). Nothing has slipped past that.'
          : 'Register what could go wrong, score it Probability × Impact, and give it an owner and a mitigation.',
    emptyActionLabel: 'Register a risk',
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
          title="Risks"
          subtitle={
            risks.length
              ? `${risks.length} registered${topBand ? ` · top band ${topBand}` : ''}`
              : 'Register'
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[{ key: 'add', icon: 'add', label: 'Register a risk', onPress: openCreate }]}
        >
          <Tabs tabs={tabs} active={view} onSelect={setView} />
        </AppHeader>
      }
    >
      <View style={styles.statRow}>
        <StatCard
          compact
          style={styles.stat}
          label="Critical"
          value={String(criticalCount)}
          tone={criticalCount ? 'danger' : 'success'}
          icon="warning-outline"
          footnote={`score >= ${CRITICAL_RISK_SCORE}`}
        />
        <StatCard
          compact
          style={styles.stat}
          label="Live"
          value={String(openCount)}
          tone={openCount ? 'warning' : 'success'}
          icon="eye-outline"
          footnote="open / monitoring"
        />
      </View>

      {placeholder || (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={[type.label, { color: colors.textSecondary }]}>
              {view === ALL ? 'By severity' : view === OVERDUE ? 'Review overdue' : view}
            </Text>
            <Chip label={String(rows.length)} size="sm" />
          </View>
          <Card animated delay={staggerDelay(0)}>
            {rows.map((risk, i) => (
              <React.Fragment key={risk.id}>
                {i > 0 && <Divider inset />}
                <ListRow
                  icon="warning-outline"
                  iconTone={riskBandTone(risk.riskScore)}
                  title={risk.title}
                  subtitle={risk.mitigation || risk.nextAction || risk.category}
                  meta={
                    <MetaChips
                      record={risk}
                      extra={
                        <>
                          <ScoreChip score={risk.riskScore} />
                          <Chip label={risk.category} size="sm" tone="neutral" />
                          {risk.nextReviewDate && isPastDue(risk.nextReviewDate) ? (
                            <Chip label="Review due" tone="warning" icon="alarm-outline" size="sm" />
                          ) : null}
                        </>
                      }
                    />
                  }
                  value={`${risk.probability ?? '?'}×${risk.impact ?? '?'}`}
                  valueTone={riskBandTone(risk.riskScore)}
                  onPress={() => {
                    setSaveError(null);
                    setSelectedId(risk.id);
                  }}
                  accessibilityLabel={`${risk.title}, score ${risk.riskScore}, ${risk.status}`}
                  accessibilityHint="Opens the risk detail"
                />
              </React.Fragment>
            ))}
          </Card>
        </View>
      )}

      {/* ── Detail ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.title || 'Risk'}
        subtitle={selected ? `${selected.category} · ${selected.status}` : undefined}
      >
        {selected ? (
          <View>
            <ChipRow>
              <ScoreChip score={selected.riskScore} size="md" />
              <MetaChips record={selected} size="md" quality={false} />
            </ChipRow>

            {saveError ? (
              <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
                {saveError}
              </Text>
            ) : null}

            <View style={styles.matrix}>
              <Text style={[type.label, { color: colors.textSecondary }]}>Re-score (1–5 matrix)</Text>
              <ChipPicker
                label="Probability"
                options={MATRIX}
                value={String(selected.probability ?? '')}
                onChange={(p) => act(() => score(selected.id, Number(p), selected.impact))}
              />
              <ChipPicker
                label="Impact"
                options={MATRIX}
                value={String(selected.impact ?? '')}
                onChange={(im) => act(() => score(selected.id, selected.probability, Number(im)))}
              />
              <Text style={[type.caption, { color: colors.textMuted }]}>
                Score is Probability × Impact, computed server-side — it updates when the write
                returns, not before.
              </Text>
            </View>

            <ChipPicker
              label="Status"
              options={RISK_STATUSES}
              value={selected.status}
              onChange={(status) => act(() => update(selected.id, { status }))}
            />

            <DetailRows
              title="Response"
              rows={[
                { label: 'Mitigation', value: selected.mitigation, wide: true, icon: 'shield-outline' },
                {
                  label: 'Next review',
                  value: formatDate(selected.nextReviewDate),
                  tone: isPastDue(selected.nextReviewDate) ? 'danger' : undefined,
                  icon: 'alarm-outline',
                },
                { label: 'Risk level', value: selected.riskLevel, icon: 'speedometer-outline' },
                { label: 'Financial exposure', value: selected.financialValue ? formatMoney(selected.financialValue) : '', icon: 'cash-outline' },
                { label: 'Linked decision', value: selected.decisionId, icon: 'git-compare-outline' },
                { label: 'Linked issue', value: selected.issueId, icon: 'bug-outline' },
              ]}
            />

            <CommonFieldsDetail record={selected} />

            <RelatedPanel
              sendReq={sendReq}
              type="risk"
              id={selected.id}
              label={selected.title}
              resolveLabel={resolveLabel}
            />

            <View style={styles.sheetActions}>
              <Button
                title="Mark mitigated"
                variant="outline"
                icon="shield-checkmark-outline"
                disabled={selected.status === 'Mitigated'}
                onPress={() => act(() => update(selected.id, { status: 'Mitigated' }))}
                accessibilityLabel="Mark this risk mitigated"
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
                accessibilityLabel="Delete this risk"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {/* ── Create ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="Register a risk"
        subtitle={`Score preview: ${draftScore} · ${riskBand(draftScore)}`}
        footer={
          <Button
            title="Register risk"
            icon="checkmark"
            fullWidth
            loading={saving}
            onPress={save}
            accessibilityLabel="Register this risk"
          />
        }
      >
        <Field
          label="Title"
          required
          value={draft.title}
          onChangeText={(v) => setField('title', v)}
          placeholder="What could go wrong?"
        />
        <Field label="Owner" value={draft.owner} onChangeText={(v) => setField('owner', v)} />
        <ChipPicker
          label="Category"
          options={RISK_CATEGORIES}
          value={draft.category}
          onChange={(v) => setField('category', v)}
        />
        <ChipPicker
          label="Status"
          options={RISK_STATUSES}
          value={draft.status}
          onChange={(v) => setField('status', v)}
        />
        <ChipPicker
          label="Priority"
          options={PRIORITIES}
          value={draft.priority}
          onChange={(v) => setField('priority', v)}
        />
        <ChipPicker
          label="Probability"
          options={MATRIX}
          value={draft.probability}
          onChange={(v) => setField('probability', v)}
        />
        <ChipPicker
          label="Impact"
          options={MATRIX}
          value={draft.impact}
          onChange={(v) => setField('impact', v)}
          helper={`Probability × Impact = ${draftScore} (${riskBand(draftScore)}).`}
        />
        <Field
          label="Mitigation"
          multiline
          rows={3}
          value={draft.mitigation}
          onChangeText={(v) => setField('mitigation', v)}
        />
        <Field
          label="Next review date"
          mono
          value={draft.nextReviewDate}
          onChangeText={(v) => setField('nextReviewDate', v)}
          placeholder="YYYY-MM-DD"
        />
        <Field
          label="Next action"
          value={draft.nextAction}
          onChangeText={(v) => setField('nextAction', v)}
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
  matrix: { marginTop: SPACE.lg, gap: SPACE.xs },
  sheetActions: { marginTop: SPACE.xl, gap: SPACE.sm },
});

export default RisksScreen;
