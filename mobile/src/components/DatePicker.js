/**
 * Touch-first date (+ optional time) picker — one component for every dated
 * field: quick capture (task due, project target, idea / note review-on, log
 * date) and the idea / note / task editors.
 *
 *   <DatePickerPanel>  quick chips (Today, Tomorrow, This weekend, Next week,
 *                      In 2 weeks), a Monday-first month calendar, an optional
 *                      time (presets + ±15 min stepper), Clear / Done. Plain
 *                      View, so it can live inside another sheet.
 *   <DatePickerSheet>  the panel in its own BottomSheet.
 *   <DateField>        form row: "Fri 17 Oct, 3 pm · in 3 days", the
 *                      "Auto: … · from “by Friday”" chip, clear (×), tap to change.
 *
 * Pure JS (no native date picker), so it runs the same in Expo Go, the APK and
 * the web export. Dates are the phone's local calendar days (lib/date-pick.js).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import {
  MONTH_LONG,
  TIME_PRESETS,
  dateChipLabel,
  formatTime,
  formatWhen,
  monthGrid,
  parseYmd,
  quickChips,
  relativeHint,
  shiftMonth,
  stepTime,
} from '../lib/date-pick';

// Text on the gold primary (selected day, Done) — the palettes' primary is light.
const ON_PRIMARY = '#0B0B0C';
const WEEK_HEAD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function Chip({ label, on, onPress, icon, testID, colors, type }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: on ? colors.primary : withAlpha(colors.text, 0.16),
          backgroundColor: on ? withAlpha(colors.primary, 0.16) : pressed ? withAlpha(colors.text, 0.06) : 'transparent',
        },
      ]}
    >
      {icon ? <Ionicons name={icon} size={14} color={on ? colors.primary : colors.textSecondary} /> : null}
      <Text style={[type.caption, { color: on ? colors.primary : colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

export function DatePickerPanel({ date, time, allowTime = true, onDone, onCancel, now: nowProp, title, testID = 'date-picker' }) {
  const { colors, type } = useUIKit();
  const now = nowProp || new Date();
  const [d, setD] = useState(date || null);
  const [t, setT] = useState(time || null);
  const [showTime, setShowTime] = useState(!!time);
  const initial = parseYmd(date) || now;
  const [month, setMonth] = useState({ y: initial.getFullYear(), m: initial.getMonth() });
  useEffect(() => {
    setD(date || null);
    setT(time || null);
    setShowTime(!!time);
    const at = parseYmd(date) || new Date();
    setMonth({ y: at.getFullYear(), m: at.getMonth() });
  }, [date, time]);

  const chips = useMemo(() => quickChips(now), [now.toDateString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const weeks = useMemo(() => monthGrid(month.y, month.m, { now }), [month, now.toDateString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (next) => {
    setD(next);
    const at = parseYmd(next);
    if (at) setMonth({ y: at.getFullYear(), m: at.getMonth() });
  };
  const line = withAlpha(colors.text, 0.1);
  const summary = d ? `${formatWhen(d, showTime ? t : null, { now })} · ${relativeHint(d, { now })}` : 'No date';

  return (
    <View style={{ gap: SPACE.md }} testID={testID}>
      {title ? <Text style={[type.label, { color: colors.textMuted }]}>{title}</Text> : null}
      <View style={[styles.summary, { borderColor: withAlpha(colors.primary, 0.35), backgroundColor: withAlpha(colors.primary, 0.07) }]}>
        <Ionicons name="calendar" size={18} color={colors.primary} />
        <Text style={[type.bodyStrong, { color: d ? colors.text : colors.textSecondary, flex: 1 }]} numberOfLines={1} testID={`${testID}-summary`}>
          {summary}
        </Text>
      </View>

      <View style={styles.wrap}>
        {chips.map((c) => (
          <Chip key={c.key} label={c.label} on={d === c.date} onPress={() => pick(c.date)} testID={`${testID}-chip-${c.key}`} colors={colors} type={type} />
        ))}
        <Chip label="No date" icon="close" on={!d} onPress={() => { setD(null); setT(null); setShowTime(false); }} testID={`${testID}-chip-none`} colors={colors} type={type} />
      </View>

      <View style={[styles.calendar, { borderColor: line, backgroundColor: withAlpha('#000000', 0.28) }]}>
        <View style={styles.monthHead}>
          <Pressable onPress={() => setMonth(shiftMonth(month, -1))} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={8} style={styles.arrow} testID={`${testID}-prev`}>
            <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <Text style={[type.bodyStrong, { color: colors.text }]} testID={`${testID}-month`}>
            {MONTH_LONG[month.m]} {month.y}
          </Text>
          <Pressable onPress={() => setMonth(shiftMonth(month, 1))} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={8} style={styles.arrow} testID={`${testID}-next`}>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
        <View style={styles.weekRow}>
          {WEEK_HEAD.map((w, i) => (
            <Text key={i} style={[type.caption, styles.cellText, { color: i >= 5 ? colors.primary : colors.textMuted }]}>
              {w}
            </Text>
          ))}
        </View>
        {weeks.map((row, wi) => (
          <View key={wi} style={styles.weekRow}>
            {row.map((c) => {
              const on = c.date === d;
              return (
                <Pressable
                  key={c.date}
                  onPress={() => pick(c.date)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={formatWhen(c.date, null, { now })}
                  testID={`${testID}-day-${c.date}`}
                  style={[
                    styles.cell,
                    on ? { backgroundColor: colors.primary } : c.isToday ? { borderWidth: 1, borderColor: withAlpha(colors.primary, 0.7) } : null,
                  ]}
                >
                  <Text
                    style={[
                      type.small,
                      styles.cellText,
                      {
                        color: on ? ON_PRIMARY : !c.inMonth ? withAlpha(colors.text, 0.22) : c.isPast ? withAlpha(colors.text, 0.45) : colors.text,
                        fontWeight: on || c.isToday ? '700' : '400',
                      },
                    ]}
                  >
                    {c.day}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      {allowTime ? (
        <View style={{ gap: SPACE.sm }}>
          <Pressable
            onPress={() => {
              if (showTime) {
                setShowTime(false);
                setT(null);
              } else {
                setShowTime(true);
                setT(t || '09:00');
                if (!d) pick(chips[0].date);
              }
            }}
            accessibilityRole="switch"
            accessibilityState={{ checked: showTime }}
            testID={`${testID}-time-toggle`}
            style={styles.timeToggle}
          >
            <Ionicons name={showTime ? 'time' : 'time-outline'} size={18} color={showTime ? colors.primary : colors.textSecondary} />
            <Text style={[type.smallStrong, { color: showTime ? colors.primary : colors.textSecondary, flex: 1 }]}>{showTime ? 'Time' : 'Add a time'}</Text>
            {showTime ? <Text style={[type.caption, { color: colors.textMuted }]}>Remove</Text> : null}
          </Pressable>
          {showTime ? (
            <View style={{ gap: SPACE.sm }}>
              <View style={styles.wrap}>
                {TIME_PRESETS.map((p) => (
                  <Chip key={p.key} label={`${p.label} · ${formatTime(p.time)}`} on={t === p.time} onPress={() => setT(p.time)} testID={`${testID}-time-${p.key}`} colors={colors} type={type} />
                ))}
              </View>
              <View style={[styles.stepper, { borderColor: line }]}>
                <Pressable onPress={() => setT(stepTime(t, -15))} accessibilityRole="button" accessibilityLabel="15 minutes earlier" style={styles.stepBtn} testID={`${testID}-time-minus`}>
                  <Ionicons name="remove" size={20} color={colors.text} />
                </Pressable>
                <Text style={[type.h2, { color: colors.text, minWidth: 96, textAlign: 'center' }]} testID={`${testID}-time-value`}>
                  {formatTime(t)}
                </Text>
                <Pressable onPress={() => setT(stepTime(t, 15))} accessibilityRole="button" accessibilityLabel="15 minutes later" style={styles.stepBtn} testID={`${testID}-time-plus`}>
                  <Ionicons name="add" size={20} color={colors.text} />
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.footer}>
        {onCancel ? (
          <Pressable onPress={onCancel} accessibilityRole="button" style={styles.footBtn} testID={`${testID}-cancel`}>
            <Text style={[type.smallStrong, { color: colors.textSecondary }]}>Cancel</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => onDone?.({ date: d || null, time: d && showTime ? t : null })}
          accessibilityRole="button"
          testID={`${testID}-done`}
          style={[styles.doneBtn, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="checkmark" size={18} color={ON_PRIMARY} />
          <Text style={[type.smallStrong, { color: ON_PRIMARY }]}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function DatePickerSheet({ visible, onClose, title = 'Choose a date', onDone, ...panel }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} scroll maxHeightRatio={0.92} testID="date-picker-sheet">
      {visible ? (
        <DatePickerPanel
          {...panel}
          onCancel={onClose}
          onDone={(v) => {
            onDone?.(v);
            onClose?.();
          }}
        />
      ) : null}
    </BottomSheet>
  );
}

/**
 * Form row for a date: the value + relative hint, an Auto chip when the date
 * came from what was said, a clear (×) button, tap to open the picker
 * (`onOpen` for an inline panel, else its own sheet).
 */
export function DateField({ label = 'Date', empty = 'No date', date, time, suggestion, onChange, onOpen, allowTime = true, disabled, now, testID = 'date-field' }) {
  const { colors, type } = useUIKit();
  const [open, setOpen] = useState(false);
  const at = now || new Date();
  const has = !!parseYmd(date);
  const isAuto = !!(suggestion?.date && suggestion.date === date && (suggestion.time || null) === (time || null));
  const offer = suggestion?.date && !isAuto && !has ? suggestion : null;
  const openPicker = () => {
    if (disabled) return;
    if (onOpen) onOpen();
    else setOpen(true);
  };
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text>
      <View style={styles.fieldRow}>
        <Pressable
          onPress={openPicker}
          accessibilityRole="button"
          accessibilityLabel={has ? `${label}: ${formatWhen(date, time, { now: at })}. Change` : `${label}: none. Choose a date`}
          testID={`${testID}-open`}
          style={({ pressed }) => [
            styles.field,
            {
              borderColor: has ? withAlpha(colors.primary, 0.45) : withAlpha(colors.text, 0.14),
              backgroundColor: pressed ? withAlpha(colors.primary, 0.08) : withAlpha('#000000', 0.3),
              opacity: disabled ? 0.5 : 1,
            },
          ]}
        >
          <Ionicons name={has ? 'calendar' : 'calendar-outline'} size={18} color={has ? colors.primary : colors.textSecondary} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[type.bodyStrong, { color: has ? colors.text : colors.textSecondary }]} numberOfLines={1} testID={`${testID}-value`}>
              {has ? formatWhen(date, time, { now: at }) : empty}
            </Text>
            {has ? (
              <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                {relativeHint(date, { now: at })}
              </Text>
            ) : null}
          </View>
          <Text style={[type.smallStrong, { color: colors.primary }]}>{has ? 'Change' : 'Choose'}</Text>
        </Pressable>
        {has && !disabled ? (
          <Pressable
            onPress={() => onChange?.({ date: null, time: null })}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label.toLowerCase()}`}
            hitSlop={8}
            style={[styles.clear, { borderColor: withAlpha(colors.text, 0.14) }]}
            testID={`${testID}-clear`}
          >
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>
      {isAuto ? (
        <View style={[styles.autoChip, { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: withAlpha(colors.primary, 0.1) }]} testID={`${testID}-auto`}>
          <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
          <Text style={[type.caption, { color: colors.primary, flexShrink: 1 }]} numberOfLines={2}>
            {dateChipLabel(suggestion, { now: at })}
          </Text>
        </View>
      ) : null}
      {offer ? (
        <Pressable
          onPress={() => onChange?.({ date: offer.date, time: offer.time || null })}
          accessibilityRole="button"
          testID={`${testID}-suggested`}
          style={[styles.autoChip, { borderColor: withAlpha(colors.text, 0.2), borderStyle: 'dashed' }]}
        >
          <Ionicons name="sparkles-outline" size={14} color={colors.textSecondary} />
          <Text style={[type.caption, { color: colors.textSecondary, flexShrink: 1 }]} numberOfLines={2}>
            {dateChipLabel(offer, { now: at }).replace(/^Auto/, 'Suggested')} — tap to use
          </Text>
        </Pressable>
      ) : null}
      {!onOpen ? (
        <DatePickerSheet
          visible={open}
          onClose={() => setOpen(false)}
          title={label}
          date={date}
          time={time}
          allowTime={allowTime}
          now={now}
          onDone={(v) => onChange?.(v)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  calendar: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.sm, gap: 2 },
  monthHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, minHeight: 44 },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  weekRow: { flexDirection: 'row' },
  cell: { flex: 1, height: 40, margin: 1, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cellText: { flex: 1, textAlign: 'center', textAlignVertical: 'center', lineHeight: 40 },
  timeToggle: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.md, borderWidth: 1, borderRadius: RADIUS.md, minHeight: 52 },
  stepBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  footBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md },
  doneBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.pill },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 52, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  clear: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  autoChip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 32, paddingHorizontal: SPACE.md, paddingVertical: 6, borderRadius: RADIUS.pill, borderWidth: 1 },
});
