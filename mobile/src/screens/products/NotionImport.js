/**
 * NotionImport — "Import from Notion" body (web: renderNotionImportModal).
 * Lists databases the integration can see, add-by-URL via the probe RPC,
 * multi-select, then commits each as the `products` role for this business.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, Field, Button, Chip, Skeleton } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { extractNotionDbId, notionErrorHint, importLogLines } from './catalog-model';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

export function NotionImport({ gateway, businessId, onImported, onClose }) {
  const { colors, type } = useUIKit();
  const [dbs, setDbs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState('');
  const [probing, setProbing] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [log, setLog] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await withTimeout(gateway.sendReq('notion.import.listDatabases', {}), 15000, 'listDatabases');
      setDbs(Array.isArray(res?.databases) ? res.databases : []);
    } catch (e) {
      setError(`Discovery failed: ${notionErrorHint(e)}`);
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => { load(); }, [load]);

  const probe = async () => {
    const id = extractNotionDbId(manual);
    if (!id) {
      setError('Paste a full Notion database URL or its 32-character id.');
      return;
    }
    setProbing(true);
    setError(null);
    try {
      const res = await gateway.sendReq('notion.import.probeDatabase', { dbId: id });
      const db = res?.database;
      if (db?.id) {
        setDbs((prev) => (prev.some((d) => d.id === db.id) ? prev : [...prev, db]));
        setSelected((prev) => new Set(prev).add(db.id));
        setManual('');
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setProbing(false);
    }
  };

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = dbs.length > 0 && selected.size === dbs.length;

  const runImport = async () => {
    if (!selected.size) return;
    setImporting(true);
    setError(null);
    let lines = ['Starting import…'];
    setLog(lines);
    for (const dbId of Array.from(selected)) {
      const db = dbs.find((d) => d.id === dbId);
      const label = db?.title || dbId.slice(0, 8);
      let result = null;
      let err = null;
      // Retry through a gateway restart bounce (transient socket errors only).
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          result = await gateway.sendReq('notion.import.commit', {
            dbId,
            role: 'products',
            fieldMap: {},
            applyPatch: false,
            conflictPolicy: 'queue',
            businessId,
          });
          err = null;
          break;
        } catch (e) {
          err = e;
          if (!/service restart|not connected|gateway closed|socket|disconnected|timeout/i.test(String(e?.message || e))) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      lines = [...lines, ...importLogLines(label, dbId, result, err)];
      setLog(lines);
    }
    setLog([...lines, 'Done.']);
    setImporting(false);
    onImported?.();
  };

  return (
    <View style={{ gap: SPACE.md }}>
      <Text style={[type.small, { color: colors.textSecondary }]}>
        Pick which Notion databases to bring in as Products. Each one becomes a bound catalog source — SKU, Price and Inventory schemas slot in automatically.
      </Text>

      <View style={[styles.manual, { borderColor: withAlpha(colors.text, 0.14) }]}>
        <Field
          value={manual}
          onChangeText={setManual}
          placeholder="Paste a Notion database URL or ID"
          mono
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={probe}
          accessibilityLabel="Notion database URL or ID"
        />
        <Button size="sm" variant="secondary" icon="add" title={probing ? 'Probing…' : 'Add by URL/ID'} onPress={probe} disabled={probing || !manual.trim()} loading={probing} />
      </View>

      {error ? (
        <View style={[styles.err, { borderColor: withAlpha(colors.error, 0.4), backgroundColor: withAlpha(colors.error, 0.08) }]}>
          <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
          <Text style={[type.caption, { color: colors.error, flex: 1 }]}>{error}</Text>
        </View>
      ) : null}

      {loading && !dbs.length ? (
        <View style={{ gap: SPACE.sm }}>
          <Text style={[type.caption, { color: colors.textMuted }]}>Scanning Notion…</Text>
          <Skeleton height={48} count={3} gap={SPACE.sm} />
        </View>
      ) : !dbs.length ? (
        <Text style={[type.small, { color: colors.textMuted, textAlign: 'center', padding: SPACE.lg }]}>
          No databases visible to the integration. Share a database in Notion (database menu, Connections), or paste its URL above.
        </Text>
      ) : (
        <View style={{ gap: SPACE.sm }}>
          <View style={styles.selRow}>
            <Chip
              icon={allSelected ? 'checkbox' : 'square-outline'}
              tone="primary"
              selected={allSelected}
              label={selected.size ? `${selected.size} of ${dbs.length} selected` : `Select all (${dbs.length})`}
              onPress={() => setSelected(allSelected ? new Set() : new Set(dbs.map((d) => d.id)))}
            />
            <Button size="sm" variant="ghost" icon="refresh" title="Refresh" onPress={load} disabled={loading || importing} />
          </View>
          <View style={[styles.list, { borderColor: colors.border, backgroundColor: withAlpha(colors.text, 0.03) }]}>
            {dbs.map((db) => {
              const on = selected.has(db.id);
              return (
                <Pressable
                  key={db.id}
                  onPress={() => toggle(db.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={db.title || 'Untitled'}
                  style={({ pressed }) => [styles.dbRow, { opacity: pressed ? 0.8 : 1, backgroundColor: on ? withAlpha(colors.primary, 0.08) : 'transparent' }]}
                >
                  <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.primary : colors.textMuted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{db.title || 'Untitled'}</Text>
                    <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                      {db.propertyCount} {db.propertyCount === 1 ? 'property' : 'properties'}
                      {db.existingBinding ? ` · already bound (${db.existingBinding.role})` : ''}
                      {db.isSystemManaged ? ' · system' : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {log.length ? (
        <View style={[styles.log, { backgroundColor: withAlpha(colors.text, 0.05), borderColor: colors.border }]}>
          {log.map((l, i) => (
            <Text key={i} style={[type.monoSmall, { color: colors.textSecondary }]}>{l}</Text>
          ))}
        </View>
      ) : null}

      <View style={styles.footer}>
        <Button variant="ghost" title="Close" onPress={onClose} />
        <Button
          variant="primary"
          icon="cloud-download-outline"
          title={importing ? 'Importing…' : selected.size ? `Import ${selected.size} as Products` : 'Pick databases above'}
          onPress={runImport}
          disabled={importing || !selected.size}
          loading={importing}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  manual: { gap: SPACE.sm, padding: SPACE.md, borderWidth: 1, borderStyle: 'dashed', borderRadius: RADIUS.md },
  err: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start', padding: SPACE.md, borderWidth: 1, borderRadius: RADIUS.md },
  selRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  list: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.xs, gap: 2 },
  dbRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingHorizontal: SPACE.md, minHeight: 52, borderRadius: RADIUS.sm },
  log: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: 2 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm, flexWrap: 'wrap' },
});
