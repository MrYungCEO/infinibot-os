/**
 * Native Knowledge Graph dialogs — ports of the web graph's renderDialog /
 * renderSubsDialog: delete, tag, pick (move / link), related & suggested
 * links, spawn agent, consolidate notes/tasks, consolidate sub-projects
 * (dry-run preview → apply → undo). Same plans (shared planners), same copy.
 */
import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import * as core from './generated/kg-core';
import { KgButton } from './KgChrome';
import { KG, KG_INTER, KG_MONO, kgSheet, kgStyles } from './kg-theme';
import { rgba } from './kg-colors';

const { KIND_LABEL, KIND_SINGULAR, truncate } = core;

function Wrap({ title, children, foot, onClose, wide, testID }) {
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modal}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close dialog" />
        <View style={[kgStyles.panel, styles.dialog, wide && styles.wide]} testID={testID}>
          <View style={styles.head}>
            <Text style={[kgStyles.panelTitle, { flexShrink: 1 }]} numberOfLines={2}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10} style={{ marginLeft: 'auto' }} accessibilityLabel="Close" testID="kg-dialog-close">
              <Ionicons name="close" size={20} color={KG.dim} />
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 6 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
          <View style={styles.foot}>{foot}</View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Seg2({ options, value, onPick }) {
  return (
    <View style={styles.seg}>
      {options.map(([v, l]) => (
        <Pressable key={v} onPress={() => onPick(v)} style={[styles.segB, v === value && styles.segOn]} accessibilityState={{ selected: v === value }}>
          <Text style={[styles.segText, v === value && { color: '#fff3cf' }]} numberOfLines={2}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Check({ on, onPress }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={[styles.check, on && styles.checkOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      {on ? <Ionicons name="checkmark" size={14} color="#1a1406" /> : null}
    </Pressable>
  );
}

export function KgDialog({ c }) {
  const d = c.dialog;
  if (!d) return null;
  const close = () => c.closeDialog();
  switch (d.type) {
    case 'delete':
      return (
        <Wrap
          title={`Delete ${d.plan.ops.length} item${d.plan.ops.length > 1 ? 's' : ''}?`}
          onClose={close}
          testID="kg-dialog-delete"
          foot={
            <>
              <KgButton label="Cancel" onPress={close} />
              <KgButton icon="trash-outline" label={`Delete ${d.plan.ops.length}`} danger onPress={() => void c.confirmDelete(d.plan)} testID="kg-delete-confirm" />
            </>
          }
        >
          <Text style={styles.warn}>This removes them from their stores and can't be undone from the graph.</Text>
          {d.plan.ops.slice(0, 12).map((o) => (
            <Text key={o.nodeId} style={styles.li}>• {o.label}</Text>
          ))}
          {d.plan.ops.length > 12 ? <Text style={styles.li}>+{d.plan.ops.length - 12} more</Text> : null}
          {d.plan.skipped.length ? <Text style={kgStyles.muted}>{d.plan.skipped.length} skipped · {d.plan.skipped[0].reason}</Text> : null}
        </Wrap>
      );
    case 'tag':
      return (
        <Wrap
          title={`Tag ${d.ids.length} item${d.ids.length > 1 ? 's' : ''}`}
          onClose={close}
          testID="kg-dialog-tag"
          foot={
            <>
              <KgButton label="Cancel" onPress={close} />
              <KgButton icon="pricetag-outline" label="Add tag" primary disabled={!d.value.trim()} onPress={() => void c.bulkTag(d.ids, d.value)} testID="kg-tag-confirm" />
            </>
          }
        >
          <TextInput
            autoFocus
            value={d.value}
            onChangeText={(value) => c.updateDialog({ value })}
            onSubmitEditing={() => d.value.trim() && void c.bulkTag(d.ids, d.value)}
            placeholder="e.g. launch"
            placeholderTextColor={KG.dimmer}
            style={kgStyles.input}
            autoCapitalize="none"
            testID="kg-tag-input"
          />
          <Text style={[kgStyles.muted, { marginTop: 8 }]}>Tags notes and tasks; existing tags are kept.</Text>
        </Wrap>
      );
    case 'pick': {
      const list = c.pickList(d);
      return (
        <Wrap title={d.purpose === 'move' ? `Move ${d.ids.length} to project` : `Link ${d.ids.length} to…`} onClose={close} testID="kg-dialog-pick" foot={<KgButton label="Cancel" onPress={close} />}>
          <TextInput
            autoFocus
            value={d.query}
            onChangeText={(query) => c.updateDialog({ query })}
            placeholder={d.purpose === 'move' ? 'Find a project…' : 'Find a node…'}
            placeholderTextColor={KG.dimmer}
            style={kgStyles.input}
            autoCapitalize="none"
            autoCorrect={false}
            testID="kg-pick-input"
          />
          <View style={{ marginTop: 8, gap: 3 }}>
            {list.length ? (
              list.map((n) => (
                <Pressable key={n.id} onPress={() => void c.pickTarget(d.purpose, d.ids, n.id)} style={({ pressed }) => [styles.pickItem, pressed && { backgroundColor: 'rgba(212,175,55,0.1)' }]} testID={`kg-pick-${n.id}`}>
                  <View style={[styles.dot, { backgroundColor: n.color }]} />
                  <Text style={styles.pickText} numberOfLines={1}>{n.label}</Text>
                  <Text style={styles.pickKind}>{KIND_SINGULAR[n.kind]}</Text>
                </Pressable>
              ))
            ) : (
              <Text style={kgStyles.muted}>No matches.</Text>
            )}
          </View>
        </Wrap>
      );
    }
    case 'related':
      return (
        <Wrap
          title="Related & suggested links"
          onClose={close}
          wide
          testID="kg-dialog-related"
          foot={
            <>
              <KgButton label="Close" onPress={close} />
              <KgButton icon="sparkles-outline" label="Ask the assistant" primary onPress={() => { close(); c.openAi('related', d.ids); }} />
            </>
          }
        >
          {d.items.length ? (
            d.items.map((s) => {
              const a = c.nodeById.get(s.a);
              const b = c.nodeById.get(s.b);
              if (!a || !b) return null;
              return (
                <View key={`${s.a}|${s.b}`} style={styles.sugg}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.suggText}><Text style={{ fontFamily: KG_MONO[700] }}>{a.label}</Text> ↔ <Text style={{ fontFamily: KG_MONO[700] }}>{b.label}</Text></Text>
                    <Text style={kgStyles.muted}>{s.reason}</Text>
                  </View>
                  <KgButton icon="link-outline" label="Link" onPress={() => void c.linkSuggestion(s)} />
                </View>
              );
            })
          ) : (
            <Text style={kgStyles.muted}>No strong matches from titles and shared connections. The assistant can search your workspace for more.</Text>
          )}
        </Wrap>
      );
    case 'spawn': {
      const agents = c.spawnAgents();
      const title = d.ids.length === 1 ? (c.nodeById.get(d.ids[0])?.label ?? 'this') : `${d.ids.length} items`;
      return (
        <Wrap
          title={`Spawn an agent on ${title}`}
          onClose={close}
          testID="kg-dialog-spawn"
          foot={
            <>
              <KgButton label="Cancel" onPress={close} />
              <KgButton icon="rocket-outline" label={d.busy ? 'Starting…' : 'Spawn agent'} primary disabled={!!d.busy} onPress={() => void c.confirmSpawn(d)} testID="kg-spawn-confirm" />
            </>
          }
        >
          <Text style={kgStyles.label}>Goal</Text>
          <TextInput
            value={d.goal}
            onChangeText={(goal) => c.updateDialog({ goal })}
            multiline
            numberOfLines={4}
            placeholder="Review these items, move them forward, and report back what you changed."
            placeholderTextColor={KG.dimmer}
            style={[kgStyles.input, { minHeight: 96, textAlignVertical: 'top', paddingTop: 10 }]}
          />
          <Text style={kgStyles.label}>Agent</Text>
          <View style={styles.seg}>
            {[{ id: '', label: 'Default (coder)' }, ...agents].map((a) => (
              <Pressable key={a.id || 'default'} onPress={() => c.updateDialog({ agentId: a.id })} style={[styles.segB, d.agentId === a.id && styles.segOn]}>
                <Text style={[styles.segText, d.agentId === a.id && { color: '#fff3cf' }]}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[kgStyles.muted, { marginTop: 8 }]}>Runs a real sub-agent with the selection as context. It shows up on the Agents page and in the activity feed.</Text>
        </Wrap>
      );
    }
    case 'consolidate': {
      const nodes = c.nodesOf(d.ids);
      const p = d.plan;
      return (
        <Wrap
          title={`Consolidate ${nodes.length} ${KIND_LABEL[nodes[0]?.kind ?? 'note']?.toLowerCase() ?? 'items'}`}
          onClose={close}
          wide
          testID="kg-dialog-consolidate"
          foot={
            <>
              <KgButton icon="sparkles-outline" label="Ask AI" onPress={() => { close(); c.openAi('consolidate', d.ids); }} />
              <KgButton label="Cancel" onPress={close} />
              <KgButton icon="layers-outline" label={`Merge ${nodes.length} into 1`} primary disabled={!p || d.loading} onPress={() => void c.confirmConsolidate(d)} testID="kg-consolidate-confirm" />
            </>
          }
        >
          {d.loading ? (
            <Text style={kgStyles.muted}>Reading the items…</Text>
          ) : d.error && !p ? (
            <Text style={styles.warn}>{d.error}</Text>
          ) : (
            <>
              <Text style={kgStyles.label}>Keep</Text>
              {nodes.map((n) => {
                const deg = c.adjacency.get(n.id)?.size ?? 0;
                return (
                  <Pressable key={n.id} onPress={() => c.replanConsolidate(d, { primaryId: n.id })} style={styles.radio}>
                    <Ionicons name={n.id === d.primaryId ? 'radio-button-on' : 'radio-button-off'} size={18} color={KG.goldSoft} />
                    <Text style={styles.pickText} numberOfLines={1}>{n.label}</Text>
                    <Text style={styles.pickKind}>{deg} link{deg === 1 ? '' : 's'}</Text>
                  </Pressable>
                );
              })}
              <Text style={kgStyles.label}>Title</Text>
              <TextInput value={d.title} onChangeText={(title) => c.updateDialog({ title })} style={kgStyles.input} />
              <Text style={kgStyles.label}>Merged content (editable · duplicate paragraphs removed)</Text>
              <TextInput value={d.body} onChangeText={(body) => c.updateDialog({ body })} multiline style={[kgStyles.input, styles.mono]} />
              <View style={styles.sum}>
                <Text style={styles.sumText}>{p?.relinks.length ?? 0} relation{(p?.relinks.length ?? 0) === 1 ? '' : 's'} carried over</Text>
                <Text style={styles.sumText}>{p?.mergedIds.length ?? 0} duplicate{(p?.mergedIds.length ?? 0) === 1 ? '' : 's'}</Text>
                <Text style={styles.sumText}>{p?.calls.length ?? 0} gateway writes</Text>
              </View>
              <Text style={kgStyles.label}>Duplicates</Text>
              <Seg2
                value={d.removeMode}
                options={[['delete', 'Delete'], ['archive', nodes[0]?.kind === 'task' ? 'Mark done' : 'Keep, tag merged']]}
                onPick={(v) => c.replanConsolidate(d, { removeMode: v, keepText: true })}
              />
              {d.removeMode === 'delete' ? <Text style={[styles.warn, { marginTop: 6 }]}>Deleting duplicates can't be undone.</Text> : null}
            </>
          )}
        </Wrap>
      );
    }
    case 'subs':
      return <SubsDialog c={c} d={d} close={close} />;
    default:
      return null;
  }
}

function SubsDialog({ c, d, close }) {
  const parent = c.nodeById.get(d.parentId);
  const p = d.plan;
  const label = (id) => c.nodeById.get(id)?.label ?? id;
  const changed = p ? p.items.filter((it) => it.action !== 'keep').length : 0;
  const counts = p ? Object.entries(p.counts).map(([m, n]) => `${m.replace(/^kanban\./, '')}×${n}`).join(' · ') : '';
  const row = (id, cluster) => {
    const det = d.details.get(id);
    const keeperId = cluster ? (d.keepers.get(cluster.key) ?? cluster.keeperId) : null;
    const keep = d.mode === 'merge' && keeperId === id;
    const meta = det
      ? `${det.status || '—'} · ${det.tasks.length} task${det.tasks.length === 1 ? '' : 's'} · ${det.relations.length} link${det.relations.length === 1 ? '' : 's'}${det.notes.length ? ` · ${det.notes.length} note${det.notes.length === 1 ? '' : 's'}` : ''}${det.archived ? ' · archived' : ''}`
      : d.checked.has(id)
        ? 'reading…'
        : '';
    return (
      <View key={id} style={[styles.subRow, keep && styles.subKeep]}>
        <Check on={d.checked.has(id)} onPress={() => c.toggleSub(id, !d.checked.has(id))} />
        <View style={{ flex: 1 }}>
          <Text style={styles.subName} numberOfLines={2}>{label(id)}</Text>
          {meta ? <Text style={styles.subMeta}>{meta}</Text> : null}
        </View>
        {cluster && d.mode === 'merge' ? (
          <Pressable onPress={() => c.setSubKeeper(cluster.key, id)} style={[styles.keepBtn, keep && styles.keepOn]}>
            <Text style={[styles.keepText, keep && { color: '#1a1406' }]}>{keep ? 'Keep' : 'keep?'}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
  return (
    <Wrap
      title={`Consolidate sub-projects · ${parent?.label ?? ''}`}
      onClose={close}
      wide
      testID="kg-dialog-subs"
      foot={
        <>
          <KgButton icon="copy-outline" label="Copy report" disabled={!d.report} onPress={() => void c.copySubsReport(d)} />
          <KgButton label="Cancel" disabled={!!d.running} onPress={close} />
          <KgButton
            icon="layers-outline"
            label={d.mode === 'tasks' ? `Convert ${changed} to tasks` : `Merge ${changed}`}
            primary
            disabled={!p || !changed || d.loading > 0 || !!d.running}
            onPress={() => void c.applySubs()}
            testID="kg-subs-apply"
          />
        </>
      }
    >
      <Seg2
        value={d.mode}
        options={[['tasks', `Convert to tasks under ${truncate(parent?.label ?? 'parent', 22)}`], ['merge', 'Merge duplicates into one']]}
        onPick={(mode) => c.replanSubs({ mode })}
      />
      {d.mode === 'tasks' ? (
        <View style={{ marginTop: 6 }}>
          <Seg2
            value={d.taskMode}
            options={[['move', `Their tasks → ${truncate(parent?.label ?? 'parent', 18)}`], ['checklist', 'Nest their tasks as a checklist']]}
            onPick={(taskMode) => c.replanSubs({ taskMode })}
          />
        </View>
      ) : null}
      <View style={styles.note}>
        <Ionicons name="shield-checkmark-outline" size={15} color={KG.ok} />
        <Text style={[kgStyles.muted, { flex: 1 }]}>Nothing is deleted: originals are archived with a back-reference, and Undo reverts the whole batch.</Text>
      </View>
      {d.clusters.length ? (
        d.clusters.map((cl) => (
          <View key={cl.key} style={styles.cluster}>
            <View style={styles.clHead}>
              <Text style={[styles.tier, cl.tier === 'duplicate' ? styles.tierDup : styles.tierNear]}>{cl.tier === 'duplicate' ? 'Duplicates' : 'Near-duplicates'} · {Math.round(cl.score * 100)}%</Text>
              <Text style={kgStyles.muted}>{cl.ids.length} sub-projects</Text>
            </View>
            {cl.ids.map((id) => row(id, cl))}
          </View>
        ))
      ) : (
        <Text style={kgStyles.muted}>No look-alike sub-projects found — pick any below to convert.</Text>
      )}
      {d.others.length ? (
        <>
          <Pressable onPress={() => c.updateDialog({ showOthers: !d.showOthers })} style={{ paddingVertical: 8 }}>
            <Text style={styles.link}>{d.showOthers ? 'Hide' : 'Show'} the other {d.others.length} sub-projects</Text>
          </Pressable>
          {d.showOthers ? <View style={styles.cluster}>{d.others.map((id) => row(id))}</View> : null}
        </>
      ) : null}
      <Text style={kgStyles.label}>Preview {d.loading ? `· reading ${d.loading}…` : ''}</Text>
      <View style={styles.plan} testID="kg-subs-plan">
        {p && p.items.length ? (
          p.items.map((it) => (
            <View key={it.nodeId} style={styles.pi}>
              {it.action === 'to-task' ? (
                <Text style={styles.piText}>
                  <Text style={{ fontFamily: KG_MONO[700] }}>{it.label}</Text> → task under {it.intoLabel} <Text style={styles.piSt}>{it.taskStatus}</Text>
                  {'\n'}
                  <Text style={styles.piEm}>{it.movedTasks ? `${it.movedTasks} tasks moved · ` : ''}{it.checklist ? `${it.checklist} checklist items · ` : ''}{it.relationsCopied} links carried · {it.notesMoved} notes · archived</Text>
                </Text>
              ) : it.action === 'merge-into' ? (
                <Text style={styles.piText}>
                  <Text style={{ fontFamily: KG_MONO[700] }}>{it.label}</Text> → merged into “{it.intoLabel}”{'\n'}
                  <Text style={styles.piEm}>{it.movedTasks} tasks · {it.relationsCopied} links re-pointed · archived</Text>
                </Text>
              ) : (
                <Text style={styles.piText}><Text style={{ fontFamily: KG_MONO[700] }}>{it.label}</Text> <Text style={styles.piSt}>kept</Text></Text>
              )}
            </View>
          ))
        ) : (
          <Text style={kgStyles.muted}>{d.loading ? 'Reading sub-projects…' : 'Tick sub-projects to plan.'}</Text>
        )}
      </View>
      {p ? (
        <View style={styles.sum}>
          <Text style={styles.sumText}>{changed} sub-project{changed === 1 ? '' : 's'}</Text>
          <Text style={styles.sumText}>{p.steps.length} gateway writes</Text>
          <Text style={styles.sumText}>{p.deletes} deletes</Text>
          <Text style={[styles.sumText, { color: KG.dimmer }]}>{counts}</Text>
        </View>
      ) : null}
      {d.running ? (
        <View style={styles.prog}>
          <View style={[styles.progBar, { width: `${Math.round((d.running.done / Math.max(1, d.running.total)) * 100)}%` }]} />
          <Text style={styles.progText}>Applying {d.running.done}/{d.running.total}…</Text>
        </View>
      ) : null}
      {d.error ? <Text style={styles.warn}>{d.error}</Text> : null}
    </Wrap>
  );
}

const styles = kgSheet({
  modal: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)', padding: 12 },
  dialog: { width: '100%', maxWidth: 460, maxHeight: '90%', padding: 14, backgroundColor: 'rgba(9,7,20,0.985)' },
  wide: { maxWidth: 640 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, flexShrink: 0 },
  body: { flexGrow: 0, flexShrink: 1 },
  foot: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, marginTop: 10, flexShrink: 0 },
  warn: { color: '#fca5a5', fontSize: 12.5, lineHeight: 17, marginBottom: 6 },
  li: { color: KG.fg, fontSize: 13, paddingVertical: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pickItem: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 8, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.025)' },
  pickText: { flex: 1, color: KG.fg, fontSize: 13.5 },
  pickKind: { color: KG.dimmer, fontSize: 11.5 },
  sugg: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  suggText: { color: KG.fg, fontSize: 13 },
  seg: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  segB: { paddingHorizontal: 10, minHeight: 34, paddingVertical: 6, borderRadius: 8, justifyContent: 'center', borderWidth: 1, borderColor: rgba(KG.gold, 0.18), flexShrink: 1 },
  segOn: { backgroundColor: rgba(KG.gold, 0.22), borderColor: rgba(KG.gold, 0.6) },
  segText: { color: KG.fg, fontSize: 12.5, fontWeight: '600' },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 38 },
  mono: { minHeight: 160, textAlignVertical: 'top', paddingTop: 10, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12 },
  sum: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  sumText: { color: KG.goldSoft, fontSize: 11.5 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginVertical: 8 },
  cluster: { borderWidth: 1, borderColor: rgba(KG.gold, 0.14), borderRadius: 10, padding: 8, marginTop: 6, gap: 4 },
  clHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  tier: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  tierDup: { color: '#fca5a5', backgroundColor: 'rgba(240,82,95,0.14)' },
  tierNear: { color: '#fcd34d', backgroundColor: 'rgba(245,165,36,0.14)' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingHorizontal: 4, borderRadius: 7 },
  subKeep: { backgroundColor: 'rgba(61,220,151,0.08)' },
  subName: { color: KG.fg, fontSize: 13 },
  subMeta: { color: KG.dimmer, fontSize: 11, marginTop: 1 },
  check: { width: 22, height: 22, borderRadius: 5, borderWidth: 1.5, borderColor: rgba(KG.gold, 0.6), alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: KG.gold, borderColor: KG.gold },
  keepBtn: { paddingHorizontal: 8, height: 28, borderRadius: 7, justifyContent: 'center', borderWidth: 1, borderColor: rgba(KG.ok, 0.5) },
  keepOn: { backgroundColor: KG.ok },
  keepText: { color: KG.ok, fontSize: 11.5, fontWeight: '700' },
  link: { color: KG.goldSoft, fontWeight: '600', fontSize: 12.5 },
  plan: { gap: 5 },
  pi: { paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.06)' },
  piText: { color: KG.fg, fontSize: 12.5, lineHeight: 17 },
  piSt: { color: KG.goldSoft, fontSize: 11 },
  piEm: { color: KG.dimmer, fontSize: 11.5, fontStyle: 'italic' },
  prog: { height: 22, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden', justifyContent: 'center', marginTop: 8 },
  progBar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: rgba(KG.gold, 0.45) },
  progText: { color: '#fff3cf', fontSize: 11.5, textAlign: 'center' },
});
