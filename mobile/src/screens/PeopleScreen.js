/**
 * PeopleScreen — KIS Object 9, the roster and its derived workload.
 *
 * Mobile parity with ui/src/ui/views/person.ts. The important property of this
 * object: workload is NEVER stored on the person record. It is derived by the
 * gateway from the typed-edge graph (`person.workload` → active tasks, tasks,
 * projects, decisions, risks, issues), so `availability` on the record is the
 * person's stated capacity and the workload numbers are what they are actually
 * carrying. The screen shows both, side by side, and never conflates them.
 *
 * A person whose workload hasn't resolved shows "—" rather than a zero: zero
 * assignments and "we don't know yet" are different facts.
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
  SegmentedControl,
  ProgressBar,
  BottomSheet,
  useUIKit,
  SPACE,
  staggerDelay,
} from '../ui-kit';
import { RelatedPanel } from '../components/RelatedPanel';
import { usePeople } from '../hooks/usePeople';
import { MetaChips, DetailRows, CommonFieldsDetail, ChipPicker, ChipRow, listPlaceholder } from '../kis/ui';
import {
  PERSON_RELATIONSHIP_TYPES,
  PERSON_STATUSES,
  PERSON_ACCESS_LEVELS,
  PRIORITIES,
  shortId,
} from '../kis/vocab';

const ALL = '__all__';
const SORT_OPTIONS = [
  { key: 'workload', label: 'By workload' },
  { key: 'relationship', label: 'By relationship' },
];

const emptyDraft = () => ({
  name: '',
  role: '',
  relationshipType: 'Contractor',
  status: 'Active',
  priority: 'P2',
  accessLevel: 'Standard',
  availability: '',
  costRate: '',
  email: '',
  phone: '',
  capabilities: '',
  owner: '',
});

export function PeopleScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;

  const {
    people,
    workloads,
    workloadsLoading,
    workloadFor,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    assignTask,
    unassignTask,
    byRelationship,
    byWorkload,
    activeCount,
    totalActiveTasks,
  } = usePeople(sendReq);

  const [sortBy, setSortBy] = useState('workload');
  const [filter, setFilter] = useState(ALL);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [taskId, setTaskId] = useState('');

  const selected = useMemo(() => people.find((p) => p.id === selectedId) || null, [people, selectedId]);
  const selectedWorkload = selected ? workloadFor(selected.id) : null;

  const resolveLabel = useCallback(
    (nodeType, nodeId) => (nodeType === 'person' ? people.find((p) => p.id === nodeId)?.name : undefined),
    [people],
  );

  const tabs = useMemo(
    () => [
      { key: ALL, label: 'Everyone', count: people.length },
      ...PERSON_RELATIONSHIP_TYPES.filter((r) => (byRelationship.get(r) || []).length).map((r) => ({
        key: r,
        label: r,
        count: (byRelationship.get(r) || []).length,
      })),
    ],
    [people.length, byRelationship],
  );

  const sections = useMemo(() => {
    if (filter !== ALL) {
      const rows = byRelationship.get(filter) || [];
      return rows.length ? [{ key: filter, rows }] : [];
    }
    if (sortBy === 'workload') {
      return byWorkload.length ? [{ key: 'Busiest first', rows: byWorkload }] : [];
    }
    return PERSON_RELATIONSHIP_TYPES.map((key) => ({ key, rows: byRelationship.get(key) || [] })).filter(
      (s) => s.rows.length,
    );
  }, [filter, sortBy, byWorkload, byRelationship]);

  /** Busiest active-task count in the roster — the denominator for the bars. */
  const peakLoad = useMemo(
    () => Object.values(workloads).reduce((m, w) => Math.max(m, Number(w?.activeTaskCount) || 0), 0),
    [workloads],
  );

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setSaveError(null);
    setCreating(true);
  };

  const openDetail = (person) => {
    setSaveError(null);
    setTaskId('');
    setSelectedId(person.id);
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
        capabilities: draft.capabilities
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
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

  /** Workload summary line. '—' when the derived read hasn't landed. */
  const loadLine = (person) => {
    const w = workloadFor(person.id);
    if (!w) return workloadsLoading ? 'capacity loading…' : 'capacity —';
    return `${w.activeTaskCount} active of ${w.taskCount} tasks · ${w.projectCount} projects`;
  };

  const placeholder = listPlaceholder({
    loading: loading,
    error: error,
    count: people.length,
    onRetry: refresh,
    errorTitle: 'Couldn\'t load the roster',
    emptyIcon: 'people-outline',
    emptyTitle: 'No people on the roster',
    emptyMessage: 'Founders, employees, contractors and partners live here. Workload is derived from what they are linked to — you never type it in.',
    emptyActionLabel: 'Add a person',
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
          title="People"
          subtitle={
            people.length
              ? `${activeCount} active · ${totalActiveTasks} active assignments`
              : 'Roster'
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[{ key: 'add', icon: 'add', label: 'Add a person', onPress: openCreate }]}
        >
          <Tabs tabs={tabs} active={filter} onSelect={setFilter} />
        </AppHeader>
      }
    >
      {filter === ALL ? (
        <SegmentedControl options={SORT_OPTIONS} value={sortBy} onChange={setSortBy} />
      ) : null}

      <View style={styles.statRow}>
        <StatCard
          compact
          style={styles.stat}
          label="Active people"
          value={String(activeCount)}
          tone="primary"
          icon="people-outline"
        />
        <StatCard
          compact
          style={styles.stat}
          label="Active tasks"
          value={String(totalActiveTasks)}
          tone={totalActiveTasks ? 'info' : 'neutral'}
          icon="checkbox-outline"
          footnote="derived from the graph"
          loading={workloadsLoading && !totalActiveTasks}
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
              {section.rows.map((person, i) => {
                const w = workloadFor(person.id);
                return (
                  <React.Fragment key={person.id}>
                    {i > 0 && <Divider inset />}
                    <ListRow
                      icon="person-outline"
                      iconTone={person.status === 'Active' ? 'primary' : 'neutral'}
                      title={person.name}
                      subtitle={`${person.role || person.relationshipType} · ${loadLine(person)}`}
                      meta={
                        <MetaChips
                          record={person}
                          extra={
                            <>
                              <Chip label={person.relationshipType} size="sm" tone="neutral" />
                              {person.availability ? (
                                <Chip
                                  label={person.availability}
                                  icon="time-outline"
                                  size="sm"
                                  tone="neutral"
                                />
                              ) : null}
                            </>
                          }
                        />
                      }
                      value={w ? String(w.activeTaskCount) : '—'}
                      valueTone={w && peakLoad && w.activeTaskCount >= peakLoad ? 'warning' : undefined}
                      onPress={() => openDetail(person)}
                      accessibilityLabel={`${person.name}, ${person.role || person.relationshipType}, ${loadLine(person)}`}
                      accessibilityHint="Opens the person detail"
                    />
                  </React.Fragment>
                );
              })}
            </Card>
          </View>
        ))}

      {/* ── Detail ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name || 'Person'}
        subtitle={selected ? `${selected.role || selected.relationshipType}` : undefined}
      >
        {selected ? (
          <View>
            <ChipRow>
              <MetaChips
                record={selected}
                size="md"
                extra={<Chip label={selected.relationshipType} size="md" tone="neutral" />}
              />
            </ChipRow>

            {saveError ? (
              <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
                {saveError}
              </Text>
            ) : null}

            {/* Derived workload — computed from the edge graph, never stored. */}
            <View style={styles.workload}>
              <Text style={[type.label, { color: colors.textSecondary }]}>
                Workload (derived)
              </Text>
              {selectedWorkload ? (
                <>
                  <ProgressBar
                    value={peakLoad ? selectedWorkload.activeTaskCount / peakLoad : 0}
                    tone={
                      peakLoad && selectedWorkload.activeTaskCount >= peakLoad ? 'warning' : 'primary'
                    }
                    label={`${selectedWorkload.activeTaskCount} active task${
                      selectedWorkload.activeTaskCount === 1 ? '' : 's'
                    }`}
                  />
                  <Text style={[type.caption, { color: colors.textMuted }]}>
                    Relative to the busiest person on the roster ({peakLoad} active).
                  </Text>
                </>
              ) : (
                <Text style={[type.caption, { color: colors.textMuted }]}>
                  {workloadsLoading
                    ? 'Resolving capacity from the relation graph…'
                    : 'Capacity could not be resolved for this person.'}
                </Text>
              )}
            </View>

            <DetailRows
              title="Assignments"
              rows={[
                { label: 'Active tasks', value: selectedWorkload ? String(selectedWorkload.activeTaskCount) : '', icon: 'flash-outline' },
                { label: 'Total tasks', value: selectedWorkload ? String(selectedWorkload.taskCount) : '', icon: 'checkbox-outline' },
                { label: 'Projects', value: selectedWorkload ? String(selectedWorkload.projectCount) : '', icon: 'layers-outline' },
                { label: 'Decisions', value: selectedWorkload ? String(selectedWorkload.decisionCount) : '', icon: 'git-compare-outline' },
                { label: 'Risks', value: selectedWorkload ? String(selectedWorkload.riskCount) : '', icon: 'warning-outline' },
                { label: 'Issues', value: selectedWorkload ? String(selectedWorkload.issueCount) : '', icon: 'bug-outline' },
                { label: 'Total links', value: selectedWorkload ? String(selectedWorkload.totalLinks) : '', icon: 'git-network-outline' },
              ]}
            />

            <DetailRows
              title="Capacity & contact"
              rows={[
                { label: 'Stated availability', value: selected.availability, icon: 'time-outline' },
                { label: 'Cost / rate', value: selected.costRate, icon: 'cash-outline' },
                { label: 'Access level', value: selected.accessLevel, icon: 'key-outline' },
                { label: 'Email', value: selected.email, wide: true, icon: 'mail-outline' },
                { label: 'Phone', value: selected.phone, icon: 'call-outline' },
                { label: 'Other contact', value: selected.contactInfo, wide: true, icon: 'chatbubble-outline' },
              ]}
            />

            {Array.isArray(selected.capabilities) && selected.capabilities.length ? (
              <View style={styles.caps}>
                <Text style={[type.label, { color: colors.textSecondary }]}>Capabilities</Text>
                <View style={styles.capRow}>
                  {selected.capabilities.map((cap) => (
                    <Chip key={cap} label={cap} size="sm" tone="neutral" />
                  ))}
                </View>
              </View>
            ) : null}

            <ChipPicker
              label="Status"
              options={PERSON_STATUSES}
              value={selected.status}
              onChange={(status) => act(() => update(selected.id, { status }))}
            />
            <ChipPicker
              label="Access level"
              options={PERSON_ACCESS_LEVELS}
              value={selected.accessLevel}
              onChange={(accessLevel) => act(() => update(selected.id, { accessLevel }))}
            />

            {/* task_assigned_to_person — the edge workload actually counts. */}
            <View style={styles.assign}>
              <Text style={[type.label, { color: colors.textSecondary }]}>Assign a task</Text>
              <Field
                label="Task ID"
                mono
                value={taskId}
                onChangeText={setTaskId}
                placeholder="task id"
                helper="Creates the task_assigned_to_person edge and re-derives workload."
              />
              <View style={styles.assignActions}>
                <Button
                  title="Assign"
                  icon="add-circle-outline"
                  disabled={!taskId.trim()}
                  onPress={() =>
                    act(async () => {
                      await assignTask(selected.id, taskId.trim());
                      setTaskId('');
                    })
                  }
                  accessibilityLabel="Assign this task to the person"
                />
                <Button
                  title="Unassign"
                  variant="outline"
                  icon="remove-circle-outline"
                  disabled={!taskId.trim()}
                  onPress={() =>
                    act(async () => {
                      await unassignTask(selected.id, taskId.trim());
                      setTaskId('');
                    })
                  }
                  accessibilityLabel="Unassign this task from the person"
                />
              </View>
            </View>

            <CommonFieldsDetail record={selected} />

            <RelatedPanel
              sendReq={sendReq}
              type="person"
              id={selected.id}
              label={selected.name}
              resolveLabel={resolveLabel}
            />

            <View style={styles.sheetActions}>
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
                accessibilityLabel={`Delete ${selected.name} from the roster`}
              />
              <Text style={[type.caption, { color: colors.textMuted }]}>
                Record id {shortId(selected.id)}
              </Text>
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {/* ── Create ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="Add a person"
        subtitle="Workload is derived — enter stated availability, not current load"
        footer={
          <Button
            title="Add person"
            icon="checkmark"
            fullWidth
            loading={saving}
            onPress={save}
            accessibilityLabel="Add this person to the roster"
          />
        }
      >
        <Field
          label="Name"
          required
          value={draft.name}
          onChangeText={(v) => setField('name', v)}
          placeholder="Full name"
        />
        <Field
          label="Role"
          value={draft.role}
          onChangeText={(v) => setField('role', v)}
          placeholder="Head of Growth, Contract Designer, …"
        />
        <ChipPicker
          label="Relationship"
          options={PERSON_RELATIONSHIP_TYPES}
          value={draft.relationshipType}
          onChange={(v) => setField('relationshipType', v)}
        />
        <ChipPicker
          label="Status"
          options={PERSON_STATUSES}
          value={draft.status}
          onChange={(v) => setField('status', v)}
        />
        <ChipPicker
          label="Access level"
          options={PERSON_ACCESS_LEVELS}
          value={draft.accessLevel}
          onChange={(v) => setField('accessLevel', v)}
        />
        <ChipPicker
          label="Priority"
          options={PRIORITIES}
          value={draft.priority}
          onChange={(v) => setField('priority', v)}
        />
        <Field
          label="Capabilities"
          value={draft.capabilities}
          onChangeText={(v) => setField('capabilities', v)}
          helper="Comma separated — e.g. React, copywriting, Figma"
        />
        <Field
          label="Stated availability"
          value={draft.availability}
          onChangeText={(v) => setField('availability', v)}
          placeholder="Full-time, 20 hrs/week, weekends…"
        />
        <Field
          label="Cost / rate"
          value={draft.costRate}
          onChangeText={(v) => setField('costRate', v)}
          placeholder="$120/hr, £4k/mo, equity…"
        />
        <Field
          label="Email"
          value={draft.email}
          onChangeText={(v) => setField('email', v)}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <Field
          label="Phone"
          value={draft.phone}
          onChangeText={(v) => setField('phone', v)}
          keyboardType="phone-pad"
        />
        <Field
          label="Accountable manager"
          value={draft.owner}
          onChangeText={(v) => setField('owner', v)}
          helper="The owner of this person record (§27)."
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
  workload: { marginTop: SPACE.lg, gap: SPACE.sm },
  caps: { marginTop: SPACE.lg, gap: SPACE.sm },
  capRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  assign: { marginTop: SPACE.xl, gap: SPACE.sm },
  assignActions: { flexDirection: 'row', gap: SPACE.sm },
  sheetActions: { marginTop: SPACE.xl, gap: SPACE.sm },
});

export default PeopleScreen;
