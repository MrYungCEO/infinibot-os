import {
  normalizeProduct,
  selectProducts,
  businessOptions,
  filterProducts,
  sortProducts,
  computeProductStats,
  filterOptions,
  productMargin,
  formatMargin,
  inventoryPct,
  adjustInventory,
  formatCurrency,
  formatCurrencyCompact,
  formatStatus,
  formatType,
  formatRelativeTime,
  productInitials,
  galleryKindOf,
  galleryItems,
  visibleEditFields,
  productToForm,
  formToPatch,
  formToCreate,
  emptyCreateForm,
  validateForm,
  parseNumberInput,
  duplicatePayload,
  applyProductResult,
  extractNotionDbId,
  hasProductsBinding,
  summarizePull,
  importLogLines,
  productAccentTone,
  hasActiveFilter,
  EMPTY_FILTERS,
  embedUrl,
  prettyText,
} from '../screens/products/catalog-model';

const P = (o) => normalizeProduct({ id: o.id || o.name, businessId: 'default', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...o });

describe('product catalog model', () => {
  test('normalizeProduct tolerates junk and coerces numbers', () => {
    expect(normalizeProduct(null)).toBeNull();
    expect(normalizeProduct({ name: 'x' })).toBeNull();
    const p = normalizeProduct({ id: 7, name: '  ', price: '12.5', tags: ['a', '', 3], status: 'GR Posted' });
    expect(p.id).toBe('7');
    expect(p.name).toBe('(untitled)');
    expect(p.price).toBe(12.5);
    expect(p.tags).toEqual(['a']);
    expect(p.status).toBe('GR Posted');
    expect(p.businessId).toBe('default');
    expect(selectProducts({ products: [{ id: 'a', name: 'A' }, null] })).toHaveLength(1);
  });

  test('businessOptions puts default first and skips duplicates', () => {
    expect(businessOptions({ businesses: [{ id: 'b1', name: 'Kingly' }, { id: 'default', name: 'D' }] })).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'b1', label: 'Kingly' },
    ]);
  });

  test('filterProducts matches name/sku/description/tags and the selects', () => {
    const list = [
      P({ name: 'Course', sku: 'FBC-1', type: 'digital', status: 'active', tags: ['Notion'] }),
      P({ name: 'Mug', type: 'physical', status: 'draft', category: 'Merch', description: 'ceramic' }),
    ];
    expect(filterProducts(list, { ...EMPTY_FILTERS, query: 'fbc' }).map((p) => p.name)).toEqual(['Course']);
    expect(filterProducts(list, { ...EMPTY_FILTERS, query: 'notion' })).toHaveLength(1);
    expect(filterProducts(list, { ...EMPTY_FILTERS, query: 'CERAMIC' })).toHaveLength(1);
    expect(filterProducts(list, { ...EMPTY_FILTERS, type: 'physical' })).toHaveLength(1);
    expect(filterProducts(list, { ...EMPTY_FILTERS, status: 'active' })).toHaveLength(1);
    expect(filterProducts(list, { ...EMPTY_FILTERS, category: 'Merch' })).toHaveLength(1);
    expect(hasActiveFilter(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilter({ ...EMPTY_FILTERS, status: 'draft' })).toBe(true);
  });

  test('sortProducts orders by key and keeps missing values last', () => {
    const list = [P({ name: 'b', price: 5 }), P({ name: 'a' }), P({ name: 'c', price: 50, updatedAt: '2026-10-09T00:00:00Z' })];
    expect(sortProducts(list, 'name').map((p) => p.name)).toEqual(['a', 'b', 'c']);
    expect(sortProducts(list, 'price_desc').map((p) => p.name)).toEqual(['c', 'b', 'a']);
    expect(sortProducts(list, 'price_asc').map((p) => p.name)).toEqual(['b', 'c', 'a']);
    expect(sortProducts(list, 'recent')[0].name).toBe('c');
  });

  test('computeProductStats matches the web maths', () => {
    const s = computeProductStats([
      P({ name: 'a', status: 'active', price: 10, inventory: 3, type: 'physical' }),
      P({ name: 'b', status: 'draft', price: 5, type: 'digital' }),
      P({ name: 'c', status: 'out_of_stock' }),
      P({ name: 'd', status: 'GR Posted', price: 1.5 }),
    ]);
    expect(s).toMatchObject({ total: 4, active: 1, drafts: 1, outOfStock: 1, totalValue: 36.5 });
    expect(s.byType.physical).toBe(1);
  });

  test('filterOptions adds free-form values found in data', () => {
    const o = filterOptions([P({ name: 'a', status: 'GR Posted', type: 'n8n workflow', category: 'Auto' })]);
    expect(o.statuses).toContain('GR Posted');
    expect(o.statuses[0]).toBe('active');
    expect(o.types).toContain('n8n workflow');
    expect(o.categories).toEqual(['Auto']);
  });

  test('margin, inventory bar and adjustments', () => {
    expect(productMargin({ price: 100, cost: 40 })).toBe(60);
    expect(productMargin({ price: 0, cost: 1 })).toBeNull();
    expect(formatMargin(60)).toBe('+60%');
    expect(formatMargin(-5)).toBe('-5%');
    expect(inventoryPct({ type: 'physical', inventory: 10 })).toBe(50);
    expect(inventoryPct({ type: 'physical', inventory: 99 })).toBe(100);
    expect(inventoryPct({ type: 'digital', inventory: 10 })).toBeNull();
    expect(adjustInventory(undefined, 1)).toBe(1);
    expect(adjustInventory(2, -5)).toBe(0);
    expect(adjustInventory(2, 10)).toBe(12);
  });

  test('formatters', () => {
    expect(formatCurrency(11222.85)).toBe('$11,222.85');
    expect(formatCurrency(249)).toBe('$249.00');
    expect(formatCurrency(undefined)).toBe('—');
    expect(formatCurrencyCompact(11222.85)).toBe('$11.2K');
    expect(formatCurrencyCompact(999)).toBe('$999.00');
    expect(formatStatus('out_of_stock')).toBe('Out of stock');
    expect(formatStatus('GR Posted')).toBe('GR Posted');
    expect(formatType('digital')).toBe('Digital');
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(formatRelativeTime('2026-10-14T11:30:00Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-10-12T12:00:00Z', now)).toBe('2d ago');
    expect(productInitials('AI Lead Generation')).toBe('AG');
    expect(productInitials('Mug')).toBe('MU');
  });

  test('gallery classification', () => {
    expect(galleryKindOf('https://x.com/a/b/photo.PNG?sig=1')).toMatchObject({ kind: 'image', ext: 'png', name: 'photo.PNG' });
    expect(galleryKindOf('https://www.loom.com/share/abc').kind).toBe('video');
    expect(galleryKindOf('https://s3/x/workflow.json').kind).toBe('json');
    expect(galleryKindOf('not a url').kind).toBe('other');
    const g = galleryItems({ gallery: Array.from({ length: 20 }, (_, i) => `https://h/${i}.pdf`) });
    expect(g.items).toHaveLength(18);
    expect(g.more).toBe(2);
    expect(embedUrl('https://youtu.be/abc_1')).toBe('https://www.youtube.com/embed/abc_1');
    expect(prettyText({ kind: 'json' }, '{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  test('editor fields are type-gated like the web inspector', () => {
    const phys = visibleEditFields('physical').map((f) => f.key);
    expect(phys).toEqual(expect.arrayContaining(['inventory', 'weight', 'vendor']));
    expect(phys).not.toContain('downloadUrl');
    const dig = visibleEditFields('digital').map((f) => f.key);
    expect(dig).toContain('licenseKeyPattern');
    expect(dig).not.toContain('inventory');
  });

  test('formToPatch sends only changed keys', () => {
    const orig = P({ name: 'Mug', price: 10, tags: ['a'], type: 'physical' });
    const form = productToForm(orig);
    expect(formToPatch(form, orig)).toEqual({});
    form.price = '12';
    form.tags = 'a, b';
    form.sku = ' SKU-1 ';
    expect(formToPatch(form, orig)).toEqual({ price: 12, tags: ['a', 'b'], sku: 'SKU-1' });
    form.price = '';
    expect(formToPatch(form, orig).price).toBeNull();
    form.name = '';
    expect(formToPatch(form, orig).name).toBeUndefined();
  });

  test('create payload mirrors the web create dialog', () => {
    const f = emptyCreateForm();
    expect(validateForm(f).name).toBeTruthy();
    f.name = 'Course';
    f.price = '49.5';
    f.cost = '3'; // not a create field — ignored
    expect(formToCreate(f)).toEqual({ name: 'Course', type: 'digital', price: 49.5, status: 'active' });
    expect(validateForm({ ...f, price: 'abc' }).price).toBeTruthy();
    expect(parseNumberInput('$1,200')).toBe(1200);
  });

  test('duplicate + list reducer', () => {
    const p = P({ id: 'x', name: 'Mug', price: 3 });
    expect(duplicatePayload(p)).toEqual({ name: 'Mug (copy)', status: 'draft', price: 3 });
    let list = [p];
    list = applyProductResult(list, { type: 'created', product: { id: 'y', name: 'New' } });
    expect(list.map((x) => x.id)).toEqual(['y', 'x']);
    list = applyProductResult(list, { type: 'patched', id: 'x', patch: { status: 'archived' } });
    expect(list[1].status).toBe('archived');
    list = applyProductResult(list, { type: 'updated', product: { id: 'x', name: 'Mug 2' } });
    expect(list[1].name).toBe('Mug 2');
    expect(applyProductResult(list, { type: 'deleted', id: 'y' })).toHaveLength(1);
  });

  test('notion helpers', () => {
    expect(extractNotionDbId('https://notion.so/ws/Title-35af4bdd9bcf8115b7b6c69976ab1808?v=1')).toBe('35af4bdd9bcf8115b7b6c69976ab1808');
    expect(extractNotionDbId('nope')).toBeNull();
    expect(hasProductsBinding({ bindings: [{ role: 'clients' }] }, 'default')).toBe(false);
    expect(hasProductsBinding({ bindings: [{ role: 'products', businessId: null }] }, 'default')).toBe(true);
    expect(hasProductsBinding({ bindings: [{ role: 'products', businessId: 'b2' }] }, 'b1')).toBe(false);
    expect(summarizePull({ refreshed: [{ dbId: 'abcdefghij', title: 'KK' }] })).toBe('Pulled KK');
    expect(importLogLines('KK', 'd1', { initialPull: { productsDebug: [{ dbId: 'd1', added: 3, pages: 4 }] } })).toEqual([
      'KK: binding committed',
      'Pulled 3 of 4 Notion pages',
    ]);
    expect(importLogLines('KK', 'd1', null, new Error('boom'))[0]).toMatch(/failed — boom/);
  });

  test('accent override falls back to the type tone', () => {
    const p = P({ id: 'z', name: 'z', type: 'physical' });
    expect(productAccentTone(p, {})).toBe('success');
    expect(productAccentTone(p, { z: 'danger' })).toBe('danger');
    expect(productAccentTone(p, { z: '#fff' })).toBe('success');
  });
});
