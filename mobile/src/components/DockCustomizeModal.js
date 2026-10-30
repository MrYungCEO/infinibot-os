/**
 * DockCustomizeModal — slide-up sheet for picking which navigation items
 * appear in the FloatingDock and in what order.
 *
 * Long-press any tab in the dock to open it. Selection is persisted by
 * the parent (FloatingDock) via AsyncStorage; this component is pure UI.
 *
 * Props:
 *  - visible:      boolean
 *  - onClose:      () => void
 *  - allRoutes:    [{ key, name }] — every Tab.Navigator route
 *  - selection:    string[] — ordered list of selected route names
 *  - onChange:     (next: string[]) => void
 *  - onReset:      () => void
 *  - maxItems:     number (default 5)
 *  - iconForRoute: (routeName) => { lib: 'ion'|'mci', name, color? }
 */

import React from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { useTheme } from '../theme/ThemeProvider';

// Human labels for dock routes whose route name isn't user-facing. The
// 'VoiceCall' route name is kept so saved dock layouts still resolve; it opens
// the InfiniBot call page (local voice; Robovoice is its cloud option).
const TAB_LABELS = { VoiceCall: 'InfiniBot (voice)' };
export function tabLabel(routeName) {
  return TAB_LABELS[routeName] || routeName;
}

function withAlpha(color, alpha) {
  if (!color) return `rgba(255,255,255,${alpha})`;
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const num = parseInt(hex, 16);
    return `rgba(${(num >> 16) & 0xff},${(num >> 8) & 0xff},${num & 0xff},${alpha})`;
  }
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((p) => p.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

function RouteIcon({ cfg, color, size = 18 }) {
  if (!cfg) {
    return <Ionicons name="ellipse-outline" size={size} color={color} />;
  }
  const IconLib = cfg.lib === 'mci' ? MaterialCommunityIcons : Ionicons;
  const iconName = cfg.inactive || cfg.active || cfg.name || 'ellipse-outline';
  return <IconLib name={iconName} size={size} color={color} />;
}

export function DockCustomizeModal({
  visible,
  onClose,
  allRoutes,
  selection,
  onChange,
  onReset,
  maxItems = 5,
  iconForRoute,
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const primary = colors?.primary || COLORS.primary;

  const selectedNames = Array.isArray(selection) ? selection : [];
  const byName = React.useMemo(() => {
    const m = new Map();
    for (const r of allRoutes) m.set(r.name, r);
    return m;
  }, [allRoutes]);

  // In-dock items, in order
  const inDock = selectedNames.map((n) => byName.get(n)).filter(Boolean);
  // Available items (not currently in dock)
  const available = allRoutes.filter((r) => !selectedNames.includes(r.name));

  const atCap = inDock.length >= maxItems;

  const moveUp = (idx) => {
    if (idx <= 0) return;
    const next = [...selectedNames];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };

  const moveDown = (idx) => {
    if (idx >= selectedNames.length - 1) return;
    const next = [...selectedNames];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    onChange(next);
  };

  const remove = (name) => {
    if (selectedNames.length <= 1) return; // keep at least 1
    onChange(selectedNames.filter((n) => n !== name));
  };

  const add = (name) => {
    if (atCap) return;
    if (selectedNames.includes(name)) return;
    onChange([...selectedNames, name]);
  };

  const blurIntensity = Platform.OS === 'android' ? 60 : 78;
  const bottomPad = Math.max(insets.bottom, 12);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={[styles.sheetWrap, { paddingBottom: bottomPad }]}>
          {/* Glass body */}
          <View style={styles.shadowWrap}>
            <View style={styles.clipWrap}>
              <BlurView intensity={blurIntensity} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, styles.tint]} />
              <LinearGradient
                colors={[withAlpha(primary, 0.16), withAlpha(primary, 0.03), 'rgba(0,0,0,0.55)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <LinearGradient
                colors={['rgba(255,255,255,0.08)', 'rgba(255,255,255,0)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 0.45 }}
                style={StyleSheet.absoluteFill}
              />
              <View style={[StyleSheet.absoluteFill, styles.border]} />

              {/* Grab handle */}
              <View style={styles.grabWrap}>
                <View style={styles.grab} />
              </View>

              {/* Header */}
              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>Customize Quick Nav</Text>
                  <Text style={styles.subtitle}>
                    Choose up to {maxItems} navigation items for the dock
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
                  <Ionicons name="close" size={20} color="rgba(255,255,255,0.85)" />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={{ maxHeight: 460 }}
                contentContainerStyle={{ paddingBottom: 4 }}
                showsVerticalScrollIndicator={false}
              >
                {/* In Dock section */}
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>In Dock</Text>
                  <Text style={[styles.sectionCount, atCap && { color: primary }]}>
                    {inDock.length} / {maxItems}
                  </Text>
                </View>

                {inDock.length === 0 ? (
                  <Text style={styles.emptyHint}>Nothing selected yet.</Text>
                ) : (
                  inDock.map((route, idx) => (
                    <View key={route.key} style={styles.row}>
                      <View style={[styles.iconChip, { borderColor: withAlpha(primary, 0.35), backgroundColor: withAlpha(primary, 0.10) }]}>
                        <RouteIcon cfg={iconForRoute(route.name)} color={primary} />
                      </View>
                      <Text style={styles.rowLabel} numberOfLines={1}>{tabLabel(route.name)}</Text>

                      <TouchableOpacity
                        onPress={() => moveUp(idx)}
                        disabled={idx === 0}
                        style={[styles.arrowBtn, idx === 0 && styles.arrowBtnDisabled]}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="chevron-up" size={16} color={idx === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.82)'} />
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => moveDown(idx)}
                        disabled={idx === inDock.length - 1}
                        style={[styles.arrowBtn, idx === inDock.length - 1 && styles.arrowBtnDisabled]}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="chevron-down" size={16} color={idx === inDock.length - 1 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.82)'} />
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => remove(route.name)}
                        disabled={selectedNames.length <= 1}
                        style={[styles.removeBtn, selectedNames.length <= 1 && styles.arrowBtnDisabled]}
                        activeOpacity={0.7}
                        accessibilityLabel={`Remove ${tabLabel(route.name)} from dock`}
                      >
                        <Ionicons
                          name="remove-circle"
                          size={20}
                          color={selectedNames.length <= 1 ? 'rgba(255,255,255,0.22)' : '#ef4444'}
                        />
                      </TouchableOpacity>
                    </View>
                  ))
                )}

                {/* Available section */}
                {available.length > 0 && (
                  <>
                    <View style={[styles.sectionHeader, { marginTop: 14 }]}>
                      <Text style={styles.sectionTitle}>Available</Text>
                      {atCap && (
                        <Text style={[styles.sectionCount, { color: primary }]}>
                          cap reached
                        </Text>
                      )}
                    </View>

                    {available.map((route) => (
                      <View key={route.key} style={styles.row}>
                        <View style={styles.iconChipMuted}>
                          <RouteIcon cfg={iconForRoute(route.name)} color={'rgba(255,255,255,0.65)'} />
                        </View>
                        <Text style={[styles.rowLabel, { color: 'rgba(255,255,255,0.65)' }]} numberOfLines={1}>
                          {tabLabel(route.name)}
                        </Text>

                        <TouchableOpacity
                          onPress={() => add(route.name)}
                          disabled={atCap}
                          style={[
                            styles.addBtn,
                            { borderColor: withAlpha(primary, 0.4), backgroundColor: withAlpha(primary, 0.12) },
                            atCap && styles.arrowBtnDisabled,
                          ]}
                          activeOpacity={0.75}
                          accessibilityLabel={`Add ${tabLabel(route.name)} to dock`}
                        >
                          <Ionicons name="add" size={16} color={atCap ? 'rgba(255,255,255,0.32)' : primary} />
                          <Text style={[styles.addBtnText, { color: atCap ? 'rgba(255,255,255,0.32)' : primary }]}>
                            Add
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </>
                )}
              </ScrollView>

              {/* Footer actions */}
              <View style={styles.footer}>
                <TouchableOpacity onPress={onReset} style={styles.resetBtn} activeOpacity={0.75}>
                  <Ionicons name="refresh" size={14} color="rgba(255,255,255,0.7)" />
                  <Text style={styles.resetBtnText}>Reset to defaults</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={onClose}
                  style={[styles.doneBtn, { borderColor: withAlpha(primary, 0.55), backgroundColor: withAlpha(primary, 0.18) }]}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.doneBtnText, { color: primary }]}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const SHEET_RADIUS = 24;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },

  sheetWrap: {
    paddingHorizontal: 14,
    paddingTop: 0,
  },

  shadowWrap: {
    borderRadius: SHEET_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.6,
    shadowRadius: 28,
    elevation: 22,
  },

  clipWrap: {
    borderRadius: SHEET_RADIUS,
    overflow: 'hidden',
    backgroundColor: Platform.OS === 'android' ? 'rgba(10,10,16,0.9)' : 'transparent',
  },

  tint: {
    backgroundColor: 'rgba(10,10,18,0.55)',
  },

  border: {
    borderWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.14)',
    borderLeftColor: 'rgba(255,255,255,0.06)',
    borderRightColor: 'rgba(255,255,255,0.06)',
    borderBottomColor: 'rgba(255,255,255,0.03)',
    borderRadius: SHEET_RADIUS,
  },

  grabWrap: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  grab: {
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 10,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.2,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    marginTop: 6,
    marginBottom: 8,
  },
  sectionTitle: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.55)',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 0.3,
  },

  emptyHint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    paddingHorizontal: 18,
    paddingVertical: 8,
    fontStyle: 'italic',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginHorizontal: 10,
    marginBottom: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.04)',
    gap: 8,
  },

  iconChip: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  iconChipMuted: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },

  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.92)',
    letterSpacing: 0.1,
  },

  arrowBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  arrowBtnDisabled: {
    opacity: 0.4,
  },

  removeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    gap: 4,
  },
  addBtnText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 6,
  },
  resetBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.78)',
    letterSpacing: 0.2,
  },
  doneBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
  },
  doneBtnText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});

export default DockCustomizeModal;
