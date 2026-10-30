/**
 * Payment keys (web renderPaymentCredentialsEditor): the Whop API key
 * (write-only, the gateway returns only a masked hint) and company id used to
 * mint invoice checkout links. agency.ops.payments.provider.get / .set.
 */
import React, { useEffect, useState } from 'react';
import { BottomSheet, Button, Field, SPACE } from '../../../ui-kit';
import { INVOICE_RPC } from './agency-ops-invoice';
import { Meta, Notice } from './ui';

export function PaymentKeysSheet({ ctx, visible, onClose }) {
  const { ops } = ctx;
  const agencyId = ops.state.selectedAgencyId;
  const [status, setStatus] = useState(null);
  const [key, setKey] = useState('');
  const [company, setCompany] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!visible || !agencyId) return;
    setKey(''); setMsg(null);
    ops.req(INVOICE_RPC.providerGet, { agencyId })
      .then((r) => { setStatus(r); setCompany(r?.whopCompanyId ?? ''); })
      .catch((e) => setMsg({ tone: 'danger', text: e?.message || String(e) }));
  }, [visible, agencyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!key.trim() && !company.trim()) { setMsg({ tone: 'warning', text: 'Enter a Whop API key or a company id first.' }); return; }
    const params = { agencyId };
    if (key.trim()) params.whop = key.trim();
    if (company.trim()) params.whopCompanyId = company.trim();
    try {
      const r = await ops.call(INVOICE_RPC.providerSet, params, { busyKey: 'payment-keys', quiet: true });
      setStatus(r); setKey('');
      const ready = r?.whop?.configured && r?.whopCompanyId;
      setMsg({ tone: ready ? 'success' : 'warning', text: ready ? 'Whop keys saved. Payment links can be created now.' : 'Saved. Both the API key and the company id are needed before links can be created.' });
    } catch (e) { setMsg({ tone: 'danger', text: e?.message || String(e) }); }
  };

  const configured = status?.whop?.configured;
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Payment keys"
      subtitle="The Whop API key and company id this machine uses to create checkout links."
      footer={<Button title="Save keys" onPress={save} loading={ops.busy === 'payment-keys'} accessibilityLabel="Save payment keys" />}
    >
      <Meta style={{ marginBottom: SPACE.sm }}>{configured ? `API key on file${status?.whop?.hint ? ` (${status.whop.hint})` : ''}${status?.whop?.fromEnv ? ' · from environment' : ''}.` : 'No Whop API key configured.'}</Meta>
      {msg ? <Notice tone={msg.tone} text={msg.text} /> : null}
      <Field label="Whop API key" value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} mono placeholder={configured ? 'Leave blank to keep the current key' : 'whop_...'} style={{ marginBottom: SPACE.sm }} />
      <Field label="Whop company id" value={company} onChangeText={setCompany} autoCapitalize="none" mono placeholder="biz_..." />
    </BottomSheet>
  );
}
