/**
 * FederationTransferDrawer
 *
 * Cross-platform sibling of the web `federation-transfer-drawer`. Shows live
 * federation file-transfer progress as a slide-up sheet anchored to a small
 * status pill above the tab bar.
 *
 * Mounted once near the app root (App.js), alongside <NotificationBanner />,
 * so it is visible from every screen.
 *
 * Mobile has no drag-drop, so transfers are started imperatively:
 *
 *     import { FederationTransferDrawer } from '.../FederationTransferDrawer';
 *     FederationTransferDrawer.startTransfer({ srcPeerId, srcPath, dstPeerId, dstPath });
 *
 * A follow-up task adds a "Send to peer…" menu in the explorer that calls this.
 *
 * Progress is polled via `fileTransfer.list` while rows are active — the
 * transfer engine emits progress on an internal EventEmitter that the gateway
 * does NOT bridge to a client event channel, so there is no event to subscribe
 * to yet (documented gap; no new RPC invented). We also register a best-effort
 * `subscribeEvent('fileTransfer.progress')` listener so the drawer upgrades for
 * free if such a bridge is added later.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import { DOCK_BOTTOM_SPACE } from './FloatingDock';

const MAX_ROWS = 20;
const POLL_INTERVAL_MS = 1500;

// ── Module-level imperative bridge ───────────────────────────────────────────
// `FederationTransferDrawer.startTransfer(...)` can be called before (or
// without) the component being mounted; requests queue until a mounted instance
// registers its enqueue handler.
let _enqueue = null;
const _pending = [];

function startTransfer(req) {
  if (!req || !req.srcPath || !req.dstPeerId) return;
  const normalized = {
    srcPeerId: req.srcPeerId || 'local',
    srcPath: req.srcPath,
    dstPeerId: req.dstPeerId,
    dstPath: req.dstPath || '',
  };
  if (_enqueue) _enqueue(normalized);
  else _pending.push(normalized);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function basename(p) {
  if (!p) return p;
  const cleaned = String(p).replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

let _rowSeq = 0;
function nextRowId() {
  _rowSeq += 1;
  return `ftrow-${Date.now()}-${_rowSeq}`;
}

function mapStatus(t) {
  switch (t.status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'transferring':
    case 'paused':
      return 'in-flight';
    default:
      return 'queued';
  }
}

function overallPct(t) {
  const nodes = Object.keys(t.progress || {});
  if (nodes.length === 0) return t.status === 'completed' ? 100 : 0;
  const total = t.totalChunks || 0;
  if (total === 0) return 0;
  const avg =
    nodes.reduce((sum, n) => sum + ((t.progress[n] || {}).chunksSent || 0), 0) /
    nodes.length;
  return Math.min(100, Math.round((avg / total) * 100));
}

const STATUS_META = {
  queued: { label: 'queued', color: '#a1a1aa' },
  'in-flight': { label: 'sending', color: '#60a5fa' },
  done: { label: 'done', color: '#4ade80' },
  failed: { label: 'failed', color: '#f87171' },
};

// ── Component ────────────────────────────────────────────────────────────────

export function FederationTransferDrawer({ gateway }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const rowsRef = useRef([]);
  const pollTimerRef = useRef(null);

  // Keep a ref in sync so the poll loop reads the latest rows without
  // re-subscribing the interval on every render.
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const patchRow = useCallback((rowId, patch) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }, []);

  const hasActiveRows = useCallback(
    () =>
      rowsRef.current.some(
        (r) =>
          r.transferId && (r.status === 'queued' || r.status === 'in-flight'),
      ),
    [],
  );

  // The transport only sends a LOCAL file to `toNodes`; `srcPeerId` (if remote)
  // and `dstPath` are not honoured by the existing RPC — receivers land the
  // file in their federation inbox. Documented gap, not invented backend.
  const dispatchSend = useCallback(
    async (row) => {
      if (!gateway || !gateway.sendReq) {
        patchRow(row.rowId, { status: 'failed', error: 'gateway unavailable' });
        return;
      }
      try {
        const res = await gateway.sendReq('fileTransfer.send', {
          filePath: row.srcPath,
          toNodes: [row.dstPeerId],
        });
        const transferId = (res && res.transferId) || null;
        patchRow(row.rowId, {
          transferId,
          status: transferId ? 'in-flight' : 'failed',
          error: transferId ? undefined : 'send returned no transferId',
        });
      } catch (err) {
        patchRow(row.rowId, {
          status: 'failed',
          error: err && err.message ? err.message : String(err),
        });
      }
    },
    [gateway, patchRow],
  );

  const enqueue = useCallback(
    (detail) => {
      const row = {
        rowId: nextRowId(),
        transferId: null,
        fileName: basename(detail.srcPath),
        srcPeerId: detail.srcPeerId,
        dstPeerId: detail.dstPeerId,
        srcPath: detail.srcPath,
        dstPath: detail.dstPath,
        status: 'queued',
        pct: 0,
        error: undefined,
      };
      setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
      setOpen(true);
      void dispatchSend(row);
    },
    [dispatchSend],
  );

  // Register the module-level bridge + drain anything queued before mount.
  useEffect(() => {
    _enqueue = enqueue;
    if (_pending.length > 0) {
      const drain = _pending.splice(0, _pending.length);
      drain.forEach((req) => enqueue(req));
    }
    return () => {
      if (_enqueue === enqueue) _enqueue = null;
    };
  }, [enqueue]);

  // Poll fileTransfer.list while any row is active.
  useEffect(() => {
    const anyActive = rows.some(
      (r) => r.transferId && (r.status === 'queued' || r.status === 'in-flight'),
    );
    if (!anyActive) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollTimerRef.current) return; // already polling

    const tick = async () => {
      if (!hasActiveRows()) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        return;
      }
      if (!gateway || !gateway.sendReq) return;
      try {
        const res = await gateway.sendReq('fileTransfer.list', {});
        const list = (res && res.transfers) || [];
        const byId = {};
        list.forEach((t) => {
          byId[t.id] = t;
        });
        setRows((prev) =>
          prev.map((r) => {
            if (!r.transferId || !byId[r.transferId]) return r;
            const t = byId[r.transferId];
            const status = mapStatus(t);
            const pct = status === 'done' ? 100 : overallPct(t);
            return { ...r, status, pct, error: t.error || r.error };
          }),
        );
      } catch (_e) {
        // transient — keep polling
      }
    };

    pollTimerRef.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [rows, gateway, hasActiveRows]);

  // Best-effort live event upgrade — no-op until the gateway bridges
  // engine progress events to a client channel.
  useEffect(() => {
    if (!gateway || !gateway.subscribeEvent) return undefined;
    const unsub = gateway.subscribeEvent('fileTransfer.progress', (payload) => {
      if (!payload || !payload.transferId) return;
      setRows((prev) =>
        prev.map((r) => {
          if (r.transferId !== payload.transferId) return r;
          const status = payload.status ? mapStatus(payload) : r.status;
          const pct =
            typeof payload.pct === 'number' ? payload.pct : r.pct;
          return { ...r, status, pct };
        }),
      );
    });
    return unsub;
  }, [gateway]);

  const onCancel = useCallback(
    async (row) => {
      if (row.transferId && gateway && gateway.sendReq) {
        try {
          await gateway.sendReq('fileTransfer.cancel', { id: row.transferId });
        } catch (_e) {
          /* best-effort */
        }
      }
      patchRow(row.rowId, { status: 'failed', error: 'cancelled' });
    },
    [gateway, patchRow],
  );

  const onRetry = useCallback(
    (row) => {
      const fresh = {
        ...row,
        status: 'queued',
        pct: 0,
        error: undefined,
        transferId: null,
      };
      patchRow(row.rowId, {
        status: 'queued',
        pct: 0,
        error: undefined,
        transferId: null,
      });
      void dispatchSend(fresh);
    },
    [dispatchSend, patchRow],
  );

  const clearFinished = useCallback(() => {
    setRows((prev) =>
      prev.filter((r) => r.status === 'queued' || r.status === 'in-flight'),
    );
  }, []);

  const activeCount = rows.filter(
    (r) => r.status === 'queued' || r.status === 'in-flight',
  ).length;

  // Empty state: render nothing (mounts cleanly, no clutter).
  if (rows.length === 0) return null;

  return (
    <>
      {/* Status pill above the tab bar */}
      <TouchableOpacity
        style={styles.pill}
        activeOpacity={0.85}
        onPress={() => setOpen(true)}
      >
        <View
          style={[styles.dot, activeCount === 0 && styles.dotIdle]}
        />
        <Ionicons name="swap-horizontal" size={14} color={COLORS.text} />
        <Text style={styles.pillText}>Transfers</Text>
        <View style={styles.pillCount}>
          <Text style={styles.pillCountText}>
            {activeCount || rows.length}
          </Text>
        </View>
      </TouchableOpacity>

      {/* Slide-up sheet */}
      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Federation Transfers</Text>
              <View style={styles.sheetHeaderActions}>
                <TouchableOpacity
                  onPress={clearFinished}
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnText}>Clear finished</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setOpen(false)}
                  style={styles.headerIconBtn}
                >
                  <Ionicons name="close" size={18} color={COLORS.textMuted} />
                </TouchableOpacity>
              </View>
            </View>

            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
            >
              {rows.map((r) => (
                <TransferRow
                  key={r.rowId}
                  row={r}
                  onCancel={onCancel}
                  onRetry={onRetry}
                />
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function TransferRow({ row, onCancel, onRetry }) {
  const meta = STATUS_META[row.status] || STATUS_META.queued;
  const canCancel = row.status === 'queued' || row.status === 'in-flight';
  const canRetry = row.status === 'failed';
  const fillWidth = row.status === 'failed' ? 100 : row.pct;
  const fillColor =
    row.status === 'done'
      ? '#22c55e'
      : row.status === 'failed'
        ? '#ef4444'
        : COLORS.primary;

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>
            {row.fileName}
          </Text>
          <View style={styles.route}>
            <Text style={styles.peer} numberOfLines={1}>
              {row.srcPeerId}
            </Text>
            <Text style={styles.arrow}> → </Text>
            <Text style={styles.peer} numberOfLines={1}>
              {row.dstPeerId}
            </Text>
          </View>
        </View>
        <View style={[styles.badge, { backgroundColor: meta.color + '28' }]}>
          <Text style={[styles.badgeText, { color: meta.color }]}>
            {meta.label}
          </Text>
        </View>
      </View>

      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${fillWidth}%`, backgroundColor: fillColor },
          ]}
        />
      </View>

      <View style={styles.rowBottom}>
        {row.error ? (
          <Text style={styles.errText} numberOfLines={1}>
            {row.error}
          </Text>
        ) : (
          <Text style={styles.pctText}>{row.pct}%</Text>
        )}
        <View style={styles.rowActions}>
          {canRetry && (
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => onRetry(row)}
            >
              <Text style={styles.smallBtnText}>Retry</Text>
            </TouchableOpacity>
          )}
          {canCancel && (
            <TouchableOpacity
              style={[styles.smallBtn, styles.smallBtnDanger]}
              onPress={() => onCancel(row)}
            >
              <Text style={[styles.smallBtnText, styles.smallBtnDangerText]}>
                Cancel
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// Attach the imperative API as a static method.
FederationTransferDrawer.startTransfer = startTransfer;

export default FederationTransferDrawer;

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    right: 16,
    bottom: DOCK_BOTTOM_SPACE + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: 999,
    backgroundColor: 'rgba(18,18,24,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
    zIndex: 50,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.primary,
  },
  dotIdle: {
    backgroundColor: '#52525b',
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.text,
  },
  pillCount: {
    backgroundColor: 'rgba(99,102,241,0.22)',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: 'center',
  },
  pillCountText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#a5b4fc',
  },

  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: COLORS.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 28,
    maxHeight: '70%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginBottom: 10,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
  },
  sheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  headerBtnText: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  headerIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    maxHeight: 420,
  },
  listContent: {
    gap: 9,
    paddingBottom: 4,
  },
  row: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 11,
    backgroundColor: 'rgba(0,0,0,0.25)',
    gap: 8,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
  },
  route: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  peer: {
    fontSize: 11,
    color: '#71717a',
    maxWidth: 110,
  },
  arrow: {
    fontSize: 11,
    color: COLORS.primary,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 9.5,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  track: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  pctText: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  errText: {
    fontSize: 11,
    color: '#f87171',
    flex: 1,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 6,
  },
  smallBtn: {
    paddingVertical: 4,
    paddingHorizontal: 11,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  smallBtnText: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  smallBtnDanger: {
    borderColor: 'rgba(239,68,68,0.4)',
  },
  smallBtnDangerText: {
    color: '#f87171',
  },
});
