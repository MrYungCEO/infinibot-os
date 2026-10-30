/**
 * ReportDetail — full-screen report reader (parity with the web gallery's
 * markdown + original viewers).
 *
 *   Read tab      the markitdown copy (`reports.get` → report.markdownBody),
 *                 rendered natively; research docs render their stored body.
 *   Document tab  the rendered PDF (PDF.js) or the original HTML report.
 *   Actions       Share / Save (expo-sharing on device, a download on web),
 *                 View in graph, linked projects / clients
 *                 (`reports.associations`), and the secondary admin actions
 *                 (resend / delete) behind a "More" sheet.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Modal as RNModal,
  Pressable,
  Platform,
  Share,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';

import {
  useUIKit,
  SPACE,
  RADIUS,
  Card,
  Chip,
  StatusChip,
  IconButton,
  Button,
  SegmentedControl,
  EmptyState,
  Skeleton,
  BottomSheet,
  ListRow,
  Divider,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { DocumentFrame } from './DocumentFrame';
import { assetKind, categoryLabel, categoryOf, fmtBytes, sourceOf, titleCase } from '../../lib/reports-model';
import { ALL_ORIENTATIONS } from '../../ui-kit/Sheet';

let Sharing = null;
try {
  // eslint-disable-next-line global-require
  Sharing = require('expo-sharing');
} catch {
  Sharing = null;
}
let FS = null;
try {
  // eslint-disable-next-line global-require
  FS = require('expo-file-system');
} catch {
  FS = null;
}

function b64ToBytes(b64) {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeName(title, ext) {
  const base = String(title || 'report').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';
  return `${base}.${ext}`;
}

/** Hand a report file to the OS (share sheet / Files) or download it on web. */
export async function shareReportFile({ base64, title, kind }) {
  const ext = kind === 'html' ? 'html' : 'pdf';
  const mime = kind === 'html' ? 'text/html' : 'application/pdf';
  const name = safeName(title, ext);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([b64ToBytes(base64)], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
  }
  if (!FS?.File || !FS?.Paths) throw new Error('File access is unavailable in this build.');
  const file = new FS.File(FS.Paths.cache, name);
  try {
    if (file.exists) file.delete();
  } catch {
    /* stale cache entry */
  }
  file.create();
  file.writeSync(b64ToBytes(base64));
  if (Sharing && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(file.uri, {
      mimeType: mime,
      UTI: kind === 'html' ? 'public.html' : 'com.adobe.pdf',
      dialogTitle: title || 'Report',
    });
    return 'shared';
  }
  await Share.share({ url: file.uri, title: title || 'Report' });
  return 'shared';
}

function makeMarkdownStyles(colors, type) {
  return {
    body: { color: colors.text, fontFamily: type.body.fontFamily, fontSize: 15, lineHeight: 23 },
    heading1: { color: colors.text, fontFamily: type.h1.fontFamily, fontSize: 22, lineHeight: 28, marginTop: SPACE.md, marginBottom: SPACE.sm },
    heading2: { color: colors.text, fontFamily: type.h2.fontFamily, fontSize: 18, lineHeight: 24, marginTop: SPACE.lg, marginBottom: SPACE.xs },
    heading3: { color: colors.primary, fontFamily: type.h3.fontFamily, fontSize: 15, lineHeight: 21, marginTop: SPACE.md, marginBottom: SPACE.xs },
    heading4: { color: colors.textSecondary, fontFamily: type.h3.fontFamily, fontSize: 14, lineHeight: 20, marginTop: SPACE.sm },
    strong: { fontFamily: type.bodyStrong.fontFamily, color: colors.text },
    em: { fontStyle: 'italic' },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    bullet_list: { marginVertical: SPACE.xs },
    ordered_list: { marginVertical: SPACE.xs },
    list_item: { marginVertical: 2 },
    blockquote: {
      backgroundColor: withAlpha(colors.primary, 0.07),
      borderLeftColor: colors.primary,
      borderLeftWidth: 3,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      marginVertical: SPACE.sm,
      borderRadius: RADIUS.sm,
    },
    code_inline: {
      fontFamily: type.mono.fontFamily,
      backgroundColor: withAlpha(colors.text, 0.08),
      color: colors.text,
      paddingHorizontal: 4,
      borderRadius: 4,
      borderWidth: 0,
      fontSize: 13,
    },
    code_block: {
      fontFamily: type.mono.fontFamily,
      backgroundColor: withAlpha(colors.text, 0.06),
      color: colors.text,
      padding: SPACE.md,
      borderRadius: RADIUS.sm,
      borderWidth: 0,
      fontSize: 12,
    },
    fence: {
      fontFamily: type.mono.fontFamily,
      backgroundColor: withAlpha(colors.text, 0.06),
      color: colors.text,
      padding: SPACE.md,
      borderRadius: RADIUS.sm,
      borderWidth: 0,
      fontSize: 12,
    },
    hr: { backgroundColor: withAlpha(colors.primary, 0.25), height: StyleSheet.hairlineWidth, marginVertical: SPACE.md },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: withAlpha(colors.primary, 0.25), borderRadius: RADIUS.sm, marginVertical: SPACE.sm },
    thead: { backgroundColor: withAlpha(colors.primary, 0.08) },
    th: { padding: SPACE.sm, color: colors.text, fontFamily: type.smallStrong.fontFamily, fontSize: 13 },
    td: { padding: SPACE.sm, color: colors.textSecondary, fontSize: 13 },
    tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: withAlpha(colors.primary, 0.15) },
    image: { borderRadius: RADIUS.sm },
  };
}

function fmtDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

const TARGET_ICON = { project: 'cube-outline', client: 'person-outline', opportunity: 'trending-up-outline' };

export function ReportDetail({ visible, row, api, onClose, onOpenGraph, onResend, onDelete }) {
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const md = useMemo(() => makeMarkdownStyles(colors, type), [colors, type]);

  const [report, setReport] = useState(null);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [assoc, setAssoc] = useState([]);
  const [tab, setTab] = useState('read');
  const [doc, setDoc] = useState({ base64: null, loading: false, error: null });
  const [docError, setDocError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const isDoc = !!row?.isResearchDoc;
  const rec = report || row || {};
  const kind = isDoc ? 'none' : assetKind(rec);
  const hasAsset = kind === 'pdf' || kind === 'html';

  // Load the full record (markdown copy) + associations whenever a row opens.
  useEffect(() => {
    if (!visible || !row) return undefined;
    let alive = true;
    setReport(null);
    setBody('');
    setError(null);
    setAssoc([]);
    setDoc({ base64: null, loading: false, error: null });
    setDocError(null);
    setNotice(null);
    setLoading(true);
    (async () => {
      try {
        if (row.isResearchDoc) {
          const d = await api.getResearchDoc(row.docId);
          if (!alive) return;
          setBody(typeof d?.body === 'string' ? d.body : '');
          setReport({ ...row, summaryText: d?.description || row.summaryText, sources: d?.sources || [] });
        } else {
          const [full, links] = await Promise.all([api.getReport(row.id), api.getAssociations(row.id)]);
          if (!alive) return;
          setReport(full ? { ...row, ...full } : row);
          setBody(typeof full?.markdownBody === 'string' ? full.markdownBody : '');
          if (links.some((a) => a.targetType === 'project') && api.getProjectNames) {
            const names = await api.getProjectNames();
            if (!alive) return;
            setAssoc(links.map((a) => (a.targetType === 'project' && names.get(String(a.targetId)) ? { ...a, targetLabel: names.get(String(a.targetId)) } : a)));
          } else {
            setAssoc(links);
          }
          // No markdown copy → open straight onto the document.
          const k = assetKind(full || row);
          if (!full?.markdownBody && (k === 'pdf' || k === 'html')) setTab('doc');
          else setTab('read');
        }
      } catch (e) {
        if (alive) setError(e?.message || String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible, row, api]);

  const loadDoc = useCallback(async () => {
    if (!rec?.id || doc.base64 || doc.loading) return doc.base64;
    setDoc({ base64: null, loading: true, error: null });
    try {
      const res = await api.preview(rec.id);
      if (!res?.base64) throw new Error('The rendered file could not be loaded.');
      setDoc({ base64: res.base64, loading: false, error: null });
      return res.base64;
    } catch (e) {
      setDoc({ base64: null, loading: false, error: e?.message || String(e) });
      return null;
    }
  }, [api, rec?.id, doc.base64, doc.loading]);

  useEffect(() => {
    if (visible && tab === 'doc' && hasAsset && !isDoc) loadDoc();
  }, [visible, tab, hasAsset, isDoc, loadDoc]);

  const share = useCallback(async () => {
    setSharing(true);
    setNotice(null);
    try {
      if (hasAsset) {
        const b64 = doc.base64 || (await loadDoc());
        if (!b64) throw new Error('Nothing to share yet — the file did not load.');
        const out = await shareReportFile({ base64: b64, title: rec.title, kind });
        if (out === 'downloaded') setNotice('Downloaded');
      } else if (body) {
        await Share.share({ title: rec.title, message: `${rec.title}\n\n${body}`.slice(0, 50_000) });
      } else {
        throw new Error('This report has no file or text to share.');
      }
    } catch (e) {
      setNotice(e?.message || String(e));
    } finally {
      setSharing(false);
    }
  }, [hasAsset, doc.base64, loadDoc, rec.title, kind, body]);

  const graphTargetId = !isDoc && rec?.id ? `report:${rec.id}` : null;

  const tabs = [
    { key: 'read', label: 'Read', icon: 'reader-outline' },
    ...(hasAsset ? [{ key: 'doc', label: kind === 'html' ? 'HTML' : 'PDF', icon: kind === 'html' ? 'code-slash-outline' : 'document-outline' }] : []),
  ];

  const category = categoryOf(rec);
  const source = sourceOf(rec);
  const onDocTab = tab === 'doc' && hasAsset;

  const header = (
    <View style={[styles.topBar, { paddingTop: insets.top + SPACE.xs, borderBottomColor: withAlpha(colors.primary, 0.22) }]}>
      <IconButton icon="close" onPress={onClose} accessibilityLabel="Close report" />
      <View style={styles.topTitle}>
        <Text style={[type.label, { color: colors.primary }]} numberOfLines={1}>
          {isDoc ? 'Research' : categoryLabel(category)}
        </Text>
        <Text style={[type.h3, { color: colors.text }]} numberOfLines={1}>
          {rec.title || 'Report'}
        </Text>
      </View>
      <IconButton
        icon={Platform.OS === 'web' ? 'download-outline' : 'share-outline'}
        onPress={share}
        loading={sharing}
        disabled={!hasAsset && !body}
        accessibilityLabel={Platform.OS === 'web' ? 'Download report' : 'Share report'}
      />
      {!isDoc ? <IconButton icon="ellipsis-horizontal" onPress={() => setMoreOpen(true)} accessibilityLabel="More actions" /> : null}
    </View>
  );

  const infoCard = (
    <Card padded tint="primary" style={styles.infoCard}>
      <View style={styles.chipRow}>
        <Chip label={isDoc ? 'Research doc' : categoryLabel(category)} tone="primary" size="sm" icon="folder-outline" />
        {rec.kind && !isDoc ? <Chip label={titleCase(rec.kind)} size="sm" /> : null}
        {rec.status ? <StatusChip status={rec.status} size="sm" /> : null}
        {hasAsset ? <Chip label={`${kind.toUpperCase()} file`} size="sm" icon="document-outline" /> : null}
        {body ? <Chip label="Markdown" size="sm" icon="logo-markdown" tone="info" /> : null}
      </View>
      <Text style={[type.h2, { color: colors.text, marginTop: SPACE.sm }]}>{rec.title || 'Untitled report'}</Text>
      <View style={styles.metaRow}>
        {rec.createdAt ? (
          <Text style={[type.caption, { color: colors.textMuted }]}>
            <Ionicons name="time-outline" size={12} color={colors.textMuted} /> {fmtDate(rec.createdAt)}
          </Text>
        ) : null}
        {source ? (
          <Text style={[type.caption, { color: colors.textMuted }]}>
            <Ionicons name="hardware-chip-outline" size={12} color={colors.textMuted} /> {source}
          </Text>
        ) : null}
        {rec.fileSize ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{fmtBytes(rec.fileSize)}</Text> : null}
      </View>
      {rec.summaryText ? (
        <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.sm }]} numberOfLines={6}>
          {rec.summaryText}
        </Text>
      ) : null}

      <View style={styles.linkRow}>
        {graphTargetId && onOpenGraph ? (
          <Chip label="View in graph" icon="git-network-outline" tone="primary" onPress={() => onOpenGraph(graphTargetId)} accessibilityLabel="View this report in the knowledge graph" />
        ) : null}
        {assoc.map((a) => {
          const t = a.targetType || a.toType || a.type;
          const id = a.targetId || a.toId || a.id;
          const label = a.targetLabel || a.label || a.title || `${titleCase(t)} ${String(id).slice(0, 8)}`;
          return (
            <Chip
              key={`${t}:${id}`}
              label={label}
              icon={TARGET_ICON[t] || 'link-outline'}
              onPress={onOpenGraph ? () => onOpenGraph(`${t}:${id}`) : undefined}
              accessibilityLabel={`Open linked ${t} ${label} in the knowledge graph`}
            />
          );
        })}
      </View>
      {notice ? <Text style={[type.caption, { color: colors.warning, marginTop: SPACE.sm }]}>{notice}</Text> : null}
    </Card>
  );

  const readBody = loading ? (
    <View style={{ paddingTop: SPACE.lg }}>
      <Skeleton count={8} />
    </View>
  ) : error ? (
    <EmptyState icon="alert-circle-outline" tone="danger" title="Couldn't open this report" message={error} compact />
  ) : body ? (
    <Card padded depth={1} style={styles.mdCard}>
      <Markdown style={md}>{body}</Markdown>
    </Card>
  ) : (
    <EmptyState
      icon="document-text-outline"
      title="No markdown copy"
      message={hasAsset ? 'This report has no converted text yet — the original is on the document tab.' : 'This report has no rendered text or file.'}
      actionLabel={hasAsset ? `Open ${kind.toUpperCase()}` : undefined}
      onAction={hasAsset ? () => setTab('doc') : undefined}
      compact
    />
  );

  const docBody = doc.loading ? (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} />
      <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.sm }]}>Loading {kind.toUpperCase()}…</Text>
    </View>
  ) : doc.error || docError ? (
    <EmptyState icon="alert-circle-outline" tone="danger" title="Document unavailable" message={doc.error || docError} actionLabel="Retry" onAction={() => { setDocError(null); setDoc({ base64: null, loading: false, error: null }); }} compact />
  ) : doc.base64 ? (
    <View style={[styles.frameWrap, { borderColor: withAlpha(colors.primary, 0.25) }]}>
      <DocumentFrame
        kind={kind}
        base64={doc.base64}
        onMessage={(m) => {
          if (m?.type === 'pdf-error') setDocError(m.message);
        }}
      />
    </View>
  ) : null;

  return (
    <RNModal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      supportedOrientations={ALL_ORIENTATIONS}
    >
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        {header}
        {tabs.length > 1 ? (
          <View style={styles.tabsRow}>
            <SegmentedControl options={tabs} value={tab} onChange={setTab} size="sm" />
          </View>
        ) : null}
        {onDocTab ? (
          <View style={[styles.docArea, { paddingBottom: insets.bottom + SPACE.sm }]}>
            {wide ? null : (
              <Text style={[type.caption, { color: colors.textMuted, marginBottom: SPACE.sm }]} numberOfLines={1}>
                {rec.title}
              </Text>
            )}
            {docBody}
          </View>
        ) : (
          <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + SPACE.xxl }, wide && styles.scrollWide]}>
            {infoCard}
            {readBody}
          </ScrollView>
        )}
      </View>

      <BottomSheet visible={moreOpen} onClose={() => setMoreOpen(false)} title="Report actions" subtitle={rec.title}>
        <ListRow
          icon={Platform.OS === 'web' ? 'download-outline' : 'share-outline'}
          title={Platform.OS === 'web' ? 'Download file' : 'Share or save file'}
          subtitle={hasAsset ? `${kind.toUpperCase()} · ${fmtBytes(rec.fileSize) || 'rendered file'}` : 'Shares the markdown text'}
          onPress={() => {
            setMoreOpen(false);
            share();
          }}
        />
        <Divider inset />
        <ListRow
          icon="paper-plane-outline"
          title="Resend to a channel"
          subtitle="UI, Telegram or email"
          onPress={() => {
            setMoreOpen(false);
            onResend?.(rec);
          }}
        />
        <Divider inset />
        <ListRow
          icon="trash-outline"
          iconTone="danger"
          title="Delete report"
          subtitle="Removes the rendered file too"
          onPress={() => {
            setMoreOpen(false);
            onDelete?.(rec);
          }}
        />
        <View style={{ height: SPACE.md }} />
        <Button title="Close" variant="ghost" onPress={() => setMoreOpen(false)} fullWidth />
      </BottomSheet>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: SPACE.sm,
    paddingBottom: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topTitle: { flex: 1, minWidth: 0, paddingHorizontal: SPACE.xs },
  tabsRow: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md },
  scroll: { padding: SPACE.lg, gap: SPACE.md },
  scrollWide: { maxWidth: 820, width: '100%', alignSelf: 'center' },
  infoCard: {},
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, marginTop: SPACE.xs },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
  mdCard: {},
  docArea: { flex: 1, paddingHorizontal: SPACE.md, paddingTop: SPACE.md },
  frameWrap: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
