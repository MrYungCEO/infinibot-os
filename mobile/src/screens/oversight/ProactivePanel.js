/**
 * ProactivePanel — the default "Proactive Oversight" cron jobs (parity with
 * ui/src/ui/components/proactive-oversight-panel.ts). Collapsible; grouped
 * daily / weekly / monthly / continuous; each job has an enable toggle,
 * schedule, last/next run and "Run now".
 *
 *   cron.list({ includeDisabled: true }) · cron.update({ id, patch: { enabled } })
 *   cron.run({ id, mode: 'force' })
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, Card, Button, Divider } from '../../ui-kit';
import { isOversightJob, groupOversightJobs, fmtSchedule, fmtWhen, jobDisplayName } from './oversight-model';
import { withTimeout } from '../../hooks/useOversight';
import { ConfirmModal } from './ui';

export function ProactivePanel({ gateway }) {
  const { colors, type, alpha } = useUIKit();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(() => new Set());
  const [confirmJob, setConfirmJob] = useState(null);

  const refresh = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);
    try {
      const res = await withTimeout(gateway.sendReq('cron.list', { includeDisabled: true }), 20_000, 'cron');
      setJobs((Array.isArray(res?.jobs) ? res.jobs : []).filter(isOversightJob));
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    if (gateway?.status === 'connected' || !gateway?.status) refresh();
  }, [gateway?.status, refresh]);

  const mark = (id, on) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const toggle = async (job) => {
    if (busy.has(job.id)) return;
    const next = !job.enabled;
    mark(job.id, true);
    setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, enabled: next } : j)));
    try {
      await withTimeout(gateway.sendReq('cron.update', { id: job.id, patch: { enabled: next } }), 20_000, 'cron');
      await refresh();
    } catch (e) {
      setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, enabled: !next } : j)));
      setError(e?.message || String(e));
    } finally {
      mark(job.id, false);
    }
  };

  const runNow = async (job) => {
    setConfirmJob(null);
    if (busy.has(job.id)) return;
    mark(job.id, true);
    try {
      await withTimeout(gateway.sendReq('cron.run', { id: job.id, mode: 'force' }), 60_000, 'cron');
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      mark(job.id, false);
    }
  };

  const enabled = jobs.filter((j) => j.enabled).length;
  const groups = groupOversightJobs(jobs);

  return (
    <Card padded={0} style={{ marginBottom: SPACE.md }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Collapse' : 'Expand'} Proactive Oversight`}
        style={({ pressed }) => [styles.head, { opacity: pressed ? 0.85 : 1 }]}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.primary} />
        <Ionicons name="pulse-outline" size={16} color={colors.primary} />
        <Text style={[type.smallStrong, { color: colors.primary, flex: 1 }]}>Proactive Oversight</Text>
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>
          {loading && !jobs.length ? 'loading…' : `${enabled}/${jobs.length} active`}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.md }}>
          {error ? <Text style={[type.caption, { color: colors.error, marginBottom: SPACE.sm }]}>{error}</Text> : null}
          {!jobs.length && !loading ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>
              No oversight jobs seeded yet (they seed on the next gateway start).
            </Text>
          ) : null}
          {groups.map((g) => (
            <View key={g.key}>
              <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.sm, marginBottom: SPACE.xs }]}>{g.label}</Text>
              {g.jobs.map((j, i) => {
                const isBusy = busy.has(j.id);
                return (
                  <View key={j.id}>
                    {i > 0 ? <Divider /> : null}
                    <View style={styles.row}>
                      <Switch
                        value={!!j.enabled}
                        onValueChange={() => toggle(j)}
                        disabled={isBusy}
                        trackColor={{ false: alpha(colors.text, 0.18), true: alpha(colors.primary, 0.6) }}
                        thumbColor={j.enabled ? colors.primary : colors.textMuted}
                        accessibilityLabel={`${j.enabled ? 'Disable' : 'Enable'} ${jobDisplayName(j)}`}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>
                          {jobDisplayName(j)}
                        </Text>
                        {j.description ? (
                          <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
                            {j.description}
                          </Text>
                        ) : null}
                        <Text style={[type.monoSmall, { color: colors.textSecondary }]} numberOfLines={1}>
                          {fmtSchedule(j.schedule)} · last {fmtWhen(j.state?.lastRunAtMs)} · next{' '}
                          {j.enabled ? fmtWhen(j.state?.nextRunAtMs) : '—'}
                        </Text>
                      </View>
                      <Button
                        title={isBusy ? '' : 'Run now'}
                        size="sm"
                        variant="outline"
                        loading={isBusy}
                        onPress={() => setConfirmJob(j)}
                        accessibilityLabel={`Run ${jobDisplayName(j)} now`}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}
      <ConfirmModal
        visible={!!confirmJob}
        title={confirmJob ? `Run ${jobDisplayName(confirmJob)} now?` : ''}
        message="Forces one run of this oversight job immediately."
        confirmLabel="Run now"
        onConfirm={() => confirmJob && runNow(confirmJob)}
        onClose={() => setConfirmJob(null)}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 48, paddingHorizontal: SPACE.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm },
});

export default ProactivePanel;
