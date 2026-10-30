/**
 * Clients & revenue — web renderFinanceOperations: invoice actions, KPIs, the
 * client directory (premium cards or pipeline kanban with per-card status
 * move), invoice parser (paste text / JSON, relate to client + project, review
 * & confirm), Finance AI controls, 12-month revenue movement, revenue
 * relationships, invoice register (PDF, payment link, payments, void) and the
 * revenue ledger.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, useWindowDimensions } from 'react-native';
import { Button, Chip, Field, SegmentedControl, SPACE, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import {
  clientKanbanColumns,
  clientsByPipeline,
  collectionRate,
  filterClients,
  financeEmployeeWork,
  financeKpis,
  humanize,
  money,
  moneyCents,
  shortDate,
  titleCase,
} from './agency-ops-model';
import { INVOICE_RPC } from './agency-ops-invoice';
import { InvoiceRow } from './InvoiceRow';
import { Actions, ActionButton, Avatar, Empty, KpiGrid, Meta, MoreButton, Notice, Panel, Row, SelectField, Tile, Title, useCols } from './ui';

export function FinanceTab({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const currency = s.revenue?.currency ?? s.finance.currency;
  const sync = s.clientSync;
  const [view, setView] = useState('grid');
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => filterClients(s.clients, search), [s.clients, search]);
  return (
    <View>
      <Panel
        eyebrow="Finance operations"
        title="Clients, invoices and recurring revenue"
        subtitle="Write an invoice, backdate one you already sent, or import a document. The agency ledger, receivables, revenue and MRR all move together."
      >
        <Actions>
          <Button title="+ New invoice" size="sm" onPress={() => ctx.openInvoiceComposer({})} accessibilityLabel="Create a new invoice" />
          <Button title="Backlog past invoice" size="sm" variant="secondary" onPress={() => ctx.openInvoiceComposer({ backdated: true })} accessibilityLabel="Record a historical invoice" />
          <Button title="Payment keys" size="sm" variant="secondary" icon="key-outline" onPress={ctx.openPaymentKeys} accessibilityLabel="Edit the Whop API key and company id used for payment links" />
          <Button title="+ Client" size="sm" variant="secondary" onPress={() => ctx.openDialog('client')} accessibilityLabel="Add client" />
          {sync?.connected ? (
            <Button title="Sync shared data" size="sm" variant="secondary" loading={ops.busy === 'replication-sync'} onPress={() => ops.call('agency.ops.replication.sync', { agencyId: s.selectedAgencyId }, { busyKey: 'replication-sync', reload: true }).catch(() => {})} accessibilityLabel="Sync shared data" />
          ) : null}
        </Actions>
      </Panel>
      <KpiGrid items={financeKpis(s)} />
      <Panel
        title="Client directory"
        subtitle={sync?.connected ? `${sync.databaseName ?? 'Connected CRM'} · ${sync.lastSync ? `synced ${shortDate(sync.lastSync)}` : 'ready to sync'}` : 'Agency-native client records'}
        count={s.clients.length}
      >
        <Field value={search} onChangeText={setSearch} placeholder="Search clients or email" icon="search" style={{ marginBottom: SPACE.sm }} accessibilityLabel="Search clients" />
        <SegmentedControl options={[{ key: 'grid', label: 'Cards' }, { key: 'kanban', label: 'Kanban' }]} value={view} onChange={setView} style={{ marginBottom: SPACE.sm }} testID="aops-client-view" />
        {filtered.length ? (view === 'kanban' ? <ClientKanban ctx={ctx} clients={filtered} currency={currency} /> : <ClientGrid ctx={ctx} clients={filtered} currency={currency} />)
          : <Empty icon="people-outline" text={search ? 'No clients match this search.' : sync?.connected ? 'No clients are stored yet. Sync the connected CRM.' : 'Create the first agency client.'} />}
      </Panel>
      <InvoiceParser ctx={ctx} currency={currency} />
      <FinanceAi ctx={ctx} />
      <RevenueTrend revenue={s.revenue} currency={currency} />
      <RevenueRelationships revenue={s.revenue} currency={currency} />
      <InvoiceRegister ctx={ctx} />
      <RevenueLedger entries={s.revenueEntries} />
    </View>
  );
}

function ClientCard({ ctx, client, currency }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const statusLabel = client.pipelineStatusLabel ?? titleCase(client.status);
  const billing = client.billingEmail ?? client.email ?? null;
  const busy = ops.busy === `client:${client.id}`;
  const socials = ['whatsapp', 'telegram', 'discord', 'instagram'].filter((k) => String(client[k] ?? '').trim());
  return (
    <Tile onPress={() => ctx.openClient(client.id)} accessibilityLabel={`Open the profile for ${client.name}`}>
      <Row>
        <Avatar name={client.name} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Title numberOfLines={1}>{client.name}</Title>
          <Meta numberOfLines={1}>{billing ?? client.phone ?? 'No contact details yet'}</Meta>
        </View>
        <Chip label={statusLabel} size="sm" tone={client.status === 'active' ? 'success' : client.status === 'inactive' ? 'neutral' : 'primary'} />
      </Row>
      {socials.length ? <Meta>{socials.map((k) => titleCase(k)).join(' · ')}</Meta> : null}
      <Row wrap>
        <Meta mono>{client.projectCount ?? 0} proj</Meta>
        <Meta mono>{client.invoiceCount ?? 0} inv</Meta>
        <Meta mono>{money((client.mrrCents ?? 0) / 100, currency)} MRR</Meta>
      </Row>
      <Row wrap>
        <Text style={[type.monoSmall, { color: colors.success }]}>{money((client.lifetimeInvoicedCents ?? 0) / 100, currency)} billed</Text>
        <Text style={[type.monoSmall, { color: client.outstandingCents > 0 ? colors.warning : colors.textMuted }]}>{moneyCents(client.outstandingCents ?? 0, currency)} outstanding</Text>
      </Row>
      <Actions>
        <ActionButton title="Profile" onPress={() => ctx.openClient(client.id)} accessibilityLabel={`Open the profile for ${client.name}`} />
        <ActionButton title="Projects" onPress={() => ctx.focusClientProjects(client.id)} accessibilityLabel={`Open projects for ${client.name}`} />
        <ActionButton title="Revenue" onPress={() => ctx.openClientRevenue(client.id)} accessibilityLabel={`Open revenue for ${client.name}`} />
        <ActionButton title="Edit" onPress={() => ctx.openDialog('client-edit', { entityId: client.id })} accessibilityLabel={`Edit ${client.name}`} />
        <ActionButton
          title={client.status === 'active' ? 'Archive' : 'Activate'}
          loading={busy}
          onPress={() => ctx.setClientStatus(client.id, client.status === 'active' ? 'inactive' : 'active')}
          accessibilityLabel={`${client.status === 'active' ? 'Archive' : 'Activate'} ${client.name}`}
        />
      </Actions>
    </Tile>
  );
}

function ClientGrid({ ctx, clients, currency }) {
  const cols = useCols(1, 2, 640);
  const [limit, setLimit] = useState(20);
  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -SPACE.xs }}>
        {clients.slice(0, limit).map((c) => (
          <View key={c.id} style={{ width: `${100 / cols}%`, paddingHorizontal: SPACE.xs }}>
            <ClientCard ctx={ctx} client={c} currency={currency} />
          </View>
        ))}
      </View>
      <MoreButton shown={Math.min(limit, clients.length)} total={clients.length} onPress={() => setLimit((l) => l + 20)} noun="clients" />
    </View>
  );
}

function ClientKanban({ ctx, clients, currency }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const columns = clientKanbanColumns(ops.state);
  const byCol = clientsByPipeline(ops.state, clients);
  const options = columns.map((l) => [l, l]);
  const [limits, setLimits] = useState({});
  const colWidth = Math.min(300, Math.max(250, width * 0.74));
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.sm }} testID="aops-client-kanban">
        {columns.map((label) => {
          const list = byCol.get(label.toLowerCase()) ?? [];
          const limit = limits[label] ?? 12;
          return (
            <View key={label} style={{ width: colWidth, borderWidth: 1, borderColor: colors.borderSubtle, borderLeftWidth: 3, borderLeftColor: withAlpha(colors.primary, 0.7), borderRadius: 14, padding: SPACE.sm, backgroundColor: withAlpha(colors.text, 0.03) }}>
              <Row style={{ marginBottom: SPACE.sm }}>
                <Text style={[type.label, { color: colors.primary, flex: 1 }]}>{label}</Text>
                <Chip label={String(list.length)} size="sm" />
              </Row>
              {list.slice(0, limit).map((c) => (
                <Tile key={c.id} onPress={() => ctx.openClient(c.id)} accessibilityLabel={`Open ${c.name}`}>
                  <Row>
                    <Avatar name={c.name} size={30} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Title numberOfLines={1}>{c.name}</Title>
                      <Meta numberOfLines={1}>{c.billingEmail ?? 'No billing email'}</Meta>
                    </View>
                  </Row>
                  <Meta mono>{c.projectCount ?? 0} proj · {c.invoiceCount ?? 0} inv · {money((c.mrrCents ?? 0) / 100, currency)} MRR</Meta>
                  <Meta mono style={c.outstandingCents > 0 ? { color: colors.warning } : null}>{moneyCents(c.outstandingCents ?? 0, currency)} outstanding</Meta>
                  <SelectField value={c.pipelineStatusLabel ?? c.pipelineStatus ?? 'Cold'} options={options} onChange={(v) => ctx.setClientPipeline(c.id, v)} compact />
                </Tile>
              ))}
              {!list.length ? <Meta style={{ padding: SPACE.sm }}>No clients in {label}.</Meta> : null}
              <MoreButton shown={Math.min(limit, list.length)} total={list.length} onPress={() => setLimits((l) => ({ ...l, [label]: limit + 12 }))} noun="clients" />
            </View>
          );
        })}
      </ScrollView>
      <Meta>Move a client between pipeline columns with the status picker on its card, or tap a card to open its full profile. Changes persist to the agency database.</Meta>
    </View>
  );
}

function InvoiceParser({ ctx, currency }) {
  const { ops } = ctx;
  const s = ops.state;
  const [text, setText] = useState('');
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const ingest = async (confirmWarnings) => {
    setError(null);
    try {
      const r = await ops.call(INVOICE_RPC.ingest, {
        agencyId: s.selectedAgencyId, sourceText: text || undefined, sourceName: 'pasted-invoice', confirmWarnings,
        projectId: projectId || undefined, clientId: clientId || undefined,
      }, { busyKey: 'invoice-ingest', quiet: true });
      if (r?.requiresConfirmation) { setPreview(r.parsed ?? {}); return; }
      setText(''); setPreview(null);
      ctx.flash(r?.result?.duplicate ? 'That invoice was already imported.' : 'Invoice imported.');
      ops.load({ background: true });
    } catch (e) { setError(e?.message || String(e)); ops.addFailure(INVOICE_RPC.ingest, e); }
  };
  return (
    <Panel title="Invoice parser" subtitle="Paste an invoice's extracted text or structured JSON. PDF upload is available on the web page.">
      <SelectField label="Relate to client" value={clientId} options={[['', 'Auto-match from invoice'], ...s.clients.map((c) => [c.id, c.name])]} onChange={setClientId} searchable />
      <SelectField label="Relate to project" value={projectId} options={[['', 'Auto-match from invoice'], ...s.projects.map((p) => [p.id, `${p.name} · ${humanize(p.status)}`])]} onChange={setProjectId} searchable />
      <Meta style={{ marginBottom: SPACE.sm }}>Client is matched or created from the invoice; project stays operator-selectable.</Meta>
      <Field label="Paste invoice text or structured JSON" value={text} onChangeText={setText} multiline rows={6} placeholder={'Invoice #: INV-1001\nBill To: Client name\nBilling interval: monthly\nTotal: $2,500'} />
      <Actions style={{ marginTop: SPACE.sm }}>
        <Button title="Parse & import" size="sm" loading={ops.busy === 'invoice-ingest'} disabled={!text.trim()} onPress={() => ingest(false)} accessibilityLabel="Parse and import the invoice" />
        <Button title="Clear" size="sm" variant="ghost" onPress={() => { setText(''); setPreview(null); setError(null); }} accessibilityLabel="Clear the invoice draft" />
      </Actions>
      {error ? <Notice tone="danger" text={error} style={{ marginTop: SPACE.sm }} /> : null}
      {preview ? (
        <Notice tone="warning" title={`Review required: ${preview.invoiceNumber ?? 'Unknown invoice'} · ${preview.clientName ?? 'Unknown client'}`} text={`${money((preview.totalCents ?? 0) / 100, currency)} total · ${money((preview.recurringMonthlyCents ?? 0) / 100, currency)} MRR · ${Math.round((preview.confidence ?? 0) * 100)}% confidence${preview.warnings?.length ? ` · ${preview.warnings.join(' ')}` : ''}`} style={{ marginTop: SPACE.sm }}>
          {(preview.lineItems || []).map((li, i) => <Meta key={i}>{li.description} · {humanize(li.cadence)} · {money(li.totalCents / 100, currency)}</Meta>)}
          <Button title="Confirm import" size="sm" onPress={() => ingest(true)} loading={ops.busy === 'invoice-ingest'} style={{ alignSelf: 'flex-start', marginTop: SPACE.xs }} accessibilityLabel="Confirm import" />
        </Notice>
      ) : null}
    </Panel>
  );
}

function FinanceAi({ ctx }) {
  const s = ctx.ops.state;
  const { employee, work } = financeEmployeeWork(s);
  return (
    <Panel title="Finance AI controls" subtitle={employee ? `${employee.name} monitors invoice exceptions and reconciliation.` : 'Add the Finance AI employee to enable exception triage.'}>
      <Row><View style={{ flex: 1 }}><Title>Collection rate</Title><Meta>Current reporting period</Meta></View><Meta mono>{collectionRate(s.revenue)}%</Meta></Row>
      <Row style={{ marginTop: SPACE.sm }}><View style={{ flex: 1 }}><Title>Review queue</Title><Meta>Needs finance or operator attention</Meta></View><Meta mono>{work.length}</Meta></Row>
      {work.length ? work.slice(0, 4).map((i) => <Notice key={i.id} tone="warning" title={i.title} text={`${humanize(i.status)} · ${i.priority}`} style={{ marginTop: SPACE.sm }} />) : <Meta style={{ marginTop: SPACE.sm }}>No unresolved finance exceptions.</Meta>}
    </Panel>
  );
}

function RevenueTrend({ revenue, currency }) {
  const { colors, type } = useUIKit();
  const trend = revenue?.trend ?? [];
  const max = Math.max(1, ...trend.flatMap((p) => [p.invoicedCents, p.collectedCents]));
  const H = 120;
  return (
    <Panel title="12-month revenue movement">
      {trend.length ? (
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H + 24, gap: 6 }} accessibilityLabel="Invoiced and collected revenue by month">
            {trend.map((p) => (
              <View key={p.month} style={{ flex: 1, alignItems: 'center' }}>
                <View style={{ height: H, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
                  <View style={{ width: 9, height: Math.max(2, Math.round((p.invoicedCents / max) * H)), backgroundColor: colors.primary, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
                  <View style={{ width: 9, height: Math.max(2, Math.round((p.collectedCents / max) * H)), backgroundColor: colors.success, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
                </View>
                <Text style={[type.caption, { color: colors.textMuted, marginTop: 4 }]}>{p.month.slice(5)}</Text>
              </View>
            ))}
          </View>
          <Row style={{ marginTop: SPACE.sm }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors.primary }} /><Meta>Invoiced</Meta>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors.success, marginLeft: SPACE.sm }} /><Meta>Collected</Meta>
          </Row>
          {trend.map((p) => <Meta key={`l-${p.month}`} mono>{p.month}: {money(p.invoicedCents / 100, currency)} invoiced · {money(p.collectedCents / 100, currency)} collected</Meta>)}
        </View>
      ) : <Empty icon="bar-chart-outline" text="Revenue history appears after the first imported invoice." />}
    </Panel>
  );
}

function RevenueRelationships({ revenue, currency }) {
  const byClient = revenue?.revenueByClient ?? [];
  const byProject = revenue?.revenueByProject ?? [];
  return (
    <Panel title="Revenue relationships">
      {byClient.length ? byClient.map((r) => (
        <Row key={r.clientId} style={{ marginBottom: SPACE.sm }}>
          <View style={{ flex: 1 }}><Title numberOfLines={1}>{r.clientName}</Title><Meta mono>{money(r.mrrCents / 100, currency)} MRR</Meta></View>
          <View style={{ alignItems: 'flex-end' }}><Meta mono>{money(r.invoicedCents / 100, currency)}</Meta><Meta mono>{money(r.collectedCents / 100, currency)} collected</Meta></View>
        </Row>
      )) : <Empty icon="git-branch-outline" text="No client revenue recorded yet. Import the first invoice." />}
      {byProject.length ? (
        <View style={{ marginTop: SPACE.sm }}>
          <Title>By project</Title>
          {byProject.map((r) => (
            <Row key={r.projectId ?? r.projectName} style={{ marginTop: SPACE.xs }}>
              <View style={{ flex: 1 }}><Meta numberOfLines={1}>{r.projectName}</Meta></View>
              <Meta mono>{money(r.invoicedCents / 100, currency)} · {money(r.collectedCents / 100, currency)} collected</Meta>
            </Row>
          ))}
        </View>
      ) : null}
    </Panel>
  );
}

function InvoiceRegister({ ctx }) {
  const s = ctx.ops.state;
  const [limit, setLimit] = useState(10);
  const failed = s.failures.some((f) => f.startsWith('agency.ops.invoices.list'));
  return (
    <Panel title="Invoice register" count={s.invoices.length}>
      {s.invoices.length ? s.invoices.slice(0, limit).map((inv) => <InvoiceRow key={inv.id} ctx={ctx} invoice={inv} />)
        : failed ? <Notice tone="warning" text="The invoice register could not be loaded — see the failed-request banner above. This is not an empty ledger." />
          : <Empty icon="receipt-outline" text="No invoices stored yet. Use + New invoice to raise one, or Backlog past invoice to record invoices you have already sent." />}
      <MoreButton shown={Math.min(limit, s.invoices.length)} total={s.invoices.length} onPress={() => setLimit((l) => l + 10)} noun="invoices" />
    </Panel>
  );
}

function RevenueLedger({ entries }) {
  const [limit, setLimit] = useState(10);
  return (
    <Panel title="Revenue ledger" count={entries.length}>
      {entries.length ? entries.slice(0, limit).map((e) => (
        <Tile key={e.id}>
          <Row>
            <View style={{ flex: 1 }}><Title>{e.description}</Title><Meta>{shortDate(e.recognizedAt)} · {humanize(e.sourceType)}</Meta></View>
            <Meta mono>{moneyCents(e.amountCents, e.currency)}</Meta>
          </Row>
          {e.recurringMonthlyCents > 0 ? <Meta mono>{moneyCents(e.recurringMonthlyCents, e.currency)} recurring monthly</Meta> : null}
        </Tile>
      )) : <Empty icon="list-outline" text="No revenue entries recorded." />}
      <MoreButton shown={Math.min(limit, entries.length)} total={entries.length} onPress={() => setLimit((l) => l + 10)} noun="entries" />
    </Panel>
  );
}
