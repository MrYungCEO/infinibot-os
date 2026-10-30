/**
 * Native Knowledge Graph cards and sheets — ports of the web graph's
 * renderHoverCard (tap = peek card), renderDetail, renderMenu (long-press =
 * bottom-sheet menu, as on the web phone layout), renderBulkBar and
 * renderSettings. Same sections, same actions, same wording.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import * as core from './generated/kg-core';
import { KgButton, Pill } from './KgChrome';
import { KG, KG_INTER, KG_MONO, kgSheet, kgStyles } from './kg-theme';
import { rgba } from './kg-colors';
import { canOpenNode } from './kg-open';

const { BULK_STATUSES, GROUP_MODES, HEALTH_COLOR, HEALTH_LABEL, KIND_LABEL, KIND_ORDER, KIND_PALETTE, KIND_SINGULAR, canReassign, relativeAge, truncate } = core;

function Head({ n, onClose }) {
  return (
    <View style={styles.head}>
      <View style={[styles.dot, { backgroundColor: n.color }, n.kind === 'client' && styles.hex]} />
      <Text style={styles.kind}>{KIND_SINGULAR[n.kind] ?? n.kind}</Text>
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={10} style={{ marginLeft: 'auto' }} accessibilityLabel="Close" testID="kg-card-close">
          <Ionicons name="close" size={20} color={KG.dim} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Mini({ icon, label, onPress, testID, small }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.mini, small && styles.hcMini, pressed && { opacity: 0.7 }]} testID={testID} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={icon} size={small ? 13 : 15} color={KG.goldSoft} />
      <Text style={small ? styles.hcMiniText : styles.miniText}>{label}</Text>
    </Pressable>
  );
}

function Progress({ value }) {
  return (
    <View style={styles.progress}>
      <View style={[styles.progressBar, { width: `${value}%` }]} />
    </View>
  );
}

/** Tap on a node — the web hover card, pinned (Chat / Select / Focus / Open / Details). */
export function KgPeekCard({ c, id, style, scrollBody = false }) {
  const n = c.nodeById.get(id);
  if (!n) return null;
  const m = n.meta ?? {};
  const isProject = n.kind === 'project';
  const tasks = Number(m.tasks ?? 0);
  const progress = Math.round(Math.max(0, Math.min(1, Number(m.progress ?? 0))) * 100);
  const statusText = isProject ? HEALTH_LABEL[n.health ?? 'backlog'] : String(m.pipelineStatus ?? m.status ?? '').replace(/_/g, ' ');
  const statusColor = isProject ? HEALTH_COLOR[n.health ?? 'backlog'] : n.color;
  const last = Number(m.lastActivityAt ?? 0) || Number(m.updatedAt ?? 0) || Date.parse(String(m.updatedAt ?? '')) || 0;
  const neighbours = [...(c.adjacency.get(n.id) ?? [])]
    .map((x) => c.nodeById.get(x))
    .filter(Boolean)
    .sort((a, b) => Number(b.anchor) - Number(a.anchor) || (c.adjacency.get(b.id)?.size ?? 0) - (c.adjacency.get(a.id)?.size ?? 0));
  const owners = neighbours.filter((x) => x.kind === 'agent' || x.kind === 'person').map((x) => x.label);
  if (typeof m.assignedAgent === 'string' && m.assignedAgent) owners.unshift(m.assignedAgent);
  const runs = neighbours.filter((x) => x.kind === 'run');
  const top = neighbours.filter((x) => x.kind !== 'agent').slice(0, 4);
  const live = m.live === true || m.active === true;
  return (
    <View style={[kgStyles.panel, styles.card, styles.hc, style]} testID="kg-peek">
      <Head n={n} onClose={() => c.closeCard()} />
      <Body scroll={scrollBody}>
      <View style={styles.pills}>
        {statusText ? <Pill text={statusText} color={statusColor} /> : null}
        {live ? <Pill text="live" color={KG.ok} live /> : null}
      </View>
      <Text style={styles.hcTitle} numberOfLines={2}>{n.label}</Text>
      {isProject ? (
        tasks > 0 ? (
          <>
            <Progress value={progress} />
            <Text style={styles.hcRow}><Text style={{ fontFamily: KG_MONO[700], color: KG.fg }}>{progress}%</Text> · {Number(m.done ?? 0).toLocaleString()} / {tasks.toLocaleString()} tasks</Text>
            <View style={styles.counts}>
              <Text style={styles.hcCnt}>{Number(m.inProgress ?? 0)} doing</Text>
              <Text style={styles.hcCnt}>{Number(m.review ?? 0)} review</Text>
              <Text style={[styles.hcCnt, Number(m.blocked ?? 0) && { color: KG.danger }]}>{Number(m.blocked ?? 0)} blocked</Text>
              <Text style={[styles.hcCnt, Number(m.overdue ?? 0) && { color: KG.warn }]}>{Number(m.overdue ?? 0)} overdue</Text>
            </View>
          </>
        ) : (
          <Text style={styles.hcRow}>No tasks yet</Text>
        )
      ) : null}
      <View style={styles.hcMeta}>
        {owners.length ? <Meta small icon="hardware-chip-outline" text={owners.slice(0, 2).join(', ')} /> : null}
        {runs.length ? <Meta small icon="pulse-outline" text={`${runs.length} run${runs.length > 1 ? 's' : ''}`} /> : null}
        <Meta small icon="time-outline" text={relativeAge(last)} />
        <Meta small icon="link-outline" text={String(neighbours.length)} />
      </View>
      {top.length ? (
        <View style={styles.hcLinks}>
          {top.map((x) => (
            <Pressable key={x.id} style={styles.hcLinkRow} onPress={() => { c.stageCallbacks.onSelect(x.id); }}>
              <View style={[styles.dot, { backgroundColor: x.color, width: 6, height: 6 }]} />
              <Text style={styles.hcLinkText} numberOfLines={1}>{truncate(x.label, 30)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      </Body>
      <View style={[styles.actions, scrollBody && styles.actionsFixed]}>
        <Mini small icon="chatbubble-outline" label="Chat" onPress={() => c.openAi('chat', [n.id])} testID="kg-peek-chat" />
        <Mini small icon="checkmark" label={c.selection.has(n.id) ? 'Unselect' : 'Select'} onPress={() => c.toggleSelected(n.id)} testID="kg-peek-select" />
        <Mini small icon="locate-outline" label="Focus" onPress={() => { c.selectNode(n.id); c.emit(); }} testID="kg-peek-focus" />
        {canOpenNode(n) ? <Mini small icon="open-outline" label="Open" onPress={() => c.openNode(n)} testID="kg-peek-open" /> : null}
        <Mini small icon="document-text-outline" label="Details" onPress={() => c.openDetails(n.id)} testID="kg-peek-details" />
      </View>
    </View>
  );
}

/** The card's middle: scrolls on its own (header + actions stay put) when the card is height-capped. */
function Body({ scroll, children }) {
  if (!scroll) return <>{children}</>;
  return (
    <ScrollView style={styles.body} contentContainerStyle={{ gap: 4 }} bounces={false} showsVerticalScrollIndicator={false} nestedScrollEnabled>
      {children}
    </ScrollView>
  );
}

function Meta({ icon, text, small }) {
  return (
    <View style={styles.metaItem}>
      <Ionicons name={icon} size={12} color={small ? KG.gold : KG.dim} />
      <Text style={small ? styles.hcMetaText : styles.metaText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

function Stat({ label, value, alert }) {
  const n = Number(value ?? 0);
  return (
    <View style={styles.stat}>
      <Text style={[styles.statN, n > 0 && alert && { color: alert }]}>{n.toLocaleString()}</Text>
      <Text style={styles.statL}>{label}</Text>
    </View>
  );
}

function metaRows(sel) {
  const m = sel.meta ?? {};
  const rows = [];
  if (sel.kind === 'client' && m.projects != null) rows.push(['Projects', `${m.openProjects ?? 0} open / ${m.projects}`]);
  if (sel.kind === 'run') {
    if (m.agentId) rows.push(['Agent', String(m.agentId)]);
    if (m.startedAt) rows.push(['Started', relativeAge(Number(m.startedAt))]);
  }
  if (m.priority) rows.push(['Priority', String(m.priority)]);
  if (typeof m.value === 'number' && m.value > 0) rows.push(['Value', m.value.toLocaleString()]);
  if (Array.isArray(m.tags) && m.tags.length) rows.push(['Tags', m.tags.slice(0, 5).join(', ')]);
  const upd = Number(m.updatedAt ?? 0) || Date.parse(String(m.updatedAt ?? ''));
  if (upd) rows.push(['Updated', relativeAge(upd)]);
  return rows;
}

/** The web detail panel (relations by kind, rollups, AI row, actions). */
export function KgDetailPanel({ c, id, style }) {
  const sel = c.nodeById.get(id);
  if (!sel) return null;
  const meta = sel.meta ?? {};
  const rels = c.relations.get(sel.id) ?? [];
  const groups = new Map();
  for (const r of rels) {
    const other = c.nodeById.get(r.other);
    if (!other) continue;
    const arr = groups.get(other.kind) ?? groups.set(other.kind, []).get(other.kind);
    if (!arr.some((x) => x.node.id === other.id)) arr.push({ node: other, rel: r.rel });
  }
  const ordered = KIND_ORDER.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)]);
  const isProject = sel.kind === 'project';
  const expanded = c.expanded.has(sel.id);
  const expanding = c.expanding.has(sel.id);
  const statusText = isProject ? HEALTH_LABEL[sel.health ?? 'backlog'] : String(meta.pipelineStatus ?? meta.status ?? '');
  const statusColor = isProject ? HEALTH_COLOR[sel.health ?? 'backlog'] : sel.color;
  const tasks = Number(meta.tasks ?? 0);
  const progress = Math.round(Math.max(0, Math.min(1, Number(meta.progress ?? 0))) * 100);
  return (
    <View style={[kgStyles.panel, styles.detail, style]} testID="kg-detail">
      <Head n={sel} onClose={() => { c.clearSelection(); c.emit(); }} />
      <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 4 }} nestedScrollEnabled>
        <Text style={styles.detailTitle}>{sel.label}</Text>
        <View style={styles.pills}>
          {statusText ? <Pill text={statusText} color={statusColor} /> : null}
          {meta.live === true || meta.active === true ? <Pill text="agent working" color={KG.ok} live /> : null}
          {isProject && meta.status && String(meta.status) !== statusText ? <Pill text={String(meta.status)} /> : null}
        </View>
        {isProject ? (
          <>
            {tasks > 0 ? (
              <>
                <Progress value={progress} />
                <Text style={styles.row}>{progress}% · {Number(meta.done ?? 0).toLocaleString()} / {tasks.toLocaleString()} tasks</Text>
                <View style={styles.stats}>
                  <Stat label="In progress" value={meta.inProgress} />
                  <Stat label="Review" value={meta.review} />
                  <Stat label="Blocked" value={meta.blocked} alert={KG.danger} />
                  <Stat label="Overdue" value={meta.overdue} alert={KG.warn} />
                </View>
              </>
            ) : (
              <Text style={kgStyles.muted}>No tasks yet</Text>
            )}
            <View style={styles.kv}><Text style={styles.k}>Last activity</Text><Text style={styles.v}>{relativeAge(Number(meta.lastActivityAt ?? 0))}</Text></View>
            {Array.isArray(meta.reasons) && meta.reasons.length ? (
              <View style={styles.reasons}>{meta.reasons.map((r) => <Text key={r} style={styles.reason}>{r}</Text>)}</View>
            ) : null}
          </>
        ) : (
          metaRows(sel).map(([k, v]) => (
            <View key={k} style={styles.kv}><Text style={styles.k}>{k}</Text><Text style={styles.v} numberOfLines={1}>{v}</Text></View>
          ))
        )}
        {ordered.length ? (
          ordered.map(([kind, items]) => (
            <View key={kind} style={styles.relGroup}>
              <View style={styles.relHead}>
                <View style={[styles.dot, { backgroundColor: KIND_PALETTE[kind], width: 7, height: 7 }]} />
                <Text style={styles.relHeadText}>{KIND_LABEL[kind]}</Text>
                <Text style={kgStyles.chipCount}>{items.length}</Text>
              </View>
              {items.slice(0, 6).map((it) => (
                <Pressable key={it.node.id} style={styles.rel} onPress={() => { c.selectNode(it.node.id); c.detailId = it.node.id; c.selection = new Set([it.node.id]); c.syncRings(); c.emit(); }}>
                  <Text style={styles.relName} numberOfLines={1}>{it.node.label}</Text>
                  <Text style={styles.relKind}>{it.rel}</Text>
                </Pressable>
              ))}
              {items.length > 6 ? <Text style={kgStyles.muted}>+{items.length - 6} more</Text> : null}
            </View>
          ))
        ) : (
          <Text style={[kgStyles.muted, { marginTop: 8 }]}>No relations yet.</Text>
        )}
      </ScrollView>
      <View style={styles.aiRow}>
        <Mini icon="chatbubble-outline" label="Chat" onPress={() => c.openAi('chat', [sel.id])} />
        <Mini icon="document-text-outline" label="Summarize" onPress={() => c.openAi('summarize', [sel.id])} />
        <Mini icon="git-network-outline" label="Related" onPress={() => c.openRelated([sel.id])} />
        <Mini icon="hardware-chip-outline" label="Agent" onPress={() => c.openSpawn([sel.id])} />
      </View>
      <View style={styles.btns}>
        {canOpenNode(sel) ? <KgButton icon="open-outline" label="Open" primary onPress={() => c.openNode(sel)} testID="kg-detail-open" /> : null}
        <KgButton icon="link-outline" label="Link" onPress={() => c.openPicker('link', [sel.id])} />
        {canReassign(sel.kind) ? <KgButton icon="folder-outline" label="Move" onPress={() => c.openPicker('move', [sel.id])} /> : null}
        {isProject && tasks > 0 ? (
          <KgButton label={expanding ? 'Loading…' : expanded ? 'Hide tasks' : 'Show tasks'} disabled={expanding} onPress={() => (expanded ? c.collapseProject(sel.id) : void c.expandProject(sel.id))} testID="kg-detail-tasks" />
        ) : null}
        <KgButton label="Focus" onPress={() => c.fitTo(c.nbhOf(sel.id) ?? [sel.id], 1.4)} />
      </View>
    </View>
  );
}

/** Long-press menu (the web's context menu; a bottom sheet on phones). */
export function KgMenuSheet({ c, style }) {
  const menu = c.menu;
  if (!menu) return null;
  const ids = c.actionIds(menu.nodeId);
  const nodes = c.nodesOf(ids);
  if (!nodes.length) return null;
  const one = nodes.length === 1 ? nodes[0] : null;
  const kinds = new Set(nodes.map((n) => n.kind));
  const mergeable = nodes.length > 1 && kinds.size === 1 && (kinds.has('note') || kinds.has('task'));
  const deletable = nodes.some((n) => n.kind === 'task' || n.kind === 'note');
  const movable = nodes.some((n) => canReassign(n.kind));
  const statusable = nodes.some((n) => n.kind === 'task' || n.kind === 'project');
  const Item = ({ icon, label, fn, danger, ai, hint, testID }) => (
    <Pressable
      onPress={() => {
        // Ignore the synthetic press from the finger lifting after the long-press.
        if (c.menuGuarded()) return;
        c.menu = null;
        fn();
        c.emit();
      }}
      style={({ pressed }) => [styles.mi, pressed && { backgroundColor: 'rgba(212,175,55,0.1)' }]}
      testID={testID}
      accessibilityRole="menuitem"
    >
      <Ionicons name={icon} size={18} color={danger ? '#fca5a5' : ai ? KG.cyan : KG.goldSoft} />
      <Text style={[styles.miText, danger && { color: '#fca5a5' }]}>{label}</Text>
      {hint ? <Text style={styles.kbd}>{hint}</Text> : null}
    </Pressable>
  );
  return (
    <View style={[kgStyles.panel, styles.sheet, style]} testID="kg-menu">
      <View style={styles.grab} />
      <Text style={styles.menuHead} numberOfLines={1}>{one ? truncate(one.label, 30) : `${nodes.length} selected`}</Text>
      <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} nestedScrollEnabled>
        <Text style={styles.menuSec}>AI</Text>
        <Item icon="chatbubble-outline" label="Chat with this" ai fn={() => c.openAi('chat', ids)} testID="kg-mi-chat" />
        <Item icon="document-text-outline" label="Summarize" ai fn={() => c.openAi('summarize', ids)} testID="kg-mi-summarize" />
        <Item icon="git-network-outline" label="Find related & suggest links" ai fn={() => c.openRelated(ids)} testID="kg-mi-related" />
        <Item icon="layers-outline" label={mergeable ? 'Consolidate…' : 'Consolidation plan (AI)'} ai fn={() => void c.openConsolidate(ids)} testID="kg-mi-consolidate" />
        <Item icon="color-wand-outline" label="Auto-group (cluster)" ai fn={() => { c.setGroupMode('cluster'); if (nodes.length > 1) c.openAi('cluster', ids); }} />
        <Item icon="hardware-chip-outline" label="Spawn agent on this…" ai fn={() => c.openSpawn(ids)} testID="kg-mi-spawn" />
        <Text style={styles.menuSec}>Graph</Text>
        {one && one.kind === 'project' ? <Item icon="layers-outline" label="Consolidate sub-projects…" fn={() => c.openSubConsolidate(one.id)} testID="kg-mi-subs" /> : null}
        <Item icon="link-outline" label="Link to…" hint="link mode" fn={() => c.openPicker('link', ids)} testID="kg-mi-link" />
        {movable ? <Item icon="folder-outline" label="Move to project…" hint="drag" fn={() => c.openPicker('move', ids)} testID="kg-mi-move" /> : null}
        {statusable ? (
          <View style={styles.miRow}>
            <Ionicons name="checkmark-circle-outline" size={18} color={KG.goldSoft} />
            <Text style={styles.miText}>Status</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 5 }}>
              {BULK_STATUSES.map((st) => (
                <Pressable key={st.id} style={styles.miChip} onPress={() => { if (c.menuGuarded()) return; c.menu = null; void c.bulkStatus(ids, st.id); }} testID={`kg-mi-status-${st.id}`}>
                  <Text style={styles.miChipText}>{st.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
        <Item icon="pricetag-outline" label="Tag…" fn={() => c.openTag(ids)} testID="kg-mi-tag" />
        <Item icon="people-outline" label="Select neighbours" fn={() => c.selectNeighbours(ids)} />
        {one ? <Item icon="locate-outline" label="Focus" fn={() => c.selectNode(one.id)} /> : <Item icon="locate-outline" label="Frame selection" fn={() => c.fitTo(ids, 1.4)} />}
        {one && canOpenNode(one) ? <Item icon="open-outline" label="Open" fn={() => c.openNode(one)} testID="kg-mi-open" /> : null}
        {deletable ? <Item icon="trash-outline" label="Delete…" danger fn={() => c.openDelete(ids)} testID="kg-mi-delete" /> : null}
      </ScrollView>
    </View>
  );
}

/** Multi-selection command bar. */
export function KgBulkBar({ c, style }) {
  const ids = [...c.selection];
  const nodes = c.nodesOf(ids);
  const byKind = new Map();
  for (const n of nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const B = ({ icon, label, onPress, ai, danger, testID }) => (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.bb, ai && styles.bbAi, danger && styles.bbDanger, pressed && { opacity: 0.7 }]} testID={testID}>
      <Ionicons name={icon} size={16} color={danger ? '#fca5a5' : ai ? KG.cyan : KG.goldSoft} />
      {label ? <Text style={[styles.bbText, danger && { color: '#fca5a5' }]}>{label}</Text> : null}
    </Pressable>
  );
  return (
    <View style={[kgStyles.panel, styles.bulk, style]} testID="kg-bulk-bar">
      <View style={styles.bulkCount}>
        <Text style={styles.bulkN}>{nodes.length}<Text style={styles.bulkL}> selected</Text></Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {[...byKind].slice(0, 4).map(([k, n]) => (
            <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={[styles.dot, { backgroundColor: KIND_PALETTE[k], width: 7, height: 7 }]} />
              <Text style={kgStyles.chipCount}>{n}</Text>
            </View>
          ))}
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 5, alignItems: 'center' }}>
        <B icon="chatbubble-outline" label="Chat" ai onPress={() => c.openAi('chat', ids)} testID="kg-bb-chat" />
        <B icon="document-text-outline" label="Summarize" ai onPress={() => c.openAi('summarize', ids)} />
        <B icon="layers-outline" label="Consolidate" ai onPress={() => void c.openConsolidate(ids)} testID="kg-bb-consolidate" />
        <B icon="git-network-outline" label="Related" ai onPress={() => c.openRelated(ids)} />
        <B icon="hardware-chip-outline" label="Agent" ai onPress={() => c.openSpawn(ids)} />
        <View style={styles.bbSep} />
        <B icon="link-outline" label="Link" onPress={() => c.openPicker('link', ids)} />
        <B icon="folder-outline" label="Move" onPress={() => c.openPicker('move', ids)} />
        <B icon="checkmark-circle-outline" label="Status" onPress={() => setStatusOpen((v) => !v)} testID="kg-bb-status" />
        <B icon="pricetag-outline" label="Tag" onPress={() => c.openTag(ids)} />
        <B icon="people-outline" label="Expand" onPress={() => c.selectNeighbours(ids)} />
        <B icon="trash-outline" label="Delete" danger onPress={() => c.openDelete(ids)} />
        <B icon="close" onPress={() => { c.clearSelection(); c.emit(); }} testID="kg-bb-clear" />
      </ScrollView>
      {statusOpen ? (
        <View style={styles.statusPop}>
          {BULK_STATUSES.map((st) => (
            <Pressable key={st.id} style={styles.miChip} onPress={() => { setStatusOpen(false); void c.bulkStatus(ids, st.id); }}>
              <Text style={styles.miChipText}>{st.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Seg({ value, options, onPick, testID }) {
  return (
    <View style={styles.seg2} testID={testID}>
      {options.map(([v, l]) => (
        <Pressable key={v} onPress={() => onPick(v)} style={[styles.seg2B, v === value && styles.seg2On]} accessibilityState={{ selected: v === value }} testID={testID ? `${testID}-${v}` : undefined}>
          <Text style={[styles.seg2Text, v === value && { color: '#fff3cf' }]}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Display settings (group / motion / quality / ambience / reset). */
export function KgSettings({ c, style }) {
  return (
    <View style={[kgStyles.panel, styles.settings, style]} testID="kg-settings-panel">
      <View style={styles.head}>
        <Text style={kgStyles.panelTitle}>Display</Text>
        <Pressable onPress={() => { c.settingsOpen = false; c.emit(); }} hitSlop={10} style={{ marginLeft: 'auto' }}>
          <Ionicons name="close" size={20} color={KG.dim} />
        </Pressable>
      </View>
      <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} nestedScrollEnabled>
        <Text style={kgStyles.label}>Group by</Text>
        <Seg value={c.groupMode} options={GROUP_MODES.map((g) => [g.id, g.label])} onPick={(v) => c.setGroupMode(v)} testID="kg-set-group" />
        <Text style={kgStyles.label}>Motion</Text>
        <Seg value={c.prefs.motion} options={[['system', 'System'], ['reduced', 'Reduced'], ['full', 'Full']]} onPick={(v) => c.setMotionPref(v)} />
        <Text style={kgStyles.label}>Quality</Text>
        <Seg value={c.prefs.quality} options={[['auto', 'Auto'], ['high', 'High'], ['low', 'Battery']]} onPick={(v) => c.setQualityPref(v)} testID="kg-set-quality" />
        <Text style={kgStyles.label}>Ambience</Text>
        <Seg value={c.prefs.ambience ? 'on' : 'off'} options={[['on', 'Nebula + grid'], ['off', 'Off']]} onPick={(v) => c.setAmbience(v === 'on')} />
        <View style={[styles.btns, { marginTop: 12 }]}>
          <KgButton icon="refresh" label="Reset layout" onPress={() => c.resetLayout()} />
        </View>
        <Text style={[kgStyles.muted, { marginTop: 8 }]}>Pinch to zoom · drag to orbit · two fingers to pan / twist · tap a node for its card · double-tap to open · long-press for actions · drag onto a project to move · link / select modes in the toolbar.</Text>
      </ScrollView>
    </View>
  );
}

/** Group-by quick picker (the toolbar's Group control). */
export function KgGroupSheet({ c, onClose, style }) {
  return (
    <View style={[kgStyles.panel, styles.sheet, style]} testID="kg-group-sheet">
      <View style={styles.grab} />
      <Text style={styles.menuHead}>Group nodes</Text>
      {GROUP_MODES.map((g) => (
        <Pressable key={g.id} onPress={() => { c.setGroupMode(g.id); onClose(); }} style={({ pressed }) => [styles.mi, pressed && { backgroundColor: 'rgba(212,175,55,0.1)' }]} testID={`kg-group-${g.id}`}>
          <Ionicons name={g.id === c.groupMode ? 'radio-button-on' : 'radio-button-off'} size={18} color={KG.goldSoft} />
          <Text style={styles.miText}>{g.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = kgSheet({
  card: { gap: 6 },
  // The floating tap card = the web .kg-hovercard (0.74rem body, Inter title).
  hc: { gap: 4, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 10, borderColor: rgba(KG.gold, 0.38), backgroundColor: 'rgba(10,8,22,0.95)' },
  hcTitle: { fontFamily: KG_INTER[700], fontSize: 15, lineHeight: 19, color: KG.fgBright, marginBottom: 3 },
  hcRow: { color: KG.dim, fontSize: 11, marginTop: 2, fontVariant: ['tabular-nums'] },
  hcCnt: { color: KG.dim, fontSize: 11 },
  hcMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: rgba(KG.gold, 0.12) },
  hcMetaText: { color: KG.dim, fontSize: 11 },
  hcLinks: { gap: 2, marginBottom: 3 },
  hcLinkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 1 },
  hcLinkText: { color: '#ddd6c4', fontSize: 10.5, flexShrink: 1 },
  hcMini: { height: 32, paddingHorizontal: 8, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.04)' },
  hcMiniText: { color: '#e9e4d6', fontSize: 10.5 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  hex: { borderRadius: 1, transform: [{ rotate: '45deg' }], width: 9, height: 9 },
  kind: { color: KG.dim, textTransform: 'uppercase', fontSize: 10.5, letterSpacing: 1.6 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  // .kg-hc-title / .kg-detail-label: Inter 700 on the web.
  title: { fontFamily: KG_INTER[700], fontSize: 16, lineHeight: 20, color: KG.fgBright },
  detailTitle: { fontFamily: KG_INTER[700], fontSize: 16, lineHeight: 20, color: KG.fgBright, marginVertical: 6 },
  row: { color: KG.dim, fontSize: 12, marginTop: 2 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cnt: { color: KG.dim, fontSize: 11.5 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 2 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 200 },
  metaText: { color: KG.dim, fontSize: 11.5 },
  links: { gap: 3 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  linkText: { color: KG.fg, fontSize: 12, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
  actionsFixed: { flexShrink: 0 },
  body: { flexGrow: 0, flexShrink: 1 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(212,175,55,0.08)', borderWidth: 1, borderColor: rgba(KG.gold, 0.18) },
  miniText: { color: KG.goldSoft, fontSize: 12, fontWeight: '600' },
  progress: { height: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginTop: 4 },
  progressBar: { height: '100%', borderRadius: 999, backgroundColor: '#e3b739' },
  detail: { gap: 4 },
  stats: { flexDirection: 'row', gap: 6, marginTop: 6 },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.03)' },
  statN: { color: KG.fg, fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] },
  statL: { color: KG.dim, fontSize: 10 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.06)' },
  k: { color: KG.dim, fontSize: 12 },
  v: { color: KG.fg, fontSize: 12, fontWeight: '700', flexShrink: 1, marginLeft: 12, textAlign: 'right' },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  reason: { color: KG.warn, fontSize: 11, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(245,165,36,0.12)' },
  relGroup: { marginTop: 10 },
  relHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  relHeadText: { color: KG.dim, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  rel: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 6, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.025)', marginTop: 3 },
  relName: { flex: 1, color: KG.fg, fontSize: 12.5 },
  relKind: { color: KG.dimmer, fontSize: 11 },
  aiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8, flexShrink: 0 },
  btns: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6, flexShrink: 0 },
  sheet: { paddingTop: 14 },
  grab: { position: 'absolute', top: 5, alignSelf: 'center', width: 36, height: 4, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.22)' },
  menuHead: { color: KG.fgBright, fontWeight: '700', fontSize: 14, marginBottom: 4, flexShrink: 0 },
  menuSec: { color: rgba(KG.gold, 0.8), fontSize: 9.5, letterSpacing: 2, textTransform: 'uppercase', marginTop: 8, marginBottom: 2 },
  mi: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 42, paddingHorizontal: 8, borderRadius: 8 },
  miText: { color: KG.fg, fontSize: 14, flexShrink: 1 },
  kbd: { marginLeft: 'auto', color: KG.dimmer, fontSize: 11 },
  miRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 8 },
  miChip: { paddingHorizontal: 10, height: 30, borderRadius: 999, justifyContent: 'center', borderWidth: 1, borderColor: rgba(KG.gold, 0.3), backgroundColor: 'rgba(212,175,55,0.07)' },
  miChipText: { color: KG.goldSoft, fontSize: 12, fontWeight: '600' },
  bulk: { padding: 8, gap: 6 },
  bulkCount: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bulkN: { color: '#fff3cf', fontWeight: '800', fontSize: 15 },
  bulkL: { color: KG.dim, fontWeight: '500', fontSize: 12 },
  bb: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: rgba(KG.gold, 0.2), backgroundColor: 'rgba(0,0,0,0.3)' },
  bbAi: { borderColor: 'rgba(94,231,255,0.3)', backgroundColor: 'rgba(94,231,255,0.06)' },
  bbDanger: { borderColor: 'rgba(240,82,95,0.4)' },
  bbText: { color: KG.fg, fontSize: 12, fontWeight: '600' },
  bbSep: { width: 1, height: 22, backgroundColor: rgba(KG.gold, 0.22), marginHorizontal: 2 },
  statusPop: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  settings: {},
  seg2: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  seg2B: { paddingHorizontal: 10, height: 32, borderRadius: 8, justifyContent: 'center', borderWidth: 1, borderColor: rgba(KG.gold, 0.18) },
  seg2On: { backgroundColor: rgba(KG.gold, 0.22), borderColor: rgba(KG.gold, 0.6) },
  seg2Text: { color: KG.fg, fontSize: 12.5, fontWeight: '600' },
});
