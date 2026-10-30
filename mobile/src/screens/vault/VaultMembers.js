/**
 * VaultMembers — port of ui/src/ui/views/vault-members.ts.
 * Search / status / tier / sort / warnings filters, multi-select bulk DM / kick / ban,
 * paging, add member, and the profile sheet (tier change, Discord roles,
 * warnings, notes, DM, warn, kick, ban, unban, moderation history).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Card,
  ListRow,
  Divider,
  SectionTitle,
  Button,
  Field,
  Chip,
  StatusChip,
  BottomSheet,
  EmptyState,
  SkeletonRow,
  useUIKit,
  SPACE,
} from '../../ui-kit';
import {
  FILTER_TIERS,
  MEMBER_TIERS,
  MEMBER_STATUSES,
  MEMBER_SORTS,
  SEVERITIES,
  DEFAULT_MEMBER_FILTERS,
  normalizeMember,
  memberQuery,
  applyMemberFilters,
  hasActiveMemberFilters,
  memberStatusTone,
  roleNames,
  sortRoles,
  normalizeModLog,
  modActionTone,
  modActionIcon,
  buildMemberCreateParams,
  canCreateMember,
  isOnline,
  timeAgo,
  formatDate,
  titleCase,
} from './vault-model';
import { Avatar, KV, OptionChips, SectionError } from './vault-ui';

const PAGE = 50;

export function VaultMembers({ ctx, memberId }) {
  const { colors, type } = useUIKit();
  const { sendReq, dialogs } = ctx;
  const [filters, setFilters] = useState({ ...DEFAULT_MEMBER_FILTERS });
  const [searchText, setSearchText] = useState('');
  const [members, setMembers] = useState(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(null);
  const [openMember, setOpenMember] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async (f, pageNo = 0) => {
    if (!sendReq) return;
    setLoading(true);
    try {
      const q = memberQuery(f, pageNo, PAGE);
      const res = await sendReq(q.method, q.params);
      const rows = (Array.isArray(res?.members) ? res.members : []).map(normalizeMember);
      setMembers((prev) => (pageNo > 0 && prev ? [...prev, ...rows] : rows));
      setHasMore(q.method === 'vault.members.list' && rows.length >= PAGE);
      setPage(pageNo);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  useEffect(() => {
    load(filters, 0);
  }, [ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link: open a member profile.
  useEffect(() => {
    if (!memberId || !sendReq) return;
    sendReq('vault.members.get', { id: memberId })
      .then((r) => r?.member && setOpenMember(normalizeMember(r.member)))
      .catch((e) => ctx.fail(e));
  }, [memberId, sendReq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quick action from the overview.
  useEffect(() => {
    if (ctx.intent?.type === 'addMember') {
      setAddOpen(true);
      ctx.clearIntent();
    }
  }, [ctx.intent]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = (patch) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setSelected(new Set());
    // Only server-side keys (tier / status / search) need a refetch; sort + warnings are local.
    if ('tier' in patch || 'status' in patch || 'search' in patch) load(next, 0);
  };

  const onSearch = (text) => {
    setSearchText(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => applyFilters({ search: text }), 320);
  };
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  const clearFilters = () => {
    setSearchText('');
    const next = { ...DEFAULT_MEMBER_FILTERS };
    setFilters(next);
    load(next, 0);
  };

  const visible = applyMemberFilters(members || [], filters);
  const selecting = selected.size > 0;
  const toggleSel = (id) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const bulk = async (kind) => {
    const ids = [...selected];
    const count = ids.length;
    const text = await dialogs.prompt({
      title: kind === 'dm' ? `DM ${count} member(s)` : `${titleCase(kind)} ${count} member(s)`,
      message: kind === 'dm' ? 'Sent as a Discord DM to each selected member.' : 'Reason (written to the mod log).',
      placeholder: kind === 'dm' ? 'Message...' : 'Reason...',
      multiline: kind === 'dm',
      required: kind === 'dm',
      confirmLabel: kind === 'dm' ? 'Send' : titleCase(kind),
      danger: kind !== 'dm',
    });
    if (text === null || text === undefined) return;
    setBulkBusy(kind);
    try {
      const method = kind === 'dm' ? 'vault.discord.dm' : kind === 'kick' ? 'vault.members.kick' : 'vault.members.ban';
      const results = await Promise.all(ids.map((id) => sendReq(method, kind === 'dm' ? { memberId: id, message: text } : { memberId: id, reason: text }).then(() => true, () => false)));
      const ok = results.filter(Boolean).length;
      ctx.notify(`${kind === 'dm' ? 'DM sent to' : kind === 'kick' ? 'Kicked' : 'Banned'} ${ok}/${count} member(s)`, ok === count ? 'success' : 'warning');
      setSelected(new Set());
      if (kind !== 'dm') load(filters, 0);
    } finally {
      setBulkBusy(null);
    }
  };

  const activeCount = [filters.status, filters.tier, filters.hasWarnings, filters.sortBy !== 'joinedAt'].filter(Boolean).length;

  return (
    <View>
      <View style={{ marginTop: SPACE.md, gap: SPACE.sm }}>
        <Field
          value={searchText}
          onChangeText={onSearch}
          placeholder="Search members..."
          icon="search-outline"
          rightIcon={searchText ? 'close-circle' : undefined}
          rightLabel="Clear search"
          onRightPress={() => { setSearchText(''); applyFilters({ search: '' }); }}
          returnKeyType="search"
          onSubmitEditing={() => applyFilters({ search: searchText })}
          accessibilityLabel="Search members"
        />
        <View style={styles.row}>
          <Chip
            label={activeCount ? `Filters (${activeCount})` : 'Filters'}
            icon="options-outline"
            selected={showFilters}
            tone="primary"
            onPress={() => setShowFilters((v) => !v)}
            accessibilityLabel="Toggle member filters"
          />
          <Chip
            label="Warnings"
            icon="warning-outline"
            tone="warning"
            selected={filters.hasWarnings}
            onPress={() => applyFilters({ hasWarnings: !filters.hasWarnings })}
            accessibilityLabel="Only members with warnings"
          />
          <View style={{ flex: 1 }} />
          <Button title="Add" icon="person-add-outline" size="sm" variant="secondary" onPress={() => setAddOpen(true)} />
        </View>
        {showFilters ? (
          <Card padded>
            <View style={{ gap: SPACE.md }}>
            <OptionChips label="Status" options={MEMBER_STATUSES.map((s) => ({ key: s, label: titleCase(s) }))} value={filters.status} allowNone noneLabel="All status" onChange={(v) => applyFilters({ status: v })} />
            <OptionChips label="Tier" options={FILTER_TIERS.map((t) => ({ key: t, label: titleCase(t) }))} value={filters.tier} allowNone noneLabel="All tiers" onChange={(v) => applyFilters({ tier: v })} />
            <OptionChips label="Sort" options={MEMBER_SORTS} value={filters.sortBy} onChange={(v) => applyFilters({ sortBy: v || 'joinedAt' })} />
            </View>
          </Card>
        ) : null}
      </View>

      {selecting ? (
        <Card padded tint="warning" style={{ marginTop: SPACE.md }}>
          <View style={{ gap: SPACE.sm }}>
          <Text style={[type.smallStrong, { color: colors.text }]}>{selected.size} member{selected.size > 1 ? 's' : ''} selected</Text>
          <View style={styles.row}>
            <Button title="DM all" icon="chatbubble-outline" size="sm" variant="secondary" loading={bulkBusy === 'dm'} onPress={() => bulk('dm')} />
            <Button title={`Kick ${selected.size}`} size="sm" variant="danger" loading={bulkBusy === 'kick'} onPress={() => bulk('kick')} />
            <Button title={`Ban ${selected.size}`} size="sm" variant="danger" loading={bulkBusy === 'ban'} onPress={() => bulk('ban')} />
            <Button title="Clear" icon="close" size="sm" variant="ghost" onPress={() => setSelected(new Set())} />
          </View>
          <Text style={[type.caption, { color: colors.textMuted }]}>Export is not available yet (no backend endpoint, same as the web).</Text>
          </View>
        </Card>
      ) : null}

      <SectionTitle
        title="Members"
        count={members ? visible.length : undefined}
        subtitle={members && visible.length ? 'Long-press to select for bulk actions' : undefined}
      />

      {error ? (
        <SectionError error={error} onRetry={() => load(filters, 0)} what="vault members" />
      ) : !members ? (
        <Card padded={false}><SkeletonRow avatar /><SkeletonRow avatar /><SkeletonRow avatar /></Card>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={hasActiveMemberFilters(filters) ? 'search-outline' : 'people-outline'}
          title={hasActiveMemberFilters(filters) ? 'No members match these filters' : 'No members loaded yet'}
          message={hasActiveMemberFilters(filters) ? undefined : 'Sync your Discord server to import members, or add one manually.'}
          actionLabel={hasActiveMemberFilters(filters) ? 'Clear filters' : 'Add member'}
          onAction={hasActiveMemberFilters(filters) ? clearFilters : () => setAddOpen(true)}
          compact
        />
      ) : (
        <Card padded={false}>
          {visible.map((m, i) => {
            const isSel = selected.has(m.id);
            return (
              <View key={m.id || i}>
                {i > 0 ? <Divider inset /> : null}
                <ListRow
                  selected={isSel}
                  leading={<Avatar uri={m.avatar} name={m.username} size={36} online={isOnline(m.lastActive)} />}
                  title={m.username}
                  subtitle={`${m.engagementScore}% engaged · ${m.coursesCompleted}/${m.coursesCompleted + m.coursesInProgress} courses · ${timeAgo(m.lastActive)}`}
                  meta={
                    <View style={styles.metaRow}>
                      <StatusChip status={m.status} size="sm" />
                      {m.tier && m.tier !== 'free' ? <Chip label={m.tier.toUpperCase()} tone="primary" size="sm" /> : null}
                      {m.warningCount > 0 ? <Chip label={`${m.warningCount}`} icon="warning-outline" tone="warning" size="sm" /> : null}
                    </View>
                  }
                  trailing={selecting ? <Text style={[type.caption, { color: isSel ? colors.primary : colors.textMuted }]}>{isSel ? 'Selected' : ''}</Text> : undefined}
                  onPress={() => (selecting ? toggleSel(m.id) : setOpenMember(m))}
                  onLongPress={() => toggleSel(m.id)}
                  accessibilityLabel={`${m.username}, ${m.status}, ${m.tier} tier`}
                  accessibilityHint="Opens the member profile. Long-press to select."
                />
              </View>
            );
          })}
        </Card>
      )}

      {hasMore ? (
        <Button title="Load more" variant="ghost" icon="chevron-down" loading={loading} onPress={() => load(filters, page + 1)} style={{ marginTop: SPACE.md }} />
      ) : null}

      <MemberSheet
        ctx={ctx}
        member={openMember}
        onClose={() => setOpenMember(null)}
        onChanged={(m) => {
          if (m) {
            setOpenMember(m);
            setMembers((prev) => (prev || []).map((x) => (x.id === m.id ? m : x)));
          } else {
            setOpenMember(null);
            load(filters, 0);
          }
        }}
      />
      <AddMemberSheet ctx={ctx} visible={addOpen} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); load(filters, 0); }} />
    </View>
  );
}

// ── Profile sheet ────────────────────────────────────────────

function MemberSheet({ ctx, member, onClose, onChanged }) {
  const { colors, type } = useUIKit();
  const { sendReq, dialogs } = ctx;
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(null);
  const [warnOpen, setWarnOpen] = useState(false);
  const [history, setHistory] = useState(null);

  useEffect(() => {
    setNotes(member?.notes || '');
    setHistory(null);
    if (member?.id && sendReq) {
      sendReq('vault.moderation.logs', { memberId: member.id, limit: 20 })
        .then((r) => setHistory((r?.logs || []).map(normalizeModLog)))
        .catch(() => setHistory([]));
    }
  }, [member?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!member) return null;
  const online = isOnline(member.lastActive);
  const guildRoles = sortRoles(ctx.guild?.roles || []);
  const named = roleNames(member.roles, ctx.guild?.roles);

  const refetch = async () => {
    try {
      const r = await sendReq('vault.members.get', { id: member.id });
      if (r?.member) onChanged(normalizeMember(r.member));
    } catch {
      /* keep the optimistic copy */
    }
  };

  const run = async (key, fn, okText) => {
    setBusy(key);
    try {
      await fn();
      if (okText) ctx.notify(okText);
      return true;
    } catch (e) {
      ctx.fail(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const setTier = (tier) => run('tier', async () => {
    await sendReq('vault.members.update', { id: member.id, tier });
    onChanged({ ...member, tier });
  }, `Tier set to ${titleCase(tier)}`);

  const saveNotes = () => run('notes', async () => {
    await sendReq('vault.members.update', { id: member.id, notes });
    onChanged({ ...member, notes });
  }, 'Notes saved');

  const dm = async () => {
    const text = await dialogs.prompt({ title: `DM ${member.username}`, placeholder: 'Message...', multiline: true, required: true, confirmLabel: 'Send' });
    if (!text) return;
    run('dm', () => sendReq('vault.discord.dm', { memberId: member.id, message: text }), 'DM sent');
  };

  const removeMember = async (kind) => {
    const reason = await dialogs.prompt({ title: `${titleCase(kind)} ${member.username}?`, message: 'Reason (written to the mod log).', placeholder: 'Reason...', confirmLabel: titleCase(kind), danger: true });
    if (reason === null || reason === undefined) return;
    const ok = await run(kind, () => sendReq(kind === 'kick' ? 'vault.members.kick' : 'vault.members.ban', { memberId: member.id, reason }), `${member.username} ${kind === 'kick' ? 'kicked' : 'banned'}`);
    if (ok) onChanged(null);
  };

  const unban = async () => {
    const ok = await run('unban', () => sendReq('vault.members.unban', { memberId: member.id }), `${member.username} unbanned`);
    if (ok) onChanged(null);
  };

  const clearWarnings = async () => {
    const ok = await dialogs.confirm({ title: 'Clear all warnings?', message: `Removes ${member.warningCount} warning(s) from ${member.username}.`, confirmLabel: 'Clear all', danger: true });
    if (!ok) return;
    run('clear', async () => {
      await sendReq('vault.moderation.clearWarnings', { memberId: member.id });
      onChanged({ ...member, warningCount: 0, warnings: [] });
    }, 'Warnings cleared');
  };

  const toggleRole = async (role) => {
    const has = member.roles.includes(String(role.id));
    const ok = await dialogs.confirm({
      title: `${has ? 'Remove' : 'Assign'} role ${role.name}?`,
      message: `${has ? 'Removes' : 'Assigns'} the Discord role for ${member.username}.`,
      confirmLabel: has ? 'Remove' : 'Assign',
      danger: has,
    });
    if (!ok) return;
    run(`role:${role.id}`, async () => {
      await sendReq(has ? 'vault.discord.roles.remove' : 'vault.discord.roles.assign', { memberId: member.id, roleId: role.id });
      onChanged({ ...member, roles: has ? member.roles.filter((r) => r !== String(role.id)) : [...member.roles, String(role.id)] });
    }, has ? 'Role removed' : 'Role assigned');
  };

  return (
    <>
      <BottomSheet
        visible={Boolean(member) && !warnOpen}
        onClose={onClose}
        title={`${member.username}${member.discriminator ? `#${member.discriminator}` : ''}`}
        subtitle={online ? 'Online' : `Last active ${timeAgo(member.lastActive)}`}
        footer={
          <View style={styles.actions}>
            <Button title="DM" icon="chatbubble-outline" size="sm" variant="secondary" loading={busy === 'dm'} onPress={dm} />
            <Button title="Warn" icon="warning-outline" size="sm" variant="secondary" onPress={() => setWarnOpen(true)} />
            {member.status !== 'banned' ? (
              <>
                <Button title="Kick" size="sm" variant="danger" loading={busy === 'kick'} onPress={() => removeMember('kick')} />
                <Button title="Ban" size="sm" variant="danger" loading={busy === 'ban'} onPress={() => removeMember('ban')} />
              </>
            ) : (
              <Button title="Unban" icon="checkmark-circle-outline" size="sm" variant="secondary" loading={busy === 'unban'} onPress={unban} />
            )}
          </View>
        }
      >
        <View style={{ gap: SPACE.md }}>
          <View style={styles.hero}>
            <Avatar uri={member.avatar} name={member.username} size={56} online={online} />
            <View style={styles.metaRow}>
              <StatusChip status={member.status} />
              <Chip label={member.tier.toUpperCase()} tone="primary" />
            </View>
          </View>

          <Card padded>
            <Text style={[type.label, { color: colors.textSecondary, marginBottom: SPACE.xs }]}>Member info</Text>
            <KV label="Vault ID" value={member.id} />
            <KV label="Discord ID" value={member.discordId} />
            <KV label="Joined" value={formatDate(member.joinedAt)} mono={false} />
            <KV label="Last active" value={member.lastActive ? timeAgo(member.lastActive) : 'Never'} mono={false} />
            {member.email ? <KV label="Email" value={member.email} /> : null}
            {member.paymentSource ? <KV label="Payment" value={`${member.paymentSource}${member.subscriptionStatus ? ` · ${member.subscriptionStatus}` : ''}`} mono={false} /> : null}
          </Card>

          <Card padded>
            <Text style={[type.label, { color: colors.textSecondary, marginBottom: SPACE.xs }]}>Engagement</Text>
            <KV label="Score" value={`${member.engagementScore}%`} />
            <KV label="Courses completed" value={member.coursesCompleted} />
            <KV label="In progress" value={member.coursesInProgress} />
          </Card>

          <OptionChips
            label={busy === 'tier' ? 'Tier (saving...)' : 'Tier'}
            options={MEMBER_TIERS.map((t) => ({ key: t, label: titleCase(t) }))}
            value={member.tier}
            onChange={(t) => t && t !== member.tier && setTier(t)}
          />

          <View style={{ gap: SPACE.xs }}>
            <Text style={[type.label, { color: colors.textSecondary }]}>Roles</Text>
            {named.length === 0 ? (
              <Text style={[type.small, { color: colors.textMuted }]}>No roles assigned</Text>
            ) : (
              <View style={styles.metaRow}>
                {named.map((r) => <Chip key={r.id} label={r.name} color={r.color || undefined} dot={Boolean(r.color)} size="sm" />)}
              </View>
            )}
            {guildRoles.length ? (
              <>
                <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>Tap a Discord role to assign or remove it</Text>
                <View style={styles.metaRow}>
                  {guildRoles.filter((r) => !r.managed).slice(0, 40).map((r) => (
                    <Chip
                      key={r.id}
                      label={busy === `role:${r.id}` ? `${r.name}...` : r.name}
                      selected={member.roles.includes(String(r.id))}
                      tone="primary"
                      onPress={() => toggleRole(r)}
                      accessibilityLabel={`${member.roles.includes(String(r.id)) ? 'Remove' : 'Assign'} role ${r.name}`}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </View>

          {member.warningCount > 0 ? (
            <Card padded tint="warning">
              <View style={styles.warnRow}>
                <Text style={[type.smallStrong, { color: colors.warning, flex: 1 }]}>{member.warningCount} warning(s)</Text>
                <Button title="Clear all" size="sm" variant="secondary" loading={busy === 'clear'} onPress={clearWarnings} />
              </View>
            </Card>
          ) : null}

          <View style={{ gap: SPACE.sm }}>
            <Field label="Notes" value={notes} onChangeText={setNotes} placeholder="Add notes about this member..." multiline rows={3} />
            {notes !== (member.notes || '') ? (
              <Button title="Save notes" size="sm" variant="secondary" icon="save-outline" loading={busy === 'notes'} onPress={saveNotes} />
            ) : null}
          </View>

          <View style={{ gap: SPACE.xs }}>
            <Text style={[type.label, { color: colors.textSecondary }]}>Moderation history</Text>
            {history === null ? (
              <Text style={[type.caption, { color: colors.textMuted }]}>Loading...</Text>
            ) : history.length === 0 ? (
              <Text style={[type.caption, { color: colors.textMuted }]}>No moderation actions recorded</Text>
            ) : (
              history.map((h) => (
                <ListRow
                  key={h.id}
                  dense
                  icon={modActionIcon(h.action)}
                  iconTone={modActionTone(h.action)}
                  title={titleCase(h.action)}
                  subtitle={`${h.reason || 'No reason'} · by ${h.moderator}${h.auto ? ' (auto)' : ''}`}
                  value={timeAgo(h.timestamp)}
                />
              ))
            )}
          </View>
        </View>
      </BottomSheet>
      <WarnSheet ctx={ctx} member={warnOpen ? member : null} onClose={() => setWarnOpen(false)} onDone={() => { setWarnOpen(false); refetch(); }} />
    </>
  );
}

function WarnSheet({ ctx, member, onClose, onDone }) {
  const [severity, setSeverity] = useState('low');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (member) {
      setSeverity('low');
      setReason('');
    }
  }, [member?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!member) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await ctx.sendReq('vault.members.warn', { memberId: member.id, reason, severity });
      ctx.notify(`Warning issued to ${member.username}`);
      onDone();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet
      visible
      onClose={onClose}
      title="Issue warning"
      subtitle={member.username}
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Issue warning" icon="warning-outline" onPress={submit} loading={busy} disabled={!reason.trim()} />
        </View>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <OptionChips label="Severity" options={SEVERITIES.map((s) => ({ key: s, label: titleCase(s), tone: s === 'low' ? 'info' : s === 'medium' ? 'warning' : 'danger' }))} value={severity} onChange={(v) => v && setSeverity(v)} />
        <Field label="Reason" value={reason} onChangeText={setReason} placeholder="Reason for warning..." multiline rows={4} required />
      </View>
    </BottomSheet>
  );
}

function AddMemberSheet({ ctx, visible, onClose, onCreated }) {
  const [form, setForm] = useState({ discordId: '', discordUsername: '', email: '', tier: 'free' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) setForm({ discordId: '', discordUsername: '', email: '', tier: 'free' });
  }, [visible]);
  const submit = async () => {
    setBusy(true);
    try {
      await ctx.sendReq('vault.members.create', buildMemberCreateParams(form));
      ctx.notify('Member added');
      onCreated();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Add member"
      subtitle="Creates a vault member record"
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Add member" icon="person-add-outline" onPress={submit} loading={busy} disabled={!canCreateMember(form)} />
        </View>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <Field label="Discord username" value={form.discordUsername} onChangeText={(v) => setForm({ ...form, discordUsername: v })} placeholder="username" autoCapitalize="none" />
        <Field label="Discord ID" value={form.discordId} onChangeText={(v) => setForm({ ...form, discordId: v })} placeholder="123456789012345678" keyboardType="number-pad" mono />
        <Field label="Email" value={form.email} onChangeText={(v) => setForm({ ...form, email: v })} placeholder="member@example.com" keyboardType="email-address" autoCapitalize="none" />
        <OptionChips label="Tier" options={MEMBER_TIERS.map((t) => ({ key: t, label: titleCase(t) }))} value={form.tier} onChange={(v) => v && setForm({ ...form, tier: v })} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, alignItems: 'center' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, justifyContent: 'flex-end' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
});

export default VaultMembers;
