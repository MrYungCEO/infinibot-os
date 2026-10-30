/**
 * CommitmentsScreen — KIS Object 8, the money-in / money-out ledger.
 *
 * Mobile parity with ui/src/ui/views/commitment.ts. Two reads back this screen:
 * the ledger (`commitment.list`) and the money surfaces
 * (`commitment.aggregates`). The aggregates — money expected, money owed, money
 * overdue, deposits not received, and the work-proceeding-without-payment
 * exception — are computed SERVER-SIDE and rendered as given. They are never
 * re-derived from the visible rows, because the spec's definitions of those five
 * numbers would drift from a client-side sum the moment a status or commitment
 * type is added.
 *
 * `remainingBalance`, `overdue` and the Paid / Partially Paid status are likewise
 * derived by the store from amountPaid vs amount, so recording a payment writes
 * only `amountPaid`.
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
  ProgressBar,
  BottomSheet,
  useUIKit,
  SPACE,
  staggerDelay,
} from '../ui-kit';
import { RelatedPanel } from '../components/RelatedPanel';
import { useCommitments } from '../hooks/useCommitments';
import { MetaChips, DetailRows, CommonFieldsDetail, ChipPicker, ChipRow, listPlaceholder } from '../kis/ui';
import {
  COMMITMENT_TYPES,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_STATUSES,
  PRIORITIES,
  isMoneyIn,
  formatMoney,
  formatDate,
  isPastDue,
} from '../kis/vocab';

const IN = '__in__';
const OUT = '__out__';
const OVERDUE = '__overdue__';

const emptyDraft = () => ({
  name: '',
  owner: '',
  commitmentType: 'Client Invoice',
  direction: 'Money In',
  status: 'Expected',
  priority: 'P2',
  amount: '',
  amountPaid: '',
  dueDate: '',
  sourceDocumentLink: '',
});

export function CommitmentsScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;

  const {
    commitments,
    aggregates,
    aggregatesError,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    recordPayment,
    moneyIn,
    moneyOut,
    overdue,
  } = useCommitments(sendReq);

  const [view, setView] = useState(IN);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [payment, setPayment] = useState('');

  const selected = useMemo(
    () => commitments.find((c) => c.id === selectedId) || null,
    [commitments, selectedId],
  );

  const resolveLabel = useCallback(
    (nodeType, nodeId) =>
      nodeType === 'commitment' ? commitments.find((c) => c.id === nodeId)?.name : undefined,
    [commitments],
  );

  const tabs = useMemo(
    () => [
      { key: IN, label: 'Money In', icon: 'arrow-down-outline', count: moneyIn.length },
      { key: OUT, label: 'Money Out', icon: 'arrow-up-outline', count: moneyOut.length },
      { key: OVERDUE, label: 'Overdue', icon: 'alarm-outline', count: overdue.length },
    ],
    [moneyIn.length, moneyOut.length, overdue.length],
  );

  const rows = useMemo(() => {
    const list = view === IN ? moneyIn : view === OUT ? moneyOut : overdue;
    // Soonest due first — a ledger is read by what lands next.
    return [...list].sort((a, b) => String(a?.dueDate || '9999').localeCompare(String(b?.dueDate || '9999')));
  }, [view, moneyIn, moneyOut, overdue]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const openCreate = () => {
    setDraft({ ...emptyDraft(), direction: view === OUT ? 'Money Out' : 'Money In' });
    setSaveError(null);
    setCreating(true);
  };

  const openDetail = (commitment) => {
    setSaveError(null);
    setPayment(String(commitment.amountPaid ?? ''));
    setSelectedId(commitment.id);
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
        amount: Number(draft.amount) || 0,
        amountPaid: Number(draft.amountPaid) || 0,
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

  /** Paid fraction for a determinate bar. Null when the amount is unknown. */
  const paidFraction = (c) => {
    const amount = Number(c?.amount) || 0;
    if (!amount) return null;
    return Math.max(0, Math.min(1, (Number(c?.amountPaid) || 0) / amount));
  };

  const wpwp = aggregates?.workProceedingWithoutPayment;

  const placeholder = listPlaceholder({
    loading: loading,
    error: error,
    count: rows.length,
    onRetry: refresh,
    errorTitle: 'Couldn\'t load commitments',
    emptyIcon: 'cash-outline',
    emptyTitle: view === OVERDUE ? 'Nothing overdue' : view === IN ? 'No money-in commitments' : 'No money-out commitments',
    emptyMessage: view === OVERDUE
          ? 'Every commitment is either paid or still inside its due date.'
          : 'Invoices, deposits, milestones, contractor and vendor commitments live here — each with an amount, a due date and an owner.',
    emptyActionLabel: 'New commitment',
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
          title="Commitments"
          subtitle={
            aggregates
              ? `${formatMoney(aggregates.moneyExpected)} expected · ${formatMoney(aggregates.moneyOwed)} owed`
              : `${commitments.length} tracked`
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[{ key: 'add', icon: 'add', label: 'New commitment', onPress: openCreate }]}
        >
          <Tabs tabs={tabs} active={view} onSelect={setView} />
        </AppHeader>
      }
    >
      {/* Money surfaces — computed by commitment.aggregates, shown as given. */}
      {aggregates ? (
        <>
          <View style={styles.statRow}>
            <StatCard
              compact
              style={styles.stat}
              label="Money expected"
              value={formatMoney(aggregates.moneyExpected)}
              tone="success"
              icon="arrow-down-circle-outline"
              footnote="active money-in remaining"
            />
            <StatCard
              compact
              style={styles.stat}
              label="Money owed"
              value={formatMoney(aggregates.moneyOwed)}
              tone="primary"
              icon="arrow-up-circle-outline"
              footnote="active money-out remaining"
            />
          </View>
          <View style={styles.statRow}>
            <StatCard
              compact
              style={styles.stat}
              label="Overdue"
              value={formatMoney(aggregates.moneyOverdue)}
              tone={aggregates.overdueCount ? 'danger' : 'success'}
              icon="alarm-outline"
              footnote={`${aggregates.overdueCount} commitment${aggregates.overdueCount === 1 ? '' : 's'}`}
            />
            <StatCard
              compact
              style={styles.stat}
              label="Deposits unpaid"
              value={formatMoney(aggregates.depositsNotReceived)}
              tone={aggregates.depositsNotReceived ? 'warning' : 'neutral'}
              icon="wallet-outline"
              footnote="money-in deposits not received"
            />
          </View>
          {wpwp ? (
            <StatCard
              label="Work proceeding without payment"
              value={formatMoney(wpwp.amount)}
              tone={wpwp.count ? 'danger' : 'neutral'}
              icon="warning-outline"
              footnote={`${wpwp.count} across ${wpwp.projectIds?.length ?? 0} project${
                (wpwp.projectIds?.length ?? 0) === 1 ? '' : 's'
              }`}
              style={styles.wide}
            />
          ) : null}
        </>
      ) : aggregatesError ? (
        <Card padded style={styles.wide}>
          <Text style={[type.caption, { color: colors.textMuted }]}>
            Money surfaces unavailable — {aggregatesError}. The ledger below is unaffected.
          </Text>
        </Card>
      ) : null}

      {placeholder || (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={[type.label, { color: colors.textSecondary }]}>
              {view === IN ? 'Money in' : view === OUT ? 'Money out' : 'Overdue'}
            </Text>
            <View style={styles.sectionMeta}>
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>
                {formatMoney(rows.reduce((s, c) => s + (Number(c.remainingBalance ?? c.amount) || 0), 0))}
              </Text>
              <Chip label={String(rows.length)} size="sm" />
            </View>
          </View>
          <Card animated delay={staggerDelay(0)}>
            {rows.map((commitment, i) => (
              <React.Fragment key={commitment.id}>
                {i > 0 && <Divider inset />}
                <ListRow
                  icon={isMoneyIn(commitment) ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
                  iconTone={commitment.overdue ? 'danger' : isMoneyIn(commitment) ? 'success' : 'primary'}
                  title={commitment.name}
                  subtitle={commitment.commitmentType}
                  meta={
                    <MetaChips
                      record={commitment}
                      extra={
                        <>
                          <Chip
                            label={isMoneyIn(commitment) ? 'IN' : 'OUT'}
                            tone={isMoneyIn(commitment) ? 'success' : 'primary'}
                            size="sm"
                          />
                          {commitment.dueDate ? (
                            <Chip
                              label={formatDate(commitment.dueDate)}
                              icon="calendar-outline"
                              size="sm"
                              tone={commitment.overdue ? 'danger' : 'neutral'}
                            />
                          ) : null}
                        </>
                      }
                    />
                  }
                  value={formatMoney(commitment.remainingBalance ?? commitment.amount)}
                  valueTone={commitment.overdue ? 'danger' : undefined}
                  onPress={() => openDetail(commitment)}
                  accessibilityLabel={`${commitment.name}, ${commitment.status}, ${formatMoney(
                    commitment.remainingBalance ?? commitment.amount,
                  )} remaining`}
                  accessibilityHint="Opens the commitment detail"
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
        title={selected?.name || 'Commitment'}
        subtitle={selected ? `${selected.commitmentType} · ${selected.direction}` : undefined}
      >
        {selected ? (
          <View>
            <ChipRow>
              <MetaChips
                record={selected}
                size="md"
                extra={
                  selected.overdue ? <Chip label="Overdue" tone="danger" icon="alarm" size="md" /> : null
                }
              />
            </ChipRow>

            {saveError ? (
              <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
                {saveError}
              </Text>
            ) : null}

            <View style={styles.progress}>
              <ProgressBar
                value={paidFraction(selected)}
                tone={selected.overdue ? 'danger' : isMoneyIn(selected) ? 'success' : 'primary'}
                label={`${formatMoney(selected.amountPaid)} of ${formatMoney(selected.amount)} settled`}
                showValue
              />
            </View>

            <DetailRows
              title="Money"
              rows={[
                { label: 'Amount', value: formatMoney(selected.amount), icon: 'cash-outline' },
                { label: 'Paid', value: formatMoney(selected.amountPaid), icon: 'checkmark-circle-outline' },
                {
                  label: 'Remaining',
                  value: formatMoney(selected.remainingBalance),
                  tone: selected.overdue ? 'danger' : undefined,
                  icon: 'hourglass-outline',
                },
                {
                  label: 'Due',
                  value: formatDate(selected.dueDate),
                  tone: isPastDue(selected.dueDate) ? 'danger' : undefined,
                  icon: 'calendar-outline',
                },
                { label: 'Source document', value: selected.sourceDocumentLink, wide: true, icon: 'link-outline' },
              ]}
            />

            <View style={styles.record}>
              <Text style={[type.label, { color: colors.textSecondary }]}>Record a payment</Text>
              <Field
                label="Amount paid to date"
                mono
                keyboardType="numeric"
                value={payment}
                onChangeText={(v) => setPayment(v.replace(/[^0-9.]/g, ''))}
                helper="Status, remaining balance and the overdue flag are all derived from this."
              />
              <Button
                title="Save payment"
                icon="save-outline"
                disabled={payment === '' || Number(payment) === Number(selected.amountPaid)}
                onPress={() => act(() => recordPayment(selected.id, Number(payment) || 0))}
                accessibilityLabel="Save the amount paid"
              />
            </View>

            <ChipPicker
              label="Status"
              options={COMMITMENT_STATUSES}
              value={selected.status}
              onChange={(status) => act(() => update(selected.id, { status }))}
            />

            <CommonFieldsDetail record={selected} />

            <RelatedPanel
              sendReq={sendReq}
              type="commitment"
              id={selected.id}
              label={selected.name}
              resolveLabel={resolveLabel}
            />

            <View style={styles.sheetActions}>
              <Button
                title="Mark paid in full"
                variant="outline"
                icon="checkmark-done-outline"
                disabled={Number(selected.amountPaid) >= Number(selected.amount)}
                onPress={() => act(() => recordPayment(selected.id, Number(selected.amount) || 0))}
                accessibilityLabel="Mark this commitment paid in full"
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
                accessibilityLabel="Delete this commitment"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {/* ── Create ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="New commitment"
        subtitle="Money in or money out, with an amount and a due date"
        footer={
          <Button
            title="Create commitment"
            icon="checkmark"
            fullWidth
            loading={saving}
            onPress={save}
            accessibilityLabel="Create this commitment"
          />
        }
      >
        <Field
          label="Name"
          required
          value={draft.name}
          onChangeText={(v) => setField('name', v)}
          placeholder="What is the commitment?"
        />
        <Field label="Owner" value={draft.owner} onChangeText={(v) => setField('owner', v)} />
        <ChipPicker
          label="Direction"
          options={COMMITMENT_DIRECTIONS}
          value={draft.direction}
          onChange={(v) => setField('direction', v)}
        />
        <ChipPicker
          label="Type"
          options={COMMITMENT_TYPES}
          value={draft.commitmentType}
          onChange={(v) => setField('commitmentType', v)}
        />
        <ChipPicker
          label="Status"
          options={COMMITMENT_STATUSES}
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
          label="Amount"
          mono
          keyboardType="numeric"
          value={String(draft.amount)}
          onChangeText={(v) => setField('amount', v.replace(/[^0-9.]/g, ''))}
          placeholder="0"
        />
        <Field
          label="Amount already paid"
          mono
          keyboardType="numeric"
          value={String(draft.amountPaid)}
          onChangeText={(v) => setField('amountPaid', v.replace(/[^0-9.]/g, ''))}
          placeholder="0"
        />
        <Field
          label="Due date"
          mono
          value={draft.dueDate}
          onChangeText={(v) => setField('dueDate', v)}
          placeholder="YYYY-MM-DD"
        />
        <Field
          label="Source document"
          value={draft.sourceDocumentLink}
          onChangeText={(v) => setField('sourceDocumentLink', v)}
          placeholder="Invoice / contract link"
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
  wide: { marginTop: SPACE.sm },
  section: { marginTop: SPACE.xl, gap: SPACE.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  progress: { marginTop: SPACE.lg },
  record: { marginTop: SPACE.xl, gap: SPACE.sm },
  sheetActions: { marginTop: SPACE.xl, gap: SPACE.sm },
});

export default CommitmentsScreen;
