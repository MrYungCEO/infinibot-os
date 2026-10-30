/**
 * VaultOps — the four operational tabs of vault-dashboard.ts:
 *   Moderation (renderModerationTab), Automation (renderAutomationTab),
 *   Analytics (renderAnalyticsTab) and System (renderSetupTab).
 * Where the web renders dead controls (rule modal, period select, setup
 * "Save Settings" toast) the native screen wires them to the real RPCs.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Share, Switch, ScrollView } from 'react-native';
import {
  Card,
  ListRow,
  Divider,
  SectionTitle,
  Button,
  Field,
  Chip,
  BottomSheet,
  EmptyState,
  SkeletonRow,
  ProgressBar,
  useUIKit,
  SPACE,
  RADIUS,
  MONO_FAMILY,
} from '../../ui-kit';
import {
  RULE_TRIGGERS,
  ANALYTICS_PERIODS,
  AUTONOMY_LEVELS,
  APPROVAL_ACTIONS,
  normalizeModLog,
  moderationCounts,
  modActionTone,
  modActionIcon,
  normalizeRule,
  triggerIcon,
  buildRuleParams,
  normalizeAnalytics,
  configForm,
  buildConfigPatch,
  normalizeSetup,
  textChannels,
  toggleIn,
  timeAgo,
  formatDate,
  formatNumber,
  formatPercent,
  titleCase,
  errorText,
} from './vault-model';
import { OptionChips, StatGrid, SectionError, KV } from './vault-ui';

// ── Moderation ───────────────────────────────────────────────

export function VaultModeration({ ctx }) {
  const { colors, type } = useUIKit();
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await ctx.sendReq('vault.moderation.logs', { limit: 100 });
      setLogs((res?.logs || []).map(normalizeModLog));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [ctx.sendReq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = moderationCounts(logs || []);
  const shown = (logs || []).filter((l) => !filter || l.action === filter || (filter === 'warn' && l.action === 'warning'));
  const actions = [...new Set((logs || []).map((l) => (l.action === 'warning' ? 'warn' : l.action)))];

  return (
    <View>
      <SectionTitle title="Moderation" actionLabel="Refresh" actionIcon="refresh-outline" onAction={load} />
      <StatGrid
        items={[
          { key: 't', label: 'Total actions', value: String(counts.total), icon: 'list-outline' },
          { key: 'w', label: 'Warnings', value: String(counts.warnings), icon: 'warning-outline', tone: 'warning' },
          { key: 'o', label: 'Timeouts', value: String(counts.timeouts), icon: 'timer-outline', tone: 'warning' },
          { key: 'b', label: 'Bans', value: String(counts.bans), icon: 'hammer-outline', tone: 'danger' },
        ]}
      />
      {actions.length > 1 ? (
        <View style={{ marginTop: SPACE.md }}>
          <OptionChips options={actions.map((a) => ({ key: a, label: titleCase(a) }))} value={filter} allowNone noneLabel="All" onChange={setFilter} />
        </View>
      ) : null}
      <SectionTitle title="Moderation log" count={logs ? shown.length : undefined} />
      {error ? (
        <SectionError error={error} onRetry={load} what="moderation logs" />
      ) : !logs ? (
        <Card padded={false}><SkeletonRow /><SkeletonRow /></Card>
      ) : shown.length === 0 ? (
        <EmptyState icon="shield-checkmark-outline" title="No moderation actions recorded" compact />
      ) : (
        <Card padded={false}>
          {shown.slice(0, 50).map((l, i) => (
            <View key={l.id || i}>
              {i > 0 ? <Divider inset /> : null}
              <ListRow
                icon={modActionIcon(l.action)}
                iconTone={modActionTone(l.action)}
                title={`${titleCase(l.action).toUpperCase()}  @${l.memberName}`}
                subtitle={`${l.reason || 'No reason'}\nBy ${l.moderator}${l.auto ? ' (auto)' : ''}`}
                value={timeAgo(l.timestamp)}
                onPress={l.memberId ? () => ctx.go('members') : undefined}
                chevron={false}
              />
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

// ── Automation ───────────────────────────────────────────────

export function VaultAutomation({ ctx }) {
  const { colors, type } = useUIKit();
  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [engine, setEngine] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} (new) | rule
  const [busy, setBusy] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await ctx.sendReq('vault.rules.list', {});
      setRules((res?.rules || []).map(normalizeRule));
      setError(null);
    } catch (e) {
      setError(e);
    }
    try {
      setEngine(await ctx.sendReq('vault.ruleEngine.status', {}));
    } catch {
      setEngine(null);
    }
  }, [ctx.sendReq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ctx.intent?.type === 'newRule') { setEditing({}); ctx.clearIntent(); }
  }, [ctx.intent]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (rule) => {
    setBusy(`t:${rule.id}`);
    try {
      await ctx.sendReq('vault.rules.update', { id: rule.id, enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(null);
    }
  };
  const test = async (rule) => {
    setBusy(`x:${rule.id}`);
    try {
      const res = await ctx.sendReq('vault.rules.test', { id: rule.id });
      setTestResult({ rule, result: res?.result || res });
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(null);
    }
  };

  const stats = engine?.stats;
  return (
    <View>
      <SectionTitle title="Automation rules" count={rules ? rules.length : undefined} actionLabel="New rule" actionIcon="add" onAction={() => setEditing({})} />
      {engine ? (
        <Card padded>
          <View style={styles.rowWrap}>
            <Chip label={engine.running ? 'Engine running' : 'Engine stopped'} dot tone={engine.running ? 'success' : 'neutral'} />
            {stats ? (
              <Text style={[type.monoSmall, { color: colors.textMuted, fontFamily: MONO_FAMILY, flex: 1 }]}>
                {stats.rulesEnabled}/{stats.rulesLoaded} enabled · {stats.eventsProcessed} events · {stats.actionsExecuted} actions · {stats.errors} errors
              </Text>
            ) : null}
          </View>
        </Card>
      ) : null}
      <View style={{ height: SPACE.sm }} />
      {error ? (
        <SectionError error={error} onRetry={load} what="automation rules" />
      ) : !rules ? (
        <Card padded={false}><SkeletonRow /><SkeletonRow /></Card>
      ) : rules.length === 0 ? (
        <EmptyState
          icon="flash-outline"
          title="No automation rules yet"
          message="Create rules to automate member management, course access and moderation."
          actionLabel="Create your first rule"
          onAction={() => setEditing({})}
          compact
        />
      ) : (
        <View style={{ gap: SPACE.sm }}>
          {rules.map((r) => (
            <Card key={r.id} padded tint={r.enabled ? 'primary' : 'neutral'}>
              <View style={{ gap: SPACE.xs, opacity: r.enabled ? 1 : 0.7 }}>
                <View style={styles.rowWrap}>
                  <Text style={[type.h3, { color: colors.text, flex: 1 }]} numberOfLines={2}>{r.name}</Text>
                  {!r.enabled ? <Chip label="DISABLED" size="sm" /> : null}
                </View>
                {r.description ? <Text style={[type.small, { color: colors.textSecondary }]}>{r.description}</Text> : null}
                <View style={styles.rowWrap}>
                  <Chip label={r.triggerType} icon={triggerIcon(r.triggerType)} size="sm" tone="primary" />
                  <Text style={[type.monoSmall, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>
                    {r.conditions.length} cond · {r.actions.length} actions · {r.triggerCount}x{r.lastTriggered ? ` · last ${timeAgo(r.lastTriggered)}` : ''}
                  </Text>
                </View>
                <View style={styles.rowWrap}>
                  <Button title={r.enabled ? 'Disable' : 'Enable'} size="sm" variant="secondary" loading={busy === `t:${r.id}`} onPress={() => toggle(r)} />
                  <Button title="Test" icon="flask-outline" size="sm" variant="ghost" loading={busy === `x:${r.id}`} onPress={() => test(r)} />
                  <Button title="Edit" icon="create-outline" size="sm" variant="ghost" onPress={() => setEditing(r)} />
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}

      <RuleSheet ctx={ctx} rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      <BottomSheet visible={Boolean(testResult)} onClose={() => setTestResult(null)} title="Dry run" subtitle={testResult?.rule?.name}>
        {testResult ? (
          <View style={{ gap: SPACE.sm }}>
            <Chip
              label={testResult.result?.wouldRun ? 'Would run' : 'Would not run'}
              tone={testResult.result?.wouldRun ? 'success' : 'warning'}
              dot
            />
            <KV label="Conditions" value={(testResult.result?.conditions || []).length} />
            <KV label="Unevaluated" value={testResult.result?.unevaluatedConditions ?? 0} />
            <KV label="Actions" value={(testResult.result?.actions || []).length} />
            <Text style={[type.caption, { color: colors.textMuted }]}>Dry run never fires actions or bumps the trigger count.</Text>
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

function RuleSheet({ ctx, rule, onClose, onSaved }) {
  const isEdit = Boolean(rule && rule.id);
  const [form, setForm] = useState({ name: '', description: '', triggerType: 'member_join', enabled: true });
  const [busy, setBusy] = useState(null);
  const { colors, type } = useUIKit();
  useEffect(() => {
    if (rule) {
      setForm({
        name: rule.name || '',
        description: rule.description || '',
        triggerType: rule.triggerType && rule.triggerType !== 'unknown' ? rule.triggerType : 'member_join',
        enabled: rule.enabled !== false,
      });
    }
  }, [rule]);
  if (!rule) return null;

  const save = async () => {
    setBusy('save');
    try {
      await ctx.sendReq(isEdit ? 'vault.rules.update' : 'vault.rules.create', buildRuleParams(form, isEdit ? rule : null));
      ctx.notify(isEdit ? 'Rule saved' : 'Rule created');
      onSaved();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    const ok = await ctx.dialogs.confirm({ title: 'Delete this rule?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    setBusy('delete');
    try {
      await ctx.sendReq('vault.rules.delete', { id: rule.id });
      ctx.notify('Rule deleted');
      onSaved();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={isEdit ? 'Edit rule' : 'New rule'}
      footer={
        <View style={styles.footer}>
          {isEdit ? <Button title="Delete" icon="trash-outline" variant="danger" size="sm" loading={busy === 'delete'} onPress={remove} /> : null}
          <Button title="Cancel" variant="ghost" size="sm" onPress={onClose} />
          <Button title={isEdit ? 'Save' : 'Create'} size="sm" loading={busy === 'save'} disabled={!form.name.trim()} onPress={save} />
        </View>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <Field label="Name" value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} placeholder="Welcome new members" required />
        <Field label="Description" value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} multiline rows={3} />
        <OptionChips label="Trigger" options={RULE_TRIGGERS.map((t) => ({ key: t, label: titleCase(t), icon: triggerIcon(t) }))} value={form.triggerType} onChange={(v) => v && setForm({ ...form, triggerType: v })} />
        <View style={styles.switchRow}>
          <Text style={[type.body, { color: colors.text, flex: 1 }]}>Enabled</Text>
          <Switch value={form.enabled} onValueChange={(v) => setForm({ ...form, enabled: v })} trackColor={{ true: colors.primary }} accessibilityLabel="Rule enabled" />
        </View>
        {isEdit ? (
          <Text style={[type.caption, { color: colors.textMuted }]}>
            {rule.conditions.length} condition(s) and {rule.actions.length} action(s) are kept as-is; edit those through an agent (vault tool).
          </Text>
        ) : (
          <Text style={[type.caption, { color: colors.textMuted }]}>New rules start with no conditions or actions; add them through an agent (vault tool).</Text>
        )}
      </View>
    </BottomSheet>
  );
}

// ── Analytics ────────────────────────────────────────────────

export function VaultAnalytics({ ctx }) {
  const { colors, type } = useUIKit();
  const [period, setPeriod] = useState('week');
  const [data, setData] = useState(ctx.analytics);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exported, setExported] = useState(null);
  const [exporting, setExporting] = useState(null);

  const load = useCallback(async (p) => {
    setLoading(true);
    try {
      const res = await ctx.sendReq('vault.analytics.get', { period: p });
      setData(normalizeAnalytics(res?.analytics ?? res));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [ctx.sendReq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(period); }, [period, ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const doExport = async (format) => {
    setExporting(format);
    try {
      const res = await ctx.sendReq('vault.analytics.export', { format, period });
      setExported(res);
    } catch (e) {
      ctx.fail(e);
    } finally {
      setExporting(null);
    }
  };
  const share = async () => {
    try {
      await Share.share({ title: exported?.filename, message: exported?.content || '' });
    } catch (e) {
      ctx.fail(e);
    }
  };

  const a = data;
  return (
    <View>
      <View style={{ marginTop: SPACE.md, gap: SPACE.sm }}>
        <OptionChips options={ANALYTICS_PERIODS} value={period} onChange={(v) => v && setPeriod(v)} />
        <View style={styles.rowWrap}>
          <Button title="Refresh" icon="refresh-outline" size="sm" variant="secondary" loading={loading} onPress={() => load(period)} />
          <Button title="Export CSV" icon="download-outline" size="sm" variant="secondary" loading={exporting === 'csv'} onPress={() => doExport('csv')} />
          <Button title="Export JSON" icon="code-download-outline" size="sm" variant="ghost" loading={exporting === 'json'} onPress={() => doExport('json')} />
        </View>
      </View>
      {error ? <SectionError error={error} onRetry={() => load(period)} what="vault analytics" /> : null}
      {!a && !error ? <Card padded={false}><SkeletonRow /><SkeletonRow /></Card> : null}
      {a ? (
        <>
          <SectionTitle title="Key metrics" />
          <StatGrid
            items={[
              { key: 'tm', label: 'Total members', value: formatNumber(a.totalMembers), icon: 'people-outline' },
              { key: 'am', label: 'Active members', value: formatNumber(a.activeMembers), icon: 'pulse-outline', tone: 'success' },
              { key: 'nm', label: 'New this month', value: formatNumber(a.newThisMonth), icon: 'trending-up-outline', tone: 'info' },
              { key: 'cr', label: 'Churn rate', value: formatPercent(a.churnRate), icon: 'trending-down-outline', tone: 'danger' },
            ]}
          />
          <SectionTitle title="Course performance" />
          <StatGrid
            items={[
              { key: 'en', label: 'Enrollments', value: formatNumber(a.enrollments || a.totalCourses), icon: 'school-outline' },
              { key: 'co', label: 'Completions', value: formatNumber(a.completions), icon: 'checkmark-done-outline', tone: 'success' },
              { key: 'ap', label: 'Avg progress', value: formatPercent(a.averageProgress), icon: 'speedometer-outline', tone: 'info' },
              { key: 'ld', label: 'Lessons done', value: formatNumber(a.lessonsCompleted), icon: 'document-text-outline', tone: 'warning' },
            ]}
          />
          <SectionTitle title="Moderation stats" />
          <StatGrid
            items={[
              { key: 'w', label: 'Warnings', value: formatNumber(a.moderation.warnings), icon: 'warning-outline', tone: 'warning' },
              { key: 't', label: 'Timeouts', value: formatNumber(a.moderation.timeouts), icon: 'timer-outline', tone: 'warning' },
              { key: 'k', label: 'Kicks', value: formatNumber(a.moderation.kicks), icon: 'exit-outline', tone: 'danger' },
              { key: 'b', label: 'Bans', value: formatNumber(a.moderation.bans), icon: 'hammer-outline', tone: 'danger' },
            ]}
          />
          {a.byTier.some((t) => t.count > 0) ? (
            <>
              <SectionTitle title="Members by tier" />
              <Card padded>
                <View style={{ gap: SPACE.sm }}>
                  {a.byTier.map((t) => {
                    const total = a.byTier.reduce((s, x) => s + x.count, 0) || 1;
                    return <ProgressBar key={t.tier} value={t.count / total} label={`${titleCase(t.tier)} · ${t.count}`} showValue />;
                  })}
                </View>
              </Card>
            </>
          ) : null}
          <SectionTitle title="Top performing courses" />
          <Card padded={false}>
            {a.topCourses.length === 0 ? (
              <EmptyState icon="trophy-outline" title="No course data yet" compact />
            ) : (
              a.topCourses.slice(0, 5).map((c, i) => (
                <View key={c.id || i}>
                  {i > 0 ? <Divider inset /> : null}
                  <ListRow dense leading={<Text style={[type.monoSmall, { color: colors.primary, fontFamily: MONO_FAMILY, minWidth: 24 }]}>#{i + 1}</Text>} title={c.title} value={`${c.enrollments} enrolled`} />
                </View>
              ))
            )}
          </Card>
          <SectionTitle title="Platform engagement" subtitle="KinglyVault app metrics, when reported" />
          <StatGrid items={a.platform.map((p) => ({ key: p.key, label: p.label, value: formatNumber(p.value) }))} />
          {a.activityBreakdown.length ? (
            <>
              <SectionTitle title="Activity breakdown" />
              <Card padded={false}>
                {a.activityBreakdown.map((it, i) => (
                  <View key={`${it.label}-${i}`}>
                    {i > 0 ? <Divider /> : null}
                    <ListRow dense title={it.label} value={String(it.count)} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}
          {a.toolEngagement ? (
            <>
              <SectionTitle title="Tool engagement" />
              <StatGrid items={[
                { key: 'v', label: 'Tool views', value: formatNumber(a.toolEngagement.views) },
                { key: 'c', label: 'Tool clicks', value: formatNumber(a.toolEngagement.clicks) },
                { key: 'u', label: 'Tool usage', value: formatNumber(a.toolEngagement.usage) },
              ]} />
            </>
          ) : null}
          {a.vaultEngagement ? (
            <>
              <SectionTitle title="Vault activity" />
              <StatGrid items={[
                { key: 'v', label: 'Vault views', value: formatNumber(a.vaultEngagement.views) },
                { key: 'd', label: 'Downloads', value: formatNumber(a.vaultEngagement.downloads) },
                { key: 'u', label: 'Uploads', value: formatNumber(a.vaultEngagement.uploads) },
                { key: 'a', label: 'Agents created', value: formatNumber(a.vaultEngagement.agents) },
              ]} />
            </>
          ) : null}
        </>
      ) : null}

      <BottomSheet
        visible={Boolean(exported)}
        onClose={() => setExported(null)}
        title="Analytics export"
        subtitle={exported?.filename}
        scroll={false}
        footer={
          <View style={styles.footer}>
            <Button title="Close" variant="ghost" size="sm" onPress={() => setExported(null)} />
            <Button title="Share" icon="share-outline" size="sm" onPress={share} />
          </View>
        }
      >
        <ScrollView style={[styles.exportBox, { borderColor: colors.border, backgroundColor: colors.surfaceDeep || colors.surface }]} nestedScrollEnabled>
          <Text selectable style={[type.monoSmall, { color: colors.textSecondary, fontFamily: MONO_FAMILY }]}>
            {String(exported?.content || '').slice(0, 20000)}
          </Text>
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

// ── System (setup) ───────────────────────────────────────────

export function VaultSetup({ ctx }) {
  const { colors, type } = useUIKit();
  const [form, setForm] = useState(() => configForm(ctx.config));
  const [setup, setSetup] = useState(null);
  const [setupErr, setSetupErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(null);

  useEffect(() => { setForm(configForm(ctx.config)); }, [ctx.config]);

  const loadSetup = useCallback(async () => {
    try {
      setSetup(normalizeSetup(await ctx.sendReq('vault.setup.status', {})));
      setSetupErr(null);
    } catch (e) {
      setSetupErr(e);
    }
  }, [ctx.sendReq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadSetup(); }, [ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const channels = textChannels(ctx.guild?.channels).map((c) => ({ key: String(c.id), label: `#${c.name}` }));
  const dirty = JSON.stringify(form) !== JSON.stringify(configForm(ctx.config));

  const save = async () => {
    setSaving(true);
    try {
      const res = await ctx.sendReq('vault.config.update', buildConfigPatch(form));
      if (res?.config) ctx.setConfig(res.config);
      ctx.notify('Settings saved');
      loadSetup();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setSaving(false);
    }
  };
  const markDone = async (step) => {
    setMarking(step.id);
    try {
      await ctx.sendReq('vault.setup.complete', { stepId: step.id });
      await loadSetup();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setMarking(null);
    }
  };

  const channelPicker = (label, key) => (
    channels.length ? (
      <OptionChips label={label} options={channels} value={form[key] || null} allowNone noneLabel="None" onChange={(v) => setForm({ ...form, [key]: v || '' })} />
    ) : (
      <Field label={label} value={form[key]} onChangeText={(v) => setForm({ ...form, [key]: v.trim() })} placeholder="Channel ID" mono keyboardType="number-pad" />
    )
  );

  return (
    <View>
      <SectionTitle title="Setup checklist" subtitle={setup ? `${setup.doneCount}/${setup.steps.length} complete` : undefined} />
      {setupErr ? (
        <SectionError error={setupErr} onRetry={loadSetup} what="the setup checklist" />
      ) : !setup ? (
        <Card padded={false}><SkeletonRow /></Card>
      ) : (
        <Card padded={false}>
          {setup.steps.map((s, i) => (
            <View key={s.id}>
              {i > 0 ? <Divider inset /> : null}
              <ListRow
                icon={s.completed ? 'checkmark-circle' : 'ellipse-outline'}
                iconTone={s.completed ? 'success' : 'neutral'}
                title={`${s.title}${s.required ? ' *' : ''}`}
                subtitle={s.description}
                trailing={s.completed ? undefined : <Button title="Mark done" size="sm" variant="ghost" loading={marking === s.id} onPress={() => markDone(s)} />}
              />
            </View>
          ))}
        </Card>
      )}

      <SectionTitle title="Discord settings" />
      <Card padded>
        <View style={{ gap: SPACE.md }}>
          <KV label="Guild ID" value={ctx.config?.guildId || 'Set via DISCORD_GUILD_ID'} />
          {channelPicker('Welcome channel', 'welcomeChannelId')}
          {channelPicker('Announcement channel', 'announcementChannelId')}
          {channelPicker('Mod log channel', 'modLogChannelId')}
        </View>
      </Card>

      <SectionTitle title="Infini autonomy" />
      <Card padded>
        <View style={{ gap: SPACE.md }}>
          <OptionChips label="Autonomy level" options={AUTONOMY_LEVELS} value={form.autonomyLevel} onChange={(v) => v && setForm({ ...form, autonomyLevel: v })} />
          <Text style={[type.caption, { color: colors.textMuted }]}>Controls which moderation actions Infini can take automatically.</Text>
          <OptionChips label="Require approval for" multi options={APPROVAL_ACTIONS.map((x) => ({ key: x, label: titleCase(x) }))} value={form.requireApproval} onChange={(v) => setForm({ ...form, requireApproval: toggleIn(form.requireApproval, v) })} />
        </View>
      </Card>

      <SectionTitle title="Auto-moderation" />
      <Card padded>
        <View style={styles.switchRow}>
          <Text style={[type.body, { color: colors.text, flex: 1 }]}>Enable auto-moderation</Text>
          <Switch value={form.autoModEnabled} onValueChange={(v) => setForm({ ...form, autoModEnabled: v })} trackColor={{ true: colors.primary }} accessibilityLabel="Enable auto-moderation" />
        </View>
      </Card>

      <View style={[styles.footer, { marginTop: SPACE.lg }]}>
        <Button title="Reset" variant="ghost" size="sm" disabled={!dirty} onPress={() => setForm(configForm(ctx.config))} />
        <Button title="Save settings" icon="save-outline" size="sm" loading={saving} disabled={!dirty} onPress={save} />
      </View>
      <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.sm }]}>
        Vault config lives in gateway memory until the vault moves onto the InfiniBot config system; a gateway restart reverts to the env defaults.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 44 },
  exportBox: { maxHeight: 360, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
});
