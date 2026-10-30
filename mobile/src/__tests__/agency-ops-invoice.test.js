import {
  backlogPayments,
  centsToInput,
  computeInvoiceTotals,
  createInvoiceDraft,
  dayToTimestamp,
  describePeriod,
  endOfMonthsAgo,
  invoiceDraftProblems,
  isBackdated,
  isoDay,
  newLine,
  parseCents,
  parseScaled,
  paymentAccountPayload,
  paymentDraftState,
  planInvoiceSave,
  readInvoiceId,
  shiftDay,
  suggestInvoiceNumber,
  withIssueDate,
} from '../screens/agency/ops/agency-ops-invoice';

describe('integer money', () => {
  test('parseScaled / parseCents', () => {
    expect(parseCents('1,250.50')).toBe(125050);
    expect(parseCents('19.99')).toBe(1999);
    expect(parseCents('.5')).toBe(50);
    expect(parseCents('1.234')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('')).toBeNull();
    expect(parseScaled('2.5', 3)).toBe(2500);
  });
  test('centsToInput', () => {
    expect(centsToInput(5)).toBe('0.05');
    expect(centsToInput(125050)).toBe('1250.50');
    expect(centsToInput(-150)).toBe('-1.50');
  });
});

describe('dates', () => {
  test('noon timestamps and shifting', () => {
    expect(new Date(dayToTimestamp('2026-03-05')).getHours()).toBe(12);
    expect(dayToTimestamp('2026/03/05')).toBeNull();
    expect(shiftDay('2026-01-30', 3)).toBe('2026-02-02');
    expect(describePeriod('2025-03-10')).toBe('March 2025');
  });
  test('end of last month + backdated', () => {
    expect(endOfMonthsAgo(1, new Date(2026, 9, 14))).toBe('2026-09-30');
    expect(isBackdated('2000-01-01')).toBe(true);
    expect(isBackdated(isoDay())).toBe(false);
  });
});

describe('composer', () => {
  const line = (description, quantity, unitPrice, cadence = 'one_time') => ({ ...newLine(), description, quantity, unitPrice, cadence });
  test('totals with tax and recurring', () => {
    const t = computeInvoiceTotals([line('Build', '2', '1000'), line('Hosting', '1', '30', 'monthly'), line('Annual', '1', '1200', 'annual')], '10');
    expect(t).toMatchObject({ subtotalCents: 323000, taxCents: 32300, totalCents: 355300, recurringMonthlyCents: 13000, billableLines: 3, invalidLines: 0 });
  });
  test('invalid lines counted, untouched blank lines ignored', () => {
    const t = computeInvoiceTotals([line('Bad', '1', 'x'), newLine()], '0');
    expect(t.invalidLines).toBe(1);
    expect(t.billableLines).toBe(0);
  });
  test('problems', () => {
    const d = { ...createInvoiceDraft({ invoices: [] }), number: '' };
    const p = invoiceDraftProblems(d, computeInvoiceTotals(d.lines, d.taxPercent));
    expect(p).toEqual(expect.arrayContaining(['Choose the client this invoice bills.', 'Give the invoice a number.', 'Add at least one described line item.', 'Invoice total must be greater than zero.']));
  });
  test('number suggestion', () => {
    expect(suggestInvoiceNumber([{ number: 'INV-2026-0008' }, { number: 'X-3' }], 2026)).toBe('INV-2026-0009');
    expect(suggestInvoiceNumber([], 2026)).toBe('INV-2026-0001');
  });
  test('backdated draft + issue date keeps net terms', () => {
    const d = createInvoiceDraft({ backdated: true });
    expect(isBackdated(d.issueDate)).toBe(true);
    const moved = withIssueDate({ ...d, issueDate: '2026-01-01', dueDate: '2026-01-15' }, '2026-02-01');
    expect(moved).toMatchObject({ dueDate: '2026-02-15', paidDate: '2026-02-01' });
  });
  test('save plan: create + issue today, backlog when backdated', () => {
    const d = { ...createInvoiceDraft(), clientId: 'c1', projectId: 'p1', lines: [line('Build', '1', '250')] };
    const t = computeInvoiceTotals(d.lines, d.taxPercent);
    const plan = planInvoiceSave(d, t, 'ag', { issue: true });
    expect(plan.mode).toBe('create');
    expect(plan.create[0]).toBe('agency.ops.invoice.create');
    expect(plan.create[1]).toMatchObject({ clientId: 'c1', projectIds: ['p1'], lineItems: [{ description: 'Build', quantity: 1, unitPriceCents: 25000, cadence: 'one_time' }] });
    expect(plan.issue).not.toBeNull();
    const back = { ...d, issueDate: '2025-03-10', dueDate: '2025-04-09', paidAmount: '999', paidDate: '2025-03-20' };
    const bp = planInvoiceSave(back, t, 'ag', { issue: true });
    expect(bp.mode).toBe('backlog');
    expect(bp.create[1].payments).toEqual([{ amountCents: 25000, paidAt: dayToTimestamp('2025-03-20'), method: 'historical' }]);
    expect(planInvoiceSave(back, t, 'ag', { issue: false }).mode).toBe('create');
    expect(backlogPayments({ paidAmount: '', paidDate: '2025-01-01' }, t)).toEqual([]);
  });
  test('readInvoiceId envelopes', () => {
    expect(readInvoiceId({ invoice: { id: 'a' } })).toBe('a');
    expect(readInvoiceId({ result: { invoice: { id: 'b' } } })).toBe('b');
    expect(readInvoiceId(null)).toBeNull();
  });
  test('payment draft validation', () => {
    const inv = { balanceCents: 5000 };
    expect(paymentDraftState(inv, undefined, isoDay())).toMatchObject({ text: '50.00', amountValid: true, full: true });
    expect(paymentDraftState(inv, '60', isoDay()).amountValid).toBe(false);
    expect(paymentDraftState(inv, '10', '2020-01-01')).toMatchObject({ full: false, backdated: true });
  });
  test('payment account payload trims', () => {
    expect(paymentAccountPayload({ label: ' Wise ', iban: '' }, 'ag')).toMatchObject({ agencyId: 'ag', label: 'Wise', iban: undefined });
  });
});
