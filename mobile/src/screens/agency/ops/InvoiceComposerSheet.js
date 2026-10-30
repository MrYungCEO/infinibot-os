/**
 * Invoice composer (web renderInvoiceComposer): client + project, number
 * (primed from agency.ops.invoice.number.next), currency, issue / due dates
 * (backdating supported — a past issue date records into that month via
 * agency.ops.invoice.backlog.record, with an optional historical payment),
 * line items (qty x price, cadence, reorder, remove), tax, reference / notes /
 * terms, payment option (payment-accounts list / add / delete), live totals
 * and Save draft / Issue. Integer-cents maths from agency-ops-invoice.js.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { BottomSheet, Button, Field, IconButton, SPACE, useUIKit } from '../../../ui-kit';
import { moneyCents } from './agency-ops-model';
import {
  INVOICE_CADENCES,
  INVOICE_RPC,
  computeInvoiceTotals,
  createInvoiceDraft,
  describePeriod,
  dayToTimestamp,
  emptyPaymentAccount,
  invoiceDraftProblems,
  isBackdated,
  newLine,
  paymentAccountPayload,
  planInvoiceSave,
  readInvoiceId,
  withIssueDate,
} from './agency-ops-invoice';
import { Actions, ActionButton, Meta, Notice, Row, SelectField, StatPairs, Tile, Title } from './ui';

export function InvoiceComposerSheet({ ctx, options, onClose }) {
  const { ops } = ctx;
  const { colors } = useUIKit();
  const s = ops.state;
  const [draft, setDraft] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [newAccount, setNewAccount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const agencyId = s.selectedAgencyId;

  useEffect(() => {
    if (!options) { setDraft(null); return; }
    const d = createInvoiceDraft({ invoices: s.invoices, currency: s.revenue?.currency || s.finance.currency, clientId: options.clientId, backdated: options.backdated });
    setDraft(d); setError(null); setSaved(null); setNewAccount(null);
    ops.req(INVOICE_RPC.numberNext, { agencyId, issuedAt: dayToTimestamp(d.issueDate) ?? undefined })
      .then((r) => { if (r?.number) setDraft((x) => (x ? { ...x, number: r.number } : x)); }).catch(() => {});
    ops.req(INVOICE_RPC.accountsList, { agencyId })
      .then((r) => {
        const list = Array.isArray(r?.accounts) ? r.accounts.filter((a) => a?.id && a?.label) : [];
        setAccounts(list);
        const def = list.find((a) => a.isDefault);
        if (def) setDraft((x) => (x && !x.paymentAccountId ? { ...x, paymentAccountId: def.id } : x));
      }).catch(() => setAccounts([]));
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => (draft ? computeInvoiceTotals(draft.lines, draft.taxPercent) : null), [draft]);
  if (!options || !draft) return <BottomSheet visible={false} onClose={onClose} title="" />;
  const problems = invoiceDraftProblems(draft, totals);
  const backdated = isBackdated(draft.issueDate);
  const patch = (p) => { setDraft((d) => ({ ...d, ...p })); setSaved(null); };
  const patchLine = (key, p) => patch({ lines: draft.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) });
  const moveLine = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= draft.lines.length) return;
    const lines = [...draft.lines];
    const [m] = lines.splice(i, 1);
    lines.splice(j, 0, m);
    patch({ lines });
  };

  const save = async (issue) => {
    if (problems.length) { setError(problems[0]); return; }
    setSaving(true); setError(null);
    const plan = planInvoiceSave(draft, totals, agencyId, { issue });
    let method = plan.create[0];
    try {
      const r = await ops.call(plan.create[0], plan.create[1], { quiet: true });
      const id = readInvoiceId(r);
      if (plan.issue && id) {
        method = INVOICE_RPC.issue;
        await ops.call(INVOICE_RPC.issue, { agencyId, invoiceId: id, ...plan.issue }, { quiet: true });
      }
      let msg = issue ? `Issued ${draft.number} for ${moneyCents(totals.totalCents, draft.currency)}.` : `Saved ${draft.number} as a draft.`;
      if (plan.backdated) msg += ` Recorded into ${describePeriod(draft.issueDate)}.`;
      if (plan.mode === 'backlog' && plan.create[1].payments.length) msg += ` ${moneyCents(plan.create[1].payments[0].amountCents, draft.currency)} logged as received on ${draft.paidDate}.`;
      setSaved(msg);
      ctx.flash(msg);
      ops.load({ background: true });
    } catch (e) {
      setError(e?.message || String(e));
      ops.addFailure(method, e);
    } finally { setSaving(false); }
  };

  const saveAccount = async () => {
    if (!newAccount?.label?.trim()) { setError('Give this payment option a label, e.g. "USD Wise".'); return; }
    try {
      const r = await ops.call(INVOICE_RPC.accountsUpsert, paymentAccountPayload(newAccount, agencyId), { busyKey: 'account-save', quiet: true });
      if (r?.account?.id) { setAccounts((a) => [r.account, ...a.filter((x) => x.id !== r.account.id)]); patch({ paymentAccountId: r.account.id }); }
      setNewAccount(null);
    } catch (e) { setError(e?.message || String(e)); }
  };
  const deleteAccount = async (id) => {
    try {
      await ops.call(INVOICE_RPC.accountsDelete, { agencyId, id }, { busyKey: `acct:${id}` });
      setAccounts((a) => a.filter((x) => x.id !== id));
      if (draft.paymentAccountId === id) patch({ paymentAccountId: '' });
    } catch { /* recorded */ }
  };

  const clientOptions = [['', 'Choose a client'], ...s.clients.map((c) => [c.id, c.name])];
  const projectOptions = [['', 'No project'], ...s.projects.filter((p) => !draft.clientId || p.clientId === draft.clientId || !p.clientId).map((p) => [p.id, p.name])];

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={options.backdated ? 'Backlog a past invoice' : 'New invoice'}
      subtitle={backdated ? `Backdated — records into ${describePeriod(draft.issueDate)}` : 'Issue today or save as a draft'}
      maxHeightRatio={0.95}
      footer={(
        <Row>
          <Button title="Save draft" variant="secondary" onPress={() => save(false)} disabled={saving} style={{ flex: 1 }} accessibilityLabel="Save the invoice as a draft" />
          <Button title={backdated ? 'Record invoice' : 'Issue invoice'} onPress={() => save(true)} loading={saving} disabled={problems.length > 0} style={{ flex: 1 }} accessibilityLabel="Issue the invoice" testID="aops-invoice-issue" />
        </Row>
      )}
    >
      {saved ? <Notice tone="success" text={saved} /> : null}
      {error ? <Notice tone="danger" text={error} /> : null}
      <SelectField label="Client" value={draft.clientId} options={clientOptions} onChange={(v) => patch({ clientId: v, projectId: '' })} searchable />
      <SelectField label="Project" value={draft.projectId} options={projectOptions} onChange={(v) => patch({ projectId: v })} searchable />
      <Row>
        <Field label="Invoice number" value={draft.number} onChangeText={(v) => patch({ number: v })} mono style={{ flex: 2 }} />
        <Field label="Currency" value={draft.currency} onChangeText={(v) => patch({ currency: v.toUpperCase() })} mono autoCapitalize="characters" style={{ flex: 1 }} />
      </Row>
      <Row>
        <Field label="Issue date" value={draft.issueDate} onChangeText={(v) => setDraft((d) => withIssueDate(d, v))} mono placeholder="YYYY-MM-DD" style={{ flex: 1 }} error={dayToTimestamp(draft.issueDate) === null ? 'YYYY-MM-DD' : undefined} />
        <Field label="Due date" value={draft.dueDate} onChangeText={(v) => patch({ dueDate: v })} mono placeholder="YYYY-MM-DD" style={{ flex: 1 }} />
      </Row>
      {backdated ? (
        <Tile>
          <Title>Payment already received</Title>
          <Meta>Optional. Logs a historical payment so receivables and cash match what happened.</Meta>
          <Row>
            <Field label={`Amount (${draft.currency})`} value={draft.paidAmount} onChangeText={(v) => patch({ paidAmount: v })} keyboardType="decimal-pad" mono style={{ flex: 1 }} />
            <Field label="Received on" value={draft.paidDate} onChangeText={(v) => patch({ paidDate: v })} mono style={{ flex: 1 }} />
          </Row>
        </Tile>
      ) : null}

      <Title style={{ marginTop: SPACE.sm }}>Line items</Title>
      {draft.lines.map((line, i) => {
        const lt = totals.lines[i];
        return (
          <Tile key={line.key}>
            <Field label="Description" value={line.description} onChangeText={(v) => patchLine(line.key, { description: v })} placeholder="What was delivered" />
            <Row>
              <Field label="Qty" value={line.quantity} onChangeText={(v) => patchLine(line.key, { quantity: v })} keyboardType="decimal-pad" mono style={{ flex: 1 }} error={lt?.quantityValid === false ? 'Qty' : undefined} />
              <Field label="Unit price" value={line.unitPrice} onChangeText={(v) => patchLine(line.key, { unitPrice: v })} keyboardType="decimal-pad" mono style={{ flex: 1.4 }} error={lt?.priceValid === false && line.unitPrice ? 'Price' : undefined} />
            </Row>
            <SelectField label="Cadence" value={line.cadence} options={INVOICE_CADENCES} onChange={(v) => patchLine(line.key, { cadence: v })} compact />
            <Row>
              <Meta mono style={{ flex: 1, color: colors.text }}>{lt?.totalCents != null ? moneyCents(lt.totalCents, draft.currency) : '—'}</Meta>
              <IconButton icon="arrow-up" size="sm" onPress={() => moveLine(i, -1)} disabled={i === 0} accessibilityLabel="Move line up" />
              <IconButton icon="arrow-down" size="sm" onPress={() => moveLine(i, 1)} disabled={i === draft.lines.length - 1} accessibilityLabel="Move line down" />
              <IconButton icon="trash-outline" size="sm" onPress={() => patch({ lines: draft.lines.length > 1 ? draft.lines.filter((l) => l.key !== line.key) : [newLine()] })} accessibilityLabel="Remove line" />
            </Row>
          </Tile>
        );
      })}
      <Button title="+ Line item" size="sm" variant="secondary" onPress={() => patch({ lines: [...draft.lines, newLine()] })} style={{ alignSelf: 'flex-start', marginBottom: SPACE.sm }} accessibilityLabel="Add line item" />

      <Row>
        <Field label="Tax %" value={draft.taxPercent} onChangeText={(v) => patch({ taxPercent: v })} keyboardType="decimal-pad" mono style={{ flex: 1 }} error={totals.taxValid ? undefined : 'Not a number'} />
        <Field label="Tax label" value={draft.taxLabel} onChangeText={(v) => patch({ taxLabel: v })} style={{ flex: 1 }} />
      </Row>
      <StatPairs cols={2} pairs={[
        { label: 'Subtotal', value: moneyCents(totals.subtotalCents, draft.currency) },
        { label: draft.taxLabel || 'Tax', value: moneyCents(totals.taxCents, draft.currency) },
        { label: 'Total', value: moneyCents(totals.totalCents, draft.currency), tone: 'primary' },
        { label: 'Recurring / mo', value: moneyCents(totals.recurringMonthlyCents, draft.currency) },
      ]}
      />
      <Field label="Reference" value={draft.reference} onChangeText={(v) => patch({ reference: v })} placeholder="PO number or project reference" style={{ marginBottom: SPACE.sm }} />
      <Field label="Notes" value={draft.notes} onChangeText={(v) => patch({ notes: v })} multiline rows={3} style={{ marginBottom: SPACE.sm }} />
      <Field label="Terms" value={draft.terms} onChangeText={(v) => patch({ terms: v })} multiline rows={3} style={{ marginBottom: SPACE.sm }} />

      <SelectField label="Payment option" value={draft.paymentAccountId} options={[['', 'No payment option'], ...accounts.map((a) => [a.id, `${a.label}${a.currency ? ` · ${a.currency}` : ''}`])]} onChange={(v) => patch({ paymentAccountId: v })} />
      {draft.paymentAccountId ? (
        <ActionButton title="Delete this payment option" confirm variant="danger" loading={ops.busy === `acct:${draft.paymentAccountId}`} onPress={() => deleteAccount(draft.paymentAccountId)} accessibilityLabel="Delete the selected payment option" />
      ) : null}
      {newAccount ? (
        <Tile>
          <Title>New payment option</Title>
          {[['label', 'Label'], ['currency', 'Currency'], ['bankName', 'Bank name'], ['accountName', 'Account name'], ['accountNumber', 'Account number'], ['iban', 'IBAN'], ['swift', 'SWIFT / BIC'], ['routingNumber', 'Routing number'], ['instructions', 'Instructions']].map(([k, l]) => (
            <Field key={k} label={l} value={newAccount[k]} onChangeText={(v) => setNewAccount((a) => ({ ...a, [k]: v }))} mono={k !== 'label' && k !== 'instructions' && k !== 'bankName' && k !== 'accountName'} multiline={k === 'instructions'} rows={2} />
          ))}
          <Actions>
            <ActionButton title="Save payment option" variant="primary" loading={ops.busy === 'account-save'} onPress={saveAccount} accessibilityLabel="Save payment option" />
            <ActionButton title="Cancel" variant="ghost" onPress={() => setNewAccount(null)} accessibilityLabel="Cancel" />
          </Actions>
        </Tile>
      ) : (
        <Button title="+ Payment option" size="sm" variant="ghost" onPress={() => setNewAccount(emptyPaymentAccount(draft.currency))} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Add a payment option" />
      )}
      {problems.length ? <Meta style={{ marginTop: SPACE.sm }}>{problems.join(' ')}</Meta> : null}
    </BottomSheet>
  );
}
