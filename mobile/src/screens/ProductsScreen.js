/**
 * ProductsScreen — KIS Object 5, the product registry portfolio.
 *
 * IMPORTANT: this is the KIS product *registry* (`product.*`), not the
 * pre-existing products catalog behind the `/products` web route. The web UI
 * routes this one at `/product-registry` for exactly that reason, and the More
 * index labels it "Product Registry" so the two are never confused.
 *
 * The portfolio's central idea is that two ladders are INDEPENDENT: operational
 * `status` (Active / Development / Hold / Retired) and commercial
 * `validationStage` (Idea → … → Scaled). "Built ≠ Product." So the screen lets
 * you group by either, and the detail sheet shows the validation ladder as a
 * determinate progress bar rather than implying that shipping equals validation.
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
import { useProducts } from '../hooks/useProducts';
import { MetaChips, DetailRows, CommonFieldsDetail, ChipPicker, ChipRow, listPlaceholder } from '../kis/ui';
import {
  PRODUCT_TYPES,
  PRODUCT_STATUSES,
  VALIDATION_STAGES,
  REVENUE_MODELS,
  PRIORITIES,
  validationProgress,
  formatMoney,
} from '../kis/vocab';

const ALL = '__all__';
const GROUP_OPTIONS = [
  { key: 'validation', label: 'Validation' },
  { key: 'status', label: 'Status' },
];

const emptyDraft = () => ({
  name: '',
  owner: '',
  productType: 'Module',
  status: 'Development',
  validationStage: 'Idea',
  priority: 'P2',
  technicalOwner: '',
  targetCustomer: '',
  problemSolved: '',
  valueProposition: '',
  revenueModel: 'Project Fee',
  pricing: '',
  nextProductDecision: '',
});

export function ProductsScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;

  const {
    products,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    byValidationStage,
    byStatus,
    validatedCount,
  } = useProducts(sendReq);

  const [groupBy, setGroupBy] = useState('validation');
  const [filter, setFilter] = useState(ALL);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const selected = useMemo(() => products.find((p) => p.id === selectedId) || null, [products, selectedId]);

  const resolveLabel = useCallback(
    (nodeType, nodeId) =>
      nodeType === 'product' ? products.find((p) => p.id === nodeId)?.name : undefined,
    [products],
  );

  const groups = groupBy === 'validation' ? byValidationStage : byStatus;
  const order = groupBy === 'validation' ? VALIDATION_STAGES : PRODUCT_STATUSES;

  const tabs = useMemo(
    () => [
      { key: ALL, label: 'All', count: products.length },
      ...order
        .filter((k) => (groups.get(k) || []).length)
        .map((k) => ({ key: k, label: k, count: (groups.get(k) || []).length })),
    ],
    [products.length, groups, order],
  );

  const sections = useMemo(() => {
    if (filter !== ALL) {
      const rows = groups.get(filter) || [];
      return rows.length ? [{ key: filter, rows }] : [];
    }
    return order.map((key) => ({ key, rows: groups.get(key) || [] })).filter((s) => s.rows.length);
  }, [filter, groups, order]);

  // Switching the grouping axis invalidates a filter drawn from the other axis.
  const switchGroup = (next) => {
    setGroupBy(next);
    setFilter(ALL);
  };

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setSaveError(null);
    setCreating(true);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setSaveError('Name is required.');
      return;
    }
    if (!draft.owner.trim()) {
      setSaveError('A product owner is required — the gateway rejects a product without one (§27).');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await create({ ...draft, name: draft.name.trim(), owner: draft.owner.trim() });
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

  const placeholder = listPlaceholder({
    loading: loading,
    error: error,
    count: products.length,
    onRetry: refresh,
    errorTitle: 'Couldn\'t load the product registry',
    emptyIcon: 'cube-outline',
    emptyTitle: 'No products registered',
    emptyMessage: 'The registry tracks what you sell and how far each product has been validated commercially — not what has been built.',
    emptyActionLabel: 'Register a product',
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
          title="Product Registry"
          subtitle={
            products.length
              ? `${products.length} products · ${validatedCount} commercially validated`
              : 'Portfolio'
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[{ key: 'add', icon: 'add', label: 'Register a product', onPress: openCreate }]}
        >
          <Tabs tabs={tabs} active={filter} onSelect={setFilter} />
        </AppHeader>
      }
    >
      <SegmentedControl options={GROUP_OPTIONS} value={groupBy} onChange={switchGroup} />

      <View style={styles.statRow}>
        <StatCard
          compact
          style={styles.stat}
          label="Products"
          value={String(products.length)}
          tone="primary"
          icon="cube-outline"
        />
        <StatCard
          compact
          style={styles.stat}
          label="Validated"
          value={String(validatedCount)}
          tone={validatedCount ? 'success' : 'neutral'}
          icon="checkmark-done-outline"
          footnote="paying / repeat / scaled"
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
              {section.rows.map((product, i) => (
                <React.Fragment key={product.id}>
                  {i > 0 && <Divider inset />}
                  <ListRow
                    icon="cube-outline"
                    iconTone={product.status === 'Active' ? 'primary' : 'neutral'}
                    title={product.name}
                    subtitle={
                      product.valueProposition || product.targetCustomer || product.productType
                    }
                    meta={
                      <MetaChips
                        record={product}
                        extra={
                          groupBy === 'validation' ? (
                            <Chip label={product.status} size="sm" tone="neutral" />
                          ) : (
                            <Chip label={product.validationStage} size="sm" tone="neutral" />
                          )
                        }
                      />
                    }
                    value={product.financialValue ? formatMoney(product.financialValue) : undefined}
                    onPress={() => {
                      setSaveError(null);
                      setSelectedId(product.id);
                    }}
                    accessibilityLabel={`${product.name}, ${product.status}, validation ${product.validationStage}`}
                    accessibilityHint="Opens the product detail"
                  />
                </React.Fragment>
              ))}
            </Card>
          </View>
        ))}

      {/* ── Detail ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name || 'Product'}
        subtitle={selected ? `${selected.productType} · ${selected.status}` : undefined}
      >
        {selected ? (
          <View>
            <ChipRow>
              <MetaChips record={selected} size="md" />
            </ChipRow>

            {saveError ? (
              <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>
                {saveError}
              </Text>
            ) : null}

            <View style={styles.ladder}>
              <Text style={[type.label, { color: colors.textSecondary }]}>Validation ladder</Text>
              <ProgressBar
                value={validationProgress(selected.validationStage)}
                tone={selected.validationStage === 'Retired' ? 'neutral' : 'primary'}
                label={selected.validationStage}
              />
              <Text style={[type.caption, { color: colors.textMuted }]}>
                Independent of status — a product in Development can be at Idea, and a Retired one
                may have reached Repeat Sales.
              </Text>
            </View>

            <ChipPicker
              label="Validation stage"
              options={VALIDATION_STAGES}
              value={selected.validationStage}
              onChange={(validationStage) => act(() => update(selected.id, { validationStage }))}
            />
            <ChipPicker
              label="Status"
              options={PRODUCT_STATUSES}
              value={selected.status}
              onChange={(status) => act(() => update(selected.id, { status }))}
            />

            <DetailRows
              title="Commercial"
              rows={[
                { label: 'Target customer', value: selected.targetCustomer, wide: true, icon: 'people-outline' },
                { label: 'Problem solved', value: selected.problemSolved, wide: true, icon: 'help-circle-outline' },
                { label: 'Value proposition', value: selected.valueProposition, wide: true, icon: 'sparkles-outline' },
                { label: 'Revenue model', value: selected.revenueModel, icon: 'repeat-outline' },
                { label: 'Pricing', value: selected.pricing, icon: 'pricetag-outline' },
                { label: 'Financial value', value: selected.financialValue ? formatMoney(selected.financialValue) : '', icon: 'cash-outline' },
              ]}
            />

            <DetailRows
              title="Build & plan"
              rows={[
                { label: 'Technical owner', value: selected.technicalOwner, icon: 'construct-outline' },
                { label: 'Parent product', value: selected.parentProductId, icon: 'git-branch-outline' },
                { label: 'Roadmap', value: selected.roadmapLink, wide: true, icon: 'map-outline' },
                { label: 'Next product decision', value: selected.nextProductDecision, wide: true, icon: 'git-compare-outline' },
              ]}
            />

            <CommonFieldsDetail record={selected} />

            <RelatedPanel
              sendReq={sendReq}
              type="product"
              id={selected.id}
              label={selected.name}
              resolveLabel={resolveLabel}
            />

            <View style={styles.sheetActions}>
              <Button
                title={selected.blocked ? 'Unblock' : 'Mark blocked'}
                variant="outline"
                icon="hand-left-outline"
                onPress={() => act(() => update(selected.id, { blocked: !selected.blocked }))}
                accessibilityLabel={selected.blocked ? 'Unblock this product' : 'Mark this product blocked'}
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
                accessibilityLabel="Delete this product"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {/* ── Create ────────────────────────────────────────────────── */}
      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="Register a product"
        subtitle="Status and validation stage are independent ladders"
        footer={
          <Button
            title="Register product"
            icon="checkmark"
            fullWidth
            loading={saving}
            onPress={save}
            accessibilityLabel="Register this product"
          />
        }
      >
        <Field
          label="Name"
          required
          value={draft.name}
          onChangeText={(v) => setField('name', v)}
          placeholder="What is the product?"
        />
        <Field
          label="Product owner"
          required
          value={draft.owner}
          onChangeText={(v) => setField('owner', v)}
          placeholder="The single accountable owner"
        />
        <ChipPicker
          label="Type"
          options={PRODUCT_TYPES}
          value={draft.productType}
          onChange={(v) => setField('productType', v)}
        />
        <ChipPicker
          label="Status"
          options={PRODUCT_STATUSES}
          value={draft.status}
          onChange={(v) => setField('status', v)}
        />
        <ChipPicker
          label="Validation stage"
          options={VALIDATION_STAGES}
          value={draft.validationStage}
          onChange={(v) => setField('validationStage', v)}
          helper="Where the product actually is commercially — not how much is built."
        />
        <ChipPicker
          label="Priority"
          options={PRIORITIES}
          value={draft.priority}
          onChange={(v) => setField('priority', v)}
        />
        <Field
          label="Technical owner"
          value={draft.technicalOwner}
          onChangeText={(v) => setField('technicalOwner', v)}
        />
        <Field
          label="Target customer"
          value={draft.targetCustomer}
          onChangeText={(v) => setField('targetCustomer', v)}
        />
        <Field
          label="Problem solved"
          multiline
          rows={3}
          value={draft.problemSolved}
          onChangeText={(v) => setField('problemSolved', v)}
        />
        <Field
          label="Value proposition"
          multiline
          rows={3}
          value={draft.valueProposition}
          onChangeText={(v) => setField('valueProposition', v)}
        />
        <ChipPicker
          label="Revenue model"
          options={REVENUE_MODELS}
          value={draft.revenueModel}
          onChange={(v) => setField('revenueModel', v)}
        />
        <Field label="Pricing" value={draft.pricing} onChangeText={(v) => setField('pricing', v)} />
        <Field
          label="Next product decision"
          value={draft.nextProductDecision}
          onChangeText={(v) => setField('nextProductDecision', v)}
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
  ladder: { marginTop: SPACE.lg, gap: SPACE.sm },
  sheetActions: { marginTop: SPACE.xl, gap: SPACE.sm },
});

export default ProductsScreen;
