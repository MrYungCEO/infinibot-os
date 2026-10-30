/**
 * agency-ops-invoice — integer-money invoice composer logic, ported 1:1 from the
 * web controller (ui/src/ui/controllers/agency-invoicing.ts). All money is
 * integer cents parsed from text by string manipulation, never floats.
 *
 * Pure — unit tested in src/__tests__/agency-ops-invoice.test.js.
 */

export const INVOICE_CADENCES = [
  ['one_time', 'One time'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['annual', 'Annual'],
];

/** Live gateway method names (singular; the web resolves the same names first). */
export const INVOICE_RPC = {
  create: 'agency.ops.invoice.create',
  issue: 'agency.ops.invoice.issue',
  voidInvoice: 'agency.ops.invoice.void',
  backlog: 'agency.ops.invoice.backlog.record',
  numberNext: 'agency.ops.invoice.number.next',
  render: 'agency.ops.invoice.document.render',
  paymentRecord: 'agency.ops.invoices.payment.record',
  linkGet: 'agency.ops.invoice.paymentLink.get',
  linkCreate: 'agency.ops.invoice.paymentLink.create',
  linkDetach: 'agency.ops.invoice.paymentLink.detach',
  accountsList: 'agency.ops.payment-accounts.list',
  accountsUpsert: 'agency.ops.payment-accounts.upsert',
  accountsDelete: 'agency.ops.payment-accounts.delete',
  providerGet: 'agency.ops.payments.provider.get',
  providerSet: 'agency.ops.payments.provider.set',
  ingest: 'agency.ops.invoices.ingest',
  relationsClient: 'agency.ops.relations.client',
  clientMrr: 'agency.ops.client.mrr.set',
  projectMrr: 'agency.ops.project.mrr.set',
};

export function parseScaled(raw, decimals) {
  const text = String(raw ?? '').trim().replace(/[\s,_]/g, '');
  if (!text) return null;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (!whole && !frac) return null;
  if (frac.length > decimals) return null;
  const padded = `${frac}${'0'.repeat(decimals)}`.slice(0, decimals);
  const value = Number(`${whole || '0'}${padded}`);
  if (!Number.isSafeInteger(value)) return null;
  return sign * value;
}

export const parseCents = (raw) => parseScaled(raw, 2);

export function centsToInput(cents) {
  const negative = cents < 0;
  const digits = String(Math.abs(Math.trunc(cents || 0))).padStart(3, '0');
  const text = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return negative ? `-${text}` : text;
}

export function isoDay(value = Date.now()) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayToTimestamp(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? '').trim());
  if (!match) return null;
  const value = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0).getTime();
  return Number.isFinite(value) ? value : null;
}

export function shiftDay(day, days) {
  const base = dayToTimestamp(day) ?? Date.now();
  return isoDay(base + days * 86_400_000);
}

export function endOfMonthsAgo(offset, now = new Date()) {
  return isoDay(new Date(now.getFullYear(), now.getMonth() - offset + 1, 0, 12).getTime());
}

export function isBackdated(day, now = Date.now()) {
  const value = dayToTimestamp(day);
  return value !== null && value < dayToTimestamp(isoDay(now));
}

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function describePeriod(day) {
  const value = dayToTimestamp(day);
  if (value === null) return 'an unknown period';
  const d = new Date(value);
  return `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

let lineSeq = 0;
export function newLine() {
  lineSeq += 1;
  return { key: `l${Date.now().toString(36)}${lineSeq}`, description: '', quantity: '1', unitPrice: '', cadence: 'one_time' };
}

export function monthlyEquivalent(totalCents, cadence) {
  if (cadence === 'monthly') return totalCents;
  if (cadence === 'quarterly') return Math.round(totalCents / 3);
  if (cadence === 'annual') return Math.round(totalCents / 12);
  return 0;
}

export function computeInvoiceTotals(lines, taxPercent) {
  const results = [];
  let subtotalCents = 0; let recurringMonthlyCents = 0; let invalidLines = 0; let billableLines = 0;
  for (const line of lines || []) {
    const quantity = parseScaled(line.quantity, 3);
    const price = parseCents(line.unitPrice);
    const quantityValid = quantity !== null && quantity >= 0;
    const priceValid = price !== null;
    const touched = line.description.trim().length > 0 || line.unitPrice.trim().length > 0 || line.quantity.trim() !== '1';
    if (!quantityValid || !priceValid) {
      results.push({ key: line.key, totalCents: null, quantityValid, priceValid });
      if (touched) invalidLines += 1;
      continue;
    }
    const totalCents = Math.round((quantity * price) / 1000);
    results.push({ key: line.key, totalCents, quantityValid: true, priceValid: true });
    subtotalCents += totalCents;
    recurringMonthlyCents += monthlyEquivalent(totalCents, line.cadence);
    if (line.description.trim()) billableLines += 1;
    else if (touched) invalidLines += 1;
  }
  const taxBasisPoints = parseScaled(taxPercent || '0', 2);
  const taxValid = taxBasisPoints !== null && taxBasisPoints >= 0;
  const taxCents = taxValid ? Math.round((subtotalCents * taxBasisPoints) / 10_000) : 0;
  return { lines: results, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, recurringMonthlyCents, taxValid, invalidLines, billableLines };
}

export function invoiceDraftProblems(draft, totals) {
  const problems = [];
  if (!draft.clientId) problems.push('Choose the client this invoice bills.');
  if (!draft.number.trim()) problems.push('Give the invoice a number.');
  if (totals.billableLines === 0) problems.push('Add at least one described line item.');
  if (totals.invalidLines > 0) {
    problems.push(`${totals.invalidLines} line item${totals.invalidLines === 1 ? '' : 's'} ${totals.invalidLines === 1 ? 'has' : 'have'} a description, quantity or price that does not parse.`);
  }
  if (!totals.taxValid) problems.push('Tax percentage is not a number.');
  if (totals.totalCents <= 0) problems.push('Invoice total must be greater than zero.');
  if (dayToTimestamp(draft.issueDate) === null) problems.push('Issue date is not a valid date.');
  if (draft.dueDate && dayToTimestamp(draft.dueDate) === null) problems.push('Due date is not a valid date.');
  const issuedAt = dayToTimestamp(draft.issueDate);
  const dueAt = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
  if (issuedAt !== null && dueAt !== null && dueAt < issuedAt) problems.push('Due date is before the issue date.');
  return problems;
}

export function suggestInvoiceNumber(invoices, year = new Date().getFullYear()) {
  let highest = 0;
  for (const inv of invoices || []) {
    const match = /(\d+)\s*$/.exec(inv.number ?? '');
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `INV-${year}-${String(highest + 1).padStart(4, '0')}`;
}

/** Fresh composer draft (web openInvoiceComposer). */
export function createInvoiceDraft({ invoices = [], currency = 'USD', clientId = '', backdated = false } = {}) {
  const today = isoDay();
  const draft = {
    number: suggestInvoiceNumber(invoices),
    clientId,
    projectId: '',
    currency: currency || 'USD',
    issueDate: today,
    dueDate: shiftDay(today, 30),
    taxPercent: '0',
    taxLabel: 'Tax',
    reference: '',
    notes: '',
    terms: 'Payment is due by the date shown above. Please quote the invoice number on the remittance.',
    paymentAccountId: '',
    lines: [newLine()],
    paidAmount: '',
    paidDate: today,
    backdatedMode: backdated,
  };
  if (backdated) {
    draft.issueDate = endOfMonthsAgo(1);
    draft.dueDate = shiftDay(draft.issueDate, 30);
    draft.paidDate = draft.issueDate;
  }
  return draft;
}

/** Changing the issue date keeps the same net terms (web setInvoiceIssueDate). */
export function withIssueDate(draft, day) {
  const prevIssue = dayToTimestamp(draft.issueDate);
  const prevDue = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
  const next = { ...draft, issueDate: day, paidDate: day };
  if (prevIssue !== null && prevDue !== null && dayToTimestamp(day) !== null) {
    next.dueDate = shiftDay(day, Math.round((prevDue - prevIssue) / 86_400_000));
  }
  return next;
}

export function nativeInvoicePayload(draft, totals, agencyId) {
  const lineItems = draft.lines
    .map((line, index) => ({ line, computed: totals.lines[index] }))
    .filter(({ line, computed }) => computed?.totalCents !== null && computed !== undefined && line.description.trim())
    .map(({ line }) => ({
      description: line.description.trim(),
      quantity: (parseScaled(line.quantity, 3) ?? 1000) / 1000,
      unitPriceCents: parseCents(line.unitPrice) ?? 0,
      cadence: line.cadence,
    }));
  const dueAt = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
  return {
    agencyId,
    clientId: draft.clientId,
    projectIds: draft.projectId ? [draft.projectId] : [],
    number: draft.number.trim() || undefined,
    currency: draft.currency.trim().toUpperCase() || 'USD',
    issuedAt: dayToTimestamp(draft.issueDate) ?? undefined,
    dueAt: dueAt ?? undefined,
    taxCents: totals.taxCents,
    taxLabel: draft.taxLabel.trim() || undefined,
    reference: draft.reference.trim() || undefined,
    notes: draft.notes.trim() || undefined,
    terms: draft.terms.trim() || undefined,
    paymentAccountId: draft.paymentAccountId || undefined,
    lineItems,
  };
}

export function backlogPayments(draft, totals) {
  const amountCents = parseCents(draft.paidAmount);
  const paidAt = dayToTimestamp(draft.paidDate);
  if (amountCents === null || amountCents <= 0 || paidAt === null) return [];
  return [{ amountCents: Math.min(amountCents, totals.totalCents), paidAt, method: 'historical' }];
}

/**
 * Plan the save: which RPC(s) to call. A backdated issue goes through the
 * backlog recorder (with any historical payment), otherwise create (+ issue).
 */
export function planInvoiceSave(draft, totals, agencyId, { issue }) {
  const backdated = isBackdated(draft.issueDate);
  const payload = nativeInvoicePayload(draft, totals, agencyId);
  if (backdated && issue) {
    return { mode: 'backlog', create: [INVOICE_RPC.backlog, { ...payload, payments: backlogPayments(draft, totals) }], issue: null, backdated };
  }
  return {
    mode: 'create',
    create: [INVOICE_RPC.create, payload],
    issue: issue ? { issuedAt: dayToTimestamp(draft.issueDate) ?? undefined, dueAt: draft.dueDate ? (dayToTimestamp(draft.dueDate) ?? undefined) : undefined } : null,
    backdated,
  };
}

/** Pull the created invoice id out of whichever envelope the RPC used. */
export function readInvoiceId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id === 'string') return value.id;
  for (const key of ['invoice', 'result', 'created']) {
    const nested = value[key];
    if (nested && typeof nested === 'object') {
      if (typeof nested.id === 'string') return nested.id;
      if (nested.invoice && typeof nested.invoice.id === 'string') return nested.invoice.id;
    }
  }
  return null;
}

/** Payment control validation (web renderInvoicePaymentControls). */
export function paymentDraftState(invoice, amountText, day) {
  const balance = Number(invoice?.balanceCents) || 0;
  const text = amountText ?? centsToInput(balance);
  const amountCents = parseCents(text);
  const amountValid = amountCents !== null && amountCents > 0 && amountCents <= balance;
  const paidAt = dayToTimestamp(day);
  return { text, amountCents, amountValid, paidAt, dateValid: paidAt !== null, full: amountValid && amountCents === balance, backdated: isBackdated(day) };
}

export function emptyPaymentAccount(currency = '') {
  return { label: '', currency, bankName: '', accountName: '', accountNumber: '', iban: '', swift: '', routingNumber: '', instructions: '' };
}

export function paymentAccountPayload(form, agencyId) {
  const v = (x) => String(x ?? '').trim() || undefined;
  return {
    agencyId, label: String(form.label ?? '').trim(), currency: v(form.currency), bankName: v(form.bankName), accountName: v(form.accountName),
    accountNumber: v(form.accountNumber), iban: v(form.iban), swift: v(form.swift), routingNumber: v(form.routingNumber), instructions: v(form.instructions),
  };
}
