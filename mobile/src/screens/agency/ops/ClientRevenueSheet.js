/**
 * Client revenue (web renderClientRevenuePanel): every invoice raised against
 * the client (agency.ops.relations.client, falling back to the loaded
 * register), invoiced / collected / outstanding / overdue, client + per-project
 * MRR (client.mrr.set / project.mrr.set) and each invoice's full controls.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { BottomSheet, Button, Field, SPACE } from '../../../ui-kit';
import { moneyCents, summarizeClientInvoices } from './agency-ops-model';
import { INVOICE_RPC, centsToInput, parseCents } from './agency-ops-invoice';
import { InvoiceRow } from './InvoiceRow';
import { ActionButton, Empty, Meta, Notice, Row, StatPairs, Title } from './ui';

function MrrEditor({ label, cents, currency, busy, onSave }) {
  const [text, setText] = useState(centsToInput(cents ?? 0));
  useEffect(() => { setText(centsToInput(cents ?? 0)); }, [cents]);
  const parsed = parseCents(text);
  return (
    <View style={{ marginBottom: SPACE.sm }}>
      <Row>
        <Field label={label} value={text} onChangeText={setText} keyboardType="decimal-pad" mono style={{ flex: 1 }} error={parsed === null || parsed < 0 ? 'Enter an amount' : undefined} />
        <ActionButton title="Save" loading={busy} disabled={parsed === null || parsed < 0} onPress={() => onSave(parsed)} accessibilityLabel={`Save ${label}`} />
      </Row>
      <Meta mono>{moneyCents((parsed ?? 0) * 12, currency)} ARR</Meta>
    </View>
  );
}

export function ClientRevenueSheet({ ctx, clientId, onClose }) {
  const { ops } = ctx;
  const s = ops.state;
  const record = s.clients.find((c) => c.id === clientId);
  const [detail, setDetail] = useState({ loading: false, invoices: null, error: null });
  const currency = s.revenue?.currency ?? s.finance.currency ?? 'USD';

  const load = useCallback(async () => {
    if (!clientId) return;
    setDetail((d) => ({ ...d, loading: true }));
    try {
      const r = await ops.req(INVOICE_RPC.relationsClient, { agencyId: s.selectedAgencyId, clientId });
      setDetail({ loading: false, invoices: Array.isArray(r?.invoices) ? r.invoices : [], error: null });
    } catch (e) {
      setDetail({ loading: false, invoices: s.invoices.filter((i) => i.clientId === clientId), error: e?.message || String(e) });
    }
  }, [ops, clientId, s.selectedAgencyId, s.invoices]);
  useEffect(() => { if (clientId) load(); }, [clientId, s.invoices]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!clientId) return <BottomSheet visible={false} onClose={onClose} title="" />;
  const invoices = (detail.invoices ?? []).map((i) => ({ balanceCents: (i.totalCents ?? 0) - (i.amountPaidCents ?? 0), ...i }));
  const sum = summarizeClientInvoices(invoices);
  const projects = s.projects.filter((p) => p.clientId === clientId && !p.mirrored);

  const saveClientMrr = async (cents) => {
    try { await ops.call(INVOICE_RPC.clientMrr, { agencyId: s.selectedAgencyId, clientId, mrrCents: cents }, { busyKey: `mrr:client:${clientId}`, reload: true }); ctx.flash('Client MRR saved.'); } catch { /* recorded */ }
  };
  const saveProjectMrr = async (projectId, cents) => {
    try { await ops.call(INVOICE_RPC.projectMrr, { agencyId: s.selectedAgencyId, projectId, mrrCents: cents }, { busyKey: `mrr:project:${projectId}`, reload: true }); ctx.flash('Project MRR saved.'); } catch { /* recorded */ }
  };

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={record?.name ?? 'Client'}
      subtitle="Every invoice raised against this client, and what has actually been collected."
      maxHeightRatio={0.94}
      headerRight={<Button title="+ Invoice" size="sm" onPress={() => ctx.openInvoiceComposer({ clientId })} accessibilityLabel="Invoice this client" />}
    >
      {detail.error ? <Notice tone="warning" title="agency.ops.relations.client failed." text={`${detail.error} The invoices below come from the register already loaded on this page, so they may be incomplete.`} /> : null}
      <Title>Recurring revenue</Title>
      <Meta style={{ marginBottom: SPACE.sm }}>Set monthly recurring revenue directly. ARR is derived as MRR x 12.</Meta>
      <MrrEditor label="Client MRR" cents={record?.mrrCents ?? 0} currency={currency} busy={ops.busy === `mrr:client:${clientId}`} onSave={saveClientMrr} />
      {projects.map((p) => (
        <MrrEditor key={p.id} label={`${p.name} MRR`} cents={p.mrrCents ?? 0} currency={currency} busy={ops.busy === `mrr:project:${p.id}`} onSave={(c) => saveProjectMrr(p.id, c)} />
      ))}
      {detail.loading && !detail.invoices ? <Meta>Loading revenue…</Meta> : (
        <>
          <StatPairs cols={2} pairs={[
            { label: 'Invoiced', value: moneyCents(sum.invoicedCents, currency) },
            { label: 'Collected', value: moneyCents(sum.collectedCents, currency), tone: 'success' },
            { label: 'Outstanding', value: moneyCents(sum.outstandingCents, currency), tone: sum.outstandingCents ? 'warning' : undefined },
            { label: 'Overdue', value: moneyCents(sum.overdueCents, currency), tone: sum.overdueCents ? 'danger' : undefined },
          ]}
          />
          <Meta style={{ marginBottom: SPACE.sm }}>{invoices.length} invoices · {sum.paidCount} paid in full · {sum.openCount} open · {sum.overdueCount} past due</Meta>
          {invoices.length ? invoices.map((inv) => <InvoiceRow key={inv.id} ctx={ctx} invoice={inv} clientName={record?.name} />)
            : <Empty icon="receipt-outline" text="This client has no invoices yet. Use + Invoice above to raise the first one, or backdate the invoices they were already sent." />}
        </>
      )}
    </BottomSheet>
  );
}
