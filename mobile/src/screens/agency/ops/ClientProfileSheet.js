/**
 * Client profile (web renderClientProfile): hero stats, launch an autonomous
 * agent (sessions.spawn), upcoming deadlines, projects, related notes
 * (notes.list / notes.create tagged client:<id>), activity timeline and the
 * per-client project board (move status, run agent per project).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, Button, Chip, Field, SPACE, useUIKit } from '../../../ui-kit';
import { PROJECT_STATUSES, clientNoteTag, clientProfile, humanize, money, moneyCents, normalizeNotes, shortDate, titleCase } from './agency-ops-model';
import { Actions, ActionButton, Avatar, Empty, Meta, Notice, Row, SelectField, StatPairs, Tile, Title } from './ui';

function Section({ title, children }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.borderSubtle, paddingTop: SPACE.md, marginTop: SPACE.md, gap: SPACE.xs }}>
      <Text style={[type.label, { color: colors.textSecondary }]}>{title}</Text>
      {children}
    </View>
  );
}

export function ClientProfileSheet({ ctx, clientId, onClose }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const s = ops.state;
  const client = s.clients.find((c) => c.id === clientId);
  const [notes, setNotes] = useState({ loading: false, list: [] });
  const [noteDraft, setNoteDraft] = useState('');
  const [task, setTask] = useState('');
  const [agentNotice, setAgentNotice] = useState(null);
  const currency = s.finance.currency;

  const loadNotes = useCallback(async () => {
    if (!clientId) return;
    setNotes((n) => ({ ...n, loading: true }));
    try { setNotes({ loading: false, list: normalizeNotes(await ops.req('notes.list', { tags: [clientNoteTag(clientId)], limit: 100 })) }); } catch { setNotes({ loading: false, list: [] }); }
  }, [ops, clientId]);
  useEffect(() => { if (clientId) { setNoteDraft(''); setTask(''); setAgentNotice(null); loadNotes(); } }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!client) return <BottomSheet visible={false} onClose={onClose} title="" />;
  const p = clientProfile(s, client.id, notes.list);

  const addNote = async () => {
    try {
      await ops.call('notes.create', { name: `${client.name} · ${new Date().toLocaleDateString()}`, body: noteDraft.trim(), category: 'client', tags: [clientNoteTag(client.id), 'client'] }, { busyKey: 'client-note' });
      setNoteDraft('');
      loadNotes();
    } catch { /* recorded */ }
  };
  const launch = async (text, project) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    const scope = project ? ` This work is for the project "${project.name}".` : '';
    try {
      const r = await ops.call('sessions.spawn', { task: `Autonomous task for agency client "${client.name}".${scope}\n\n${t}`, agentId: 'coder', label: `${client.name}: ${t.slice(0, 48)}`, autonomous: true }, { busyKey: project ? `agent:${project.id}` : 'client-agent', quiet: true });
      setAgentNotice({ tone: 'success', text: `Agent launched (${r?.status ?? 'accepted'}) for ${client.name}.` });
      if (!project) setTask('');
    } catch (e) { setAgentNotice({ tone: 'danger', text: `Failed to launch agent: ${e?.message || e}` }); }
  };

  return (
    <BottomSheet visible onClose={onClose} title={client.name} subtitle={client.pipelineStatusLabel ?? titleCase(client.status)} maxHeightRatio={0.94}>
      <Row>
        <Avatar name={client.name} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          {client.billingEmail ? <Meta><Ionicons name="mail-outline" size={12} /> {client.billingEmail}</Meta> : null}
          {client.phone ? <Meta><Ionicons name="call-outline" size={12} /> {client.phone}</Meta> : null}
        </View>
      </Row>
      <Actions style={{ marginTop: SPACE.sm }}>
        <Button title="Edit client" size="sm" variant="secondary" onPress={() => ctx.openDialog('client-edit', { entityId: client.id })} accessibilityLabel="Edit client" />
        <Button title="Revenue" size="sm" variant="secondary" onPress={() => ctx.openClientRevenue(client.id)} accessibilityLabel="Open client revenue" />
        <Button title="Projects" size="sm" variant="secondary" onPress={() => ctx.focusClientProjects(client.id)} accessibilityLabel="Open client projects" />
        <Button title="+ Invoice" size="sm" onPress={() => ctx.openInvoiceComposer({ clientId: client.id })} accessibilityLabel="Invoice this client" />
      </Actions>
      <StatPairs cols={2} pairs={[
        { label: 'Projects', value: String(p.projects.length) },
        { label: 'Invoices', value: String(p.invoices.length) },
        { label: 'MRR', value: money((client.mrrCents ?? 0) / 100, currency) },
        { label: 'Outstanding', value: moneyCents(client.outstandingCents ?? 0, currency), tone: client.outstandingCents > 0 ? 'warning' : undefined },
      ]}
      />

      <Section title="Launch an autonomous agent for this client">
        <Meta>Describe a task and dispatch a coder to carry it out. Runs through the agency's subagent system and appears in your agents list.</Meta>
        <Field value={task} onChangeText={setTask} multiline rows={3} placeholder={`e.g. Draft the Q3 content plan and outline deliverables for ${client.name}…`} accessibilityLabel="Agent task" />
        <Button title="Launch agent" size="sm" loading={ops.busy === 'client-agent'} disabled={!task.trim()} onPress={() => launch(task)} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Launch agent" />
        {agentNotice ? <Notice tone={agentNotice.tone} text={agentNotice.text} /> : null}
      </Section>

      <Section title="Upcoming deadlines">
        {p.deadlines.length ? p.deadlines.slice(0, 12).map((d, i) => (
          <Row key={`${d.kind}-${i}`}>
            <Ionicons name={d.kind === 'project' ? 'flag-outline' : 'checkbox-outline'} size={14} color={d.overdue ? colors.error : colors.primary} />
            <View style={{ flex: 1 }}><Title numberOfLines={1}>{d.name}</Title><Meta>{d.kind === 'project' ? 'Project' : 'Task'} · {d.context}</Meta></View>
            <Meta style={d.overdue ? { color: colors.error } : null}>{shortDate(d.due)}{d.overdue ? ' · overdue' : ''}</Meta>
          </Row>
        )) : <Meta>No upcoming deadlines. Add due dates to this client's projects or tasks.</Meta>}
      </Section>

      <Section title="Projects">
        {p.projects.length ? p.projects.map((pr) => (
          <Tile key={pr.id} onPress={() => { onClose(); ctx.openProject(pr.id); }} accessibilityLabel={`Open project ${pr.name}`}>
            <Row><Title style={{ flex: 1 }}>{pr.name}</Title><Chip size="sm" label={humanize(pr.status)} /></Row>
            <Meta>{pr.budgetCents ? `${money(pr.budgetCents / 100, currency)} budget` : 'No budget set'}{pr.targetEndAt ? ` · due ${shortDate(pr.targetEndAt)}` : ''}</Meta>
            <SelectField label="Board column" value={pr.status} options={PROJECT_STATUSES} onChange={(st) => ctx.transitionProject(pr.id, st)} compact />
            <ActionButton title="Run agent" loading={ops.busy === `agent:${pr.id}`} onPress={() => launch(`Advance the project "${pr.name}".`, pr)} accessibilityLabel={`Run an agent on ${pr.name}`} />
          </Tile>
        )) : <Empty icon="albums-outline" text="No projects linked to this client yet." actionLabel="+ Project" onAction={() => ctx.openDialog('project', { entityId: client.id })} />}
      </Section>

      <Section title="Related notes">
        <Field value={noteDraft} onChangeText={setNoteDraft} multiline rows={3} placeholder={`Add a note about ${client.name}…`} accessibilityLabel="New note" />
        <Button title="Add note" size="sm" loading={ops.busy === 'client-note'} disabled={!noteDraft.trim()} onPress={addNote} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Add note" />
        {notes.loading ? <Meta>Loading notes…</Meta> : notes.list.length ? notes.list.map((n) => (
          <Tile key={n.id}>
            <Row><Title style={{ flex: 1 }}>{n.name}</Title><Meta>{shortDate(n.updatedAt)}</Meta></Row>
            <Text style={[type.small, { color: colors.textSecondary }]}>{n.body}</Text>
          </Tile>
        )) : <Meta>No related notes yet. Add the first one above.</Meta>}
      </Section>

      <Section title="Activity timeline">
        {p.timeline.length ? p.timeline.slice(0, 20).map((ev, i) => (
          <Row key={i}>
            <Ionicons name={ev.icon} size={14} color={colors.primary} />
            <View style={{ flex: 1 }}><Meta style={{ color: colors.text }} numberOfLines={2}>{ev.label}</Meta>{ev.sub ? <Meta numberOfLines={1}>{ev.sub}</Meta> : null}</View>
            <Meta>{shortDate(ev.ts)}</Meta>
          </Row>
        )) : <Meta>No activity recorded yet.</Meta>}
      </Section>
    </BottomSheet>
  );
}
