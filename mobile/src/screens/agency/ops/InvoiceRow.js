/**
 * One invoice in the register / client revenue sheet: totals, Download PDF
 * (agency.ops.invoice.document.render -> poll reports.preview -> share), the
 * Whop payment link (get / create / replace / remove), the payment recorder
 * (any amount, any date, backdating supported) and Void for drafts.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Field, SPACE } from '../../../ui-kit';
import { humanize, invoiceAcceptsPayment, isOverdue, moneyCents, shortDate } from './agency-ops-model';
import { INVOICE_RPC, centsToInput, describePeriod, isoDay, paymentDraftState } from './agency-ops-invoice';
import { shareFile, safeFileName } from './files';
import { Actions, ActionButton, Meta, Notice, Row, Tile, Title } from './ui';
import { Linking } from 'react-native';

const POLL_MS = [1500, 2000, 3000, 4000, 5000];
const POLL_CEILING_MS = 90_000;

export function InvoiceRow({ ctx, invoice, clientName }) {
  const { ops } = ctx;
  const [amount, setAmount] = useState(undefined);
  const [day, setDay] = useState(isoDay());
  const [pdf, setPdf] = useState({ busy: false, message: null, error: null });
  const [link, setLink] = useState({ loaded: false, link: null, busy: false, message: null, error: null });
  const agencyId = ops.state.selectedAgencyId;
  const pay = paymentDraftState(invoice, amount, day);
  const overdue = isOverdue(invoice);
  const status = overdue ? 'overdue' : invoice.status;

  useEffect(() => {
    let alive = true;
    ops.req(INVOICE_RPC.linkGet, { agencyId, invoiceId: invoice.id })
      .then((r) => { if (alive) setLink((l) => ({ ...l, loaded: true, link: r?.link?.url ? r.link : null })); })
      .catch(() => { if (alive) setLink((l) => ({ ...l, loaded: true, unavailable: true })); });
    return () => { alive = false; };
  }, [invoice.id, agencyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadPdf = async () => {
    setPdf({ busy: true, message: 'Rendering the PDF…', error: null });
    try {
      const r = await ops.call(INVOICE_RPC.render, { agencyId, invoiceId: invoice.id }, { quiet: true });
      const reportId = r?.reportId;
      if (!reportId) throw new Error('the render was accepted but no report id came back');
      const started = Date.now();
      for (let i = 0; ; i += 1) {
        await new Promise((res) => setTimeout(res, POLL_MS[Math.min(i, POLL_MS.length - 1)]));
        if (Date.now() - started > POLL_CEILING_MS) throw new Error(`The PDF was queued as report ${reportId} but was still not rendered after ${Math.round((Date.now() - started) / 1000)}s. The report worker may not be running.`);
        let preview = null;
        try { preview = await ops.req('reports.preview', { id: reportId, base64: true }); } catch { preview = null; }
        if (preview?.base64) {
          const how = await shareFile({ base64: preview.base64, name: safeFileName(`${invoice.number} ${clientName || invoice.clientName || ''}`, 'pdf'), mime: 'application/pdf', uti: 'com.adobe.pdf' });
          setPdf({ busy: false, message: how === 'downloaded' ? 'PDF downloaded.' : 'PDF ready to share.', error: null });
          return;
        }
        setPdf((p) => ({ ...p, message: 'Waiting for the report worker…' }));
      }
    } catch (e) {
      ops.addFailure(INVOICE_RPC.render, e);
      setPdf({ busy: false, message: null, error: e?.message || String(e) });
    }
  };

  const linkAction = async (kind) => {
    setLink((l) => ({ ...l, busy: true, error: null, message: kind === 'detach' ? 'Removing the checkout link…' : 'Creating a checkout link at Whop…' }));
    try {
      if (kind === 'detach') {
        await ops.call(INVOICE_RPC.linkDetach, { agencyId, invoiceId: invoice.id }, { quiet: true });
        setLink((l) => ({ ...l, busy: false, link: null, message: 'Payment link removed.' }));
      } else {
        const r = await ops.call(INVOICE_RPC.linkCreate, { agencyId, invoiceId: invoice.id, regenerate: kind === 'replace' }, { quiet: true });
        const next = r?.link?.url ? r.link : null;
        setLink((l) => ({ ...l, busy: false, link: next, error: next ? null : 'Whop accepted the request but returned no checkout URL.', message: next ? (r?.replaced ? 'Replaced the payment link. The previous URL no longer takes payment.' : 'Payment link created.') : null }));
      }
    } catch (e) {
      const text = e?.message || String(e);
      setLink((l) => ({ ...l, busy: false, message: null, error: text, needsCredentials: /api key|credential|company/i.test(text) }));
    }
  };

  const record = async () => {
    if (!pay.amountValid || !pay.dateValid) return;
    try {
      await ops.call(INVOICE_RPC.paymentRecord, {
        agencyId, invoiceId: invoice.id, amountCents: pay.amountCents, amount: pay.amountCents / 100, paidAt: pay.paidAt, method: 'manual',
      }, { busyKey: `pay:${invoice.id}`, reload: true });
      ctx.flash(`Recorded ${moneyCents(pay.amountCents, invoice.currency)} on ${invoice.number}.`);
      setAmount(undefined);
    } catch { /* recorded */ }
  };

  const voidIt = async () => {
    try {
      await ops.call(INVOICE_RPC.voidInvoice, { agencyId, invoiceId: invoice.id }, { busyKey: `void:${invoice.id}`, reload: true });
      ctx.flash(`${invoice.number} voided.`);
    } catch { /* recorded */ }
  };

  return (
    <Tile>
      <Row>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Title>{invoice.number}</Title>
          <Meta numberOfLines={2}>{clientName || invoice.clientName}{invoice.projects?.length ? ` · ${invoice.projects.map((p) => p.projectName).join(', ')}` : ' · Unassigned project'}</Meta>
        </View>
        <Chip label={humanize(status)} size="sm" dot tone={status === 'paid' ? 'success' : overdue ? 'danger' : status === 'draft' ? 'neutral' : 'warning'} />
      </Row>
      <Meta mono>{moneyCents(invoice.totalCents, invoice.currency)} total · {moneyCents(invoice.amountPaidCents, invoice.currency)} paid · {moneyCents(invoice.balanceCents, invoice.currency)} due · {invoice.dueAt ? shortDate(invoice.dueAt) : 'No due date'}</Meta>
      <Actions>
        <ActionButton title={pdf.busy ? 'Rendering' : 'Download PDF'} icon="document-outline" loading={pdf.busy} onPress={downloadPdf} accessibilityLabel={`Download the PDF for invoice ${invoice.number}`} />
        {link.unavailable ? null : link.link ? (
          <>
            <ActionButton title={link.link.label || 'Pay online'} icon="open-outline" onPress={() => Linking.openURL(link.link.url)} accessibilityLabel={`Open the checkout for ${invoice.number}`} />
            <ActionButton title="Copy link" onPress={() => ctx.copy(link.link.url)} accessibilityLabel="Copy payment link" />
            <ActionButton title="Replace" confirm loading={link.busy} onPress={() => linkAction('replace')} accessibilityLabel="Replace the payment link" />
            <ActionButton title="Remove" confirm variant="danger" loading={link.busy} onPress={() => linkAction('detach')} accessibilityLabel="Remove the payment link" />
          </>
        ) : link.loaded && invoice.status !== 'draft' && invoice.balanceCents > 0 ? (
          <ActionButton title={link.busy ? 'Creating' : 'Create payment link'} icon="card-outline" loading={link.busy} onPress={() => linkAction('create')} accessibilityLabel={`Create a Whop payment link for ${invoice.number}`} />
        ) : null}
        {invoice.status === 'draft' ? <ActionButton title="Void" confirm variant="danger" loading={ops.busy === `void:${invoice.id}`} onPress={voidIt} accessibilityLabel={`Void draft ${invoice.number}`} /> : null}
      </Actions>
      {pdf.message ? <Meta>{pdf.message}</Meta> : null}
      {pdf.error ? <Notice tone="danger" text={pdf.error} /> : null}
      {link.message ? <Meta>{link.message}</Meta> : null}
      {link.error ? (
        <Notice tone={link.needsCredentials ? 'warning' : 'danger'} text={link.error}>
          {link.needsCredentials ? <Button title="Add Whop keys" size="sm" variant="secondary" onPress={ctx.openPaymentKeys} accessibilityLabel="Add Whop keys" /> : null}
        </Notice>
      ) : null}
      {invoiceAcceptsPayment(invoice) ? (
        <View style={{ gap: SPACE.xs, marginTop: SPACE.xs }}>
          <Row>
            <Field label={`Amount (${invoice.currency})`} value={pay.text} onChangeText={setAmount} keyboardType="decimal-pad" mono style={{ flex: 1 }} error={!pay.amountValid && pay.text.trim() ? `0.01 – ${centsToInput(invoice.balanceCents)}` : undefined} />
            <Field label="Paid on" value={day} onChangeText={setDay} mono placeholder="YYYY-MM-DD" style={{ flex: 1 }} error={pay.dateValid ? undefined : 'YYYY-MM-DD'} />
          </Row>
          <Actions>
            <ActionButton title="Full balance" variant="ghost" onPress={() => setAmount(centsToInput(invoice.balanceCents))} accessibilityLabel="Set amount to the full balance" />
            <ActionButton title="Today" variant="ghost" onPress={() => setDay(isoDay())} accessibilityLabel="Set payment date to today" />
            <ActionButton
              title={pay.full ? 'Record full payment' : 'Record partial payment'}
              variant="primary"
              loading={ops.busy === `pay:${invoice.id}`}
              disabled={!pay.amountValid || !pay.dateValid}
              onPress={record}
              accessibilityLabel={`Record a payment against ${invoice.number}`}
            />
          </Actions>
          {pay.backdated && pay.dateValid ? <Meta>Backdated to {describePeriod(day)}</Meta> : null}
        </View>
      ) : null}
    </Tile>
  );
}
