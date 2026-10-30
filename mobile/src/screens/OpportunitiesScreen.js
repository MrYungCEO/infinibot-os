/**
 * OpportunitiesScreen — KIS Object 2, the opportunity pipeline.
 *
 * Mobile parity with the web pipeline board (ui/src/ui/views/opportunity.ts). A
 * phone can't host a nine-column drag board, so the same information is a
 * stage-grouped list with a stage filter: "All" shows every stage as a section
 * in board order (New → … → Negotiation → Won/Lost/Hold), a stage chip narrows
 * to one column.
 *
 * §24 is respected: moving an opportunity to "Won" does NOT create a project.
 * The detail sheet asks for an existing projectId and routes it through
 * `opportunity.convert`, which is the only thing that links the two.
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
import { useOpportunities } from '../hooks/useOpportunities';
import { MetaChips, DetailRows, CommonFieldsDetail, ChipPicker, ChipRow, listPlaceholder } from '../kis/ui';
import {
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  OPPORTUNITY_TYPES,
  REVENUE_TYPES,
  PRIORITIES,
  formatMoney,
  formatDate,
} from '../kis/vocab';

const ALL = '__all__';

const emptyDraft = () => ({
  name: '',
  owner: '',
  opportunityType: 'New Client',
  stage: 'New',
  priority: 'P2',
  estimatedValue: '',
  revenueType: 'One-Time',
  expectedCloseDate: '',
  problemNeed: '',
  nextAction: '',
});

export function OpportunitiesScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;

  const {
    opportunities,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    moveStage,
    convert,
    byStage,
    pipelineValue,
    wonValue,
    needsAction,
    stale,
  } = useOpportunities(sendReq);

  const [stageFilter, setStageFilter] = useState(ALL);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [projectId, setProjectId] = useState('');

  const selected = useMemo(
    () => opportunities.find((o) => o.id === selectedId) || null,
    [opportunities, selectedId],
  );

  // The graph gives nodes as {type,id}; this is the only type whose names this
  // screen actually holds, so it resolves opportunities and nothing else.
  const resolveLabel = useCallback(
    (nodeType, nodeId) =>
      nodeType === 'opportunity' ? opportunities.find((o) => o.id === nodeId)?.name : undefined,
    [opportunities],
  );

  const tabs = useMemo(
    () => [
      { key: ALL, label: 'All', count: opportunities.length },
      ...PIPELINE_STAGES.filter((s) => (byStage.get(s) || []).length).map((s) => ({
        key: s,
        label: s,
        count: (byStage.get(s) || []).length,
      })),
    ],
    [opportunities.length, byStage],
  );

  const sections = useMemo(() => {
    if (stageFilter !== ALL) {
      const rows = byStage.get(stageFilter) || [];
      return rows.length ? [{ stage: stageFilter, rows }] : [];
    }
    return PIPELINE_STAGES.map((stage) => ({ stage, rows: byStage.get(stage) || [] })).filter(
      (s) => s.rows.length,
    );
  }, [stageFilter, byStage]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setSaveError(null);
    setCreating(true);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setSaveError('Name is required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await create({
        ...draft,
        name: draft.name.trim(),
        estimatedValue: Number(draft.estimatedValue) || 0,
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
    count: opportunities.length,
    onRetry: refresh,
    errorTitle: 'Couldn\'t load opportunities',
    emptyIcon: 'trending-up-outline',
    emptyTitle: 'No opportunities yet',
    emptyMessage: 'Opportunities you create — or convert from a lead — show up here as pipeline stages.',
    emptyActionLabel: 'New opportunity',
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
          title="Opportunities"
          subtitle={
            opportunities.length
              ? `${opportunities.length} tracked · ${formatMoney(pipelineValue)} in play`
              : 'Pipeline'
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[
            { key: 'add', icon: 'add', label: 'New opportunity', onPress: openCreate },
          ]}
        >
          <Tabs tabs={tabs} active={stageFilter} onSelect={setStageFilter} />
        </AppHeader>
      }
    >
      <View style={styles.statRow}>
        <StatCard
          compact
          style={styles.stat}
          label="In play"
          value={formatMoney(pipelineValue)}
          tone="primary"
          icon="trending-up-outline"
          footnote="non-terminal stages"
        />
        <StatCard
          compact
          style={styles.stat}
          label="Won"
          value={formatMoney(wonValue)}
          tone="success"
          icon="trophy-outline"
        />
      </View>
      <View style={styles.statRow}>
        <StatCard
          compact
          style={styles.stat}
          label="Needs action"
          value={String(needsAction.length)}
          tone={needsAction.length ? 'warning' : 'neutral'}
          icon="alert-circle-outline"
          footnote="§28 next-action rule"
        />
        <StatCard
          compact
          style={styles.stat}
          label="Stale"
          value={String(stale.length)}
          tone={stale.length ? 'danger' : 'neutral'}
          icon="hourglass-outline"
          footnote="§29 staleness"
        />
      </View>

      {placeholder ||
        sections.map((section, sectionIndex) => (
          <View key={section.stage} style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={[type.label, { color: colors.textSecondary }]}>{section.stage}</Text>
              <View style={styles.sectionMeta}>
                <Text style={[type.monoSmall, { color: colors.textMuted }]}>
                  {formatMoney(
                    section.rows.reduce((s, o) => s + (Number(o.estimatedValue) || 0), 0),
                  )}
                </Text>
                <Chip label={String(section.rows.length)} size="sm" />
              </View>
            </View>
            <Card animated delay={staggerDelay(sectionIndex)}>
              {section.rows.map((opp, i) => (
                <React.Fragment key={opp.id}>
                  {i > 0 && <Divider inset />}
                  <ListRow
                    icon="trending-up-outline"
                    iconTone={TERMINAL_STAGES.includes(opp.stage) ? 'neutral' : 'primary'}
                    title={opp.name}
                    subtitle={opp.nextAction || opp.problemNeed || opp.owner}
                    meta={<MetaChips record={opp} status={opp.stage} />}
                    value={opp.estimatedValue ? formatMoney(opp.estimatedValue) : undefined}
                    onPress={() => {
                      setProjectId('');
                      setSaveError(null);
                      setSelectedId(opp.id);
                    }}
                    accessibilityLabel={`${opp.name}, ${opp.stage}`}
                    accessibilityHint="Opens the opportunity detail"
                  />
                </React.Fragment>
              ))}
            </Card>
          </View>
        ))}

      {/* ── Detail ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name || 'Opportunity'}
        subtitle={selected ? `${selected.stage} · ${selected.opportunityType}` : undefined}
      >
        {selected ? (
          <View>
            <ChipRow>
              <MetaChips record={selected} status={selected.stage} size="md" />
            </ChipRow>

            {saveError ? (
              <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
                {saveError}
              </Text>
            ) : null}

            <ChipPicker
              label="Stage"
              options={PIPELINE_STAGES}
              value={selected.stage}
              onChange={(stage) => act(() => moveStage(selected.id, stage))}
              helper="Winning an opportunity does not create a project (§24) — link one below."
            />

            <DetailRows
              title="Substance"
              rows={[
                { label: 'Problem / need', value: selected.problemNeed, wide: true, icon: 'help-circle-outline' },
                { label: 'Proposed solution', value: selected.proposedSolution, wide: true, icon: 'bulb-outline' },
                { label: 'Estimated value', value: selected.estimatedValue ? formatMoney(selected.estimatedValue) : '', icon: 'cash-outline' },
                { label: 'Revenue type', value: selected.revenueType, icon: 'repeat-outline' },
                { label: 'Score', value: selected.opportunityScore ? String(selected.opportunityScore) : '', icon: 'speedometer-outline' },
                { label: 'Expected close', value: formatDate(selected.expectedCloseDate), icon: 'calendar-outline' },
                { label: 'Waiting for', value: selected.waitingFor, wide: true, icon: 'pause-circle-outline' },
                { label: 'Review date', value: formatDate(selected.reviewDate), icon: 'refresh-outline' },
                { label: 'Proposal', value: selected.proposalLink, wide: true, icon: 'link-outline' },
                { label: 'Notes', value: selected.notes, wide: true, icon: 'document-text-outline' },
              ]}
            />

            <CommonFieldsDetail record={selected} />

            {selected.stage === 'Won' && !selected.projectId ? (
              <View style={styles.convert}>
                <Text style={[type.label, { color: colors.textSecondary }]}>
                  Link a delivery project
                </Text>
                <Text style={[type.caption, { color: colors.textMuted }]}>
                  §24: winning does not create a project. Supply the id of a project that already
                  exists.
                </Text>
                <Field
                  label="Project ID"
                  mono
                  value={projectId}
                  onChangeText={setProjectId}
                  placeholder="project id"
                />
                <Button
                  title="Link project"
                  variant="outline"
                  icon="git-merge-outline"
                  disabled={!projectId.trim()}
                  onPress={() => act(async () => {
                    await convert(selected.id, projectId.trim());
                    setProjectId('');
                  })}
                  accessibilityLabel="Link this opportunity to a project"
                />
              </View>
            ) : null}

            <RelatedPanel
              sendReq={sendReq}
              type="opportunity"
              id={selected.id}
              label={selected.name}
              resolveLabel={resolveLabel}
            />

            <View style={styles.sheetActions}>
              <Button
                title="Mark escalation"
                variant="outline"
                icon="arrow-up-circle-outline"
                onPress={() =>
                  act(() => update(selected.id, { escalationRequired: !selected.escalationRequired }))
                }
                accessibilityLabel="Toggle escalation required"
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
                accessibilityLabel="Delete this opportunity"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {/* ── Create ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="New opportunity"
        subtitle="A record without an owner is a wish (§27)"
        footer={
          <Button
            title="Create opportunity"
            icon="checkmark"
            fullWidth
            loading={saving}
            onPress={save}
            accessibilityLabel="Create this opportunity"
          />
        }
      >
        <Field
          label="Name"
          required
          value={draft.name}
          onChangeText={(v) => setField('name', v)}
          placeholder="What is the opportunity?"
        />
        <Field
          label="Owner"
          value={draft.owner}
          onChangeText={(v) => setField('owner', v)}
          placeholder="The single accountable owner"
        />
        <ChipPicker
          label="Type"
          options={OPPORTUNITY_TYPES}
          value={draft.opportunityType}
          onChange={(v) => setField('opportunityType', v)}
        />
        <ChipPicker
          label="Stage"
          options={PIPELINE_STAGES}
          value={draft.stage}
          onChange={(v) => setField('stage', v)}
        />
        <ChipPicker
          label="Priority"
          options={PRIORITIES}
          value={draft.priority}
          onChange={(v) => setField('priority', v)}
        />
        <Field
          label="Estimated value"
          mono
          keyboardType="numeric"
          value={String(draft.estimatedValue)}
          onChangeText={(v) => setField('estimatedValue', v.replace(/[^0-9.]/g, ''))}
          placeholder="0"
        />
        <ChipPicker
          label="Revenue type"
          options={REVENUE_TYPES}
          value={draft.revenueType}
          onChange={(v) => setField('revenueType', v)}
        />
        <Field
          label="Expected close date"
          mono
          value={draft.expectedCloseDate}
          onChangeText={(v) => setField('expectedCloseDate', v)}
          placeholder="YYYY-MM-DD"
        />
        <Field
          label="Problem / need"
          multiline
          rows={3}
          value={draft.problemNeed}
          onChangeText={(v) => setField('problemNeed', v)}
        />
        <Field
          label="Next action"
          value={draft.nextAction}
          onChangeText={(v) => setField('nextAction', v)}
          helper="§28: every active record needs a next action."
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
  sectionMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  convert: { marginTop: SPACE.xl, gap: SPACE.sm },
  sheetActions: { marginTop: SPACE.xl, gap: SPACE.sm },
});

export default OpportunitiesScreen;
