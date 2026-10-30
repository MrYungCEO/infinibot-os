import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function MiniCalendar({ selectedDate, onSelect, currentMonth, onMonthChange }) {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  
  const weeks = [];
  let days = [];
  
  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    days.push(null);
  }
  
  // Days of month
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(d);
    if (days.length === 7) {
      weeks.push(days);
      days = [];
    }
  }
  
  // Remaining days
  if (days.length > 0) {
    while (days.length < 7) days.push(null);
    weeks.push(days);
  }
  
  const isSelected = (day) => {
    if (!selectedDate || !day) return false;
    const sel = new Date(selectedDate);
    return sel.getFullYear() === year && sel.getMonth() === month && sel.getDate() === day;
  };
  
  const isToday = (day) => {
    if (!day) return false;
    return today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
  };
  
  const handleDayPress = (day) => {
    if (!day) return;
    const date = new Date(year, month, day);
    onSelect(date.toISOString().split('T')[0]);
  };

  return (
    <View style={styles.calendar}>
      <View style={styles.calendarHeader}>
        <TouchableOpacity onPress={() => onMonthChange(-1)} style={styles.monthNavBtn}>
          <Ionicons name="chevron-back" size={20} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.monthLabel}>{MONTHS[month]} {year}</Text>
        <TouchableOpacity onPress={() => onMonthChange(1)} style={styles.monthNavBtn}>
          <Ionicons name="chevron-forward" size={20} color={COLORS.text} />
        </TouchableOpacity>
      </View>
      
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map(w => (
          <Text key={w} style={styles.weekdayLabel}>{w}</Text>
        ))}
      </View>
      
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map((day, di) => (
            <TouchableOpacity
              key={di}
              style={[
                styles.dayCell,
                isSelected(day) && styles.dayCellSelected,
                isToday(day) && styles.dayCellToday,
              ]}
              onPress={() => handleDayPress(day)}
              disabled={!day}
            >
              <Text style={[
                styles.dayText,
                !day && styles.dayTextEmpty,
                isSelected(day) && styles.dayTextSelected,
                isToday(day) && !isSelected(day) && styles.dayTextToday,
              ]}>
                {day || ''}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ))}
    </View>
  );
}

export function DateEditor({
  value,
  onChange,
  onSave,
  schema,
  includeTime,
  includeEndDate,
  disabled,
}) {
  const [showEndDate, setShowEndDate] = useState(!!value?.end);
  const [currentMonth, setCurrentMonth] = useState(() => {
    if (value?.start) return new Date(value.start);
    return new Date();
  });
  
  const dateValue = useMemo(() => {
    if (!value) return { start: null, end: null };
    if (typeof value === 'string') return { start: value, end: null };
    return { start: value.start || null, end: value.end || null };
  }, [value]);

  const formatDisplayDate = (dateStr) => {
    if (!dateStr) return 'Not set';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    });
  };

  const handleSelectStart = (dateStr) => {
    if (disabled) return;
    const newValue = { ...dateValue, start: dateStr };
    onChange?.(newValue);
    onSave?.(newValue);
  };

  const handleSelectEnd = (dateStr) => {
    if (disabled) return;
    const newValue = { ...dateValue, end: dateStr };
    onChange?.(newValue);
    onSave?.(newValue);
  };

  const handleClear = () => {
    if (disabled) return;
    onChange?.(null);
    onSave?.(null);
    setShowEndDate(false);
  };

  const handleClearEnd = () => {
    if (disabled) return;
    const newValue = { ...dateValue, end: null };
    onChange?.(newValue);
    onSave?.(newValue);
    setShowEndDate(false);
  };

  const handleMonthChange = (delta) => {
    setCurrentMonth(prev => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + delta);
      return next;
    });
  };

  const handleToday = () => {
    const today = new Date().toISOString().split('T')[0];
    handleSelectStart(today);
  };

  const handleTomorrow = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    handleSelectStart(tomorrow.toISOString().split('T')[0]);
  };

  const handleNextWeek = () => {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    handleSelectStart(nextWeek.toISOString().split('T')[0]);
  };

  return (
    <View style={[styles.container, disabled && styles.containerDisabled]}>
      {/* Current selection */}
      <View style={styles.selectionBar}>
        <View style={styles.dateDisplay}>
          <Ionicons name="calendar-outline" size={16} color={COLORS.primary} />
          <Text style={styles.dateDisplayText}>{formatDisplayDate(dateValue.start)}</Text>
        </View>
        {dateValue.start && (
          <TouchableOpacity onPress={handleClear} disabled={disabled}>
            <Ionicons name="close-circle" size={20} color={COLORS.error} />
          </TouchableOpacity>
        )}
      </View>
      
      {/* End date toggle */}
      {includeEndDate !== false && dateValue.start && (
        <View style={styles.endDateSection}>
          {showEndDate ? (
            <View style={styles.endDateRow}>
              <Text style={styles.endDateLabel}>End date:</Text>
              <Text style={styles.endDateValue}>{formatDisplayDate(dateValue.end)}</Text>
              <TouchableOpacity onPress={handleClearEnd} disabled={disabled}>
                <Ionicons name="close" size={16} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setShowEndDate(true)} style={styles.addEndBtn} disabled={disabled}>
              <Ionicons name="add" size={16} color={COLORS.primary} />
              <Text style={styles.addEndText}>Add end date</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Quick options */}
      <View style={styles.quickOptions}>
        <TouchableOpacity style={styles.quickBtn} onPress={handleToday} disabled={disabled}>
          <Text style={styles.quickBtnText}>Today</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={handleTomorrow} disabled={disabled}>
          <Text style={styles.quickBtnText}>Tomorrow</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={handleNextWeek} disabled={disabled}>
          <Text style={styles.quickBtnText}>Next week</Text>
        </TouchableOpacity>
      </View>

      {/* Calendar */}
      <MiniCalendar
        selectedDate={showEndDate && dateValue.start ? dateValue.end : dateValue.start}
        onSelect={showEndDate ? handleSelectEnd : handleSelectStart}
        currentMonth={currentMonth}
        onMonthChange={handleMonthChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {},
  containerDisabled: {
    opacity: 0.6,
  },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surface,
    padding: SPACING.md,
    borderRadius: 8,
    marginBottom: SPACING.sm,
  },
  dateDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  dateDisplayText: {
    fontSize: 15,
    color: COLORS.text,
    fontWeight: '500',
  },
  endDateSection: {
    marginBottom: SPACING.sm,
  },
  endDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.sm,
  },
  endDateLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
  },
  endDateValue: {
    fontSize: 14,
    color: COLORS.text,
    flex: 1,
  },
  addEndBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
  },
  addEndText: {
    fontSize: 13,
    color: COLORS.primary,
  },
  quickOptions: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginBottom: SPACING.md,
  },
  quickBtn: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  quickBtnText: {
    fontSize: 13,
    color: COLORS.textSecondary,
  },
  calendar: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    padding: SPACING.sm,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  monthNavBtn: {
    padding: SPACING.xs,
  },
  monthLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
  },
  weekdayRow: {
    flexDirection: 'row',
    marginBottom: SPACING.xs,
  },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '500',
  },
  weekRow: {
    flexDirection: 'row',
  },
  dayCell: {
    flex: 1,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    margin: 1,
  },
  dayCellSelected: {
    backgroundColor: COLORS.primary,
  },
  dayCellToday: {
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  dayText: {
    fontSize: 14,
    color: COLORS.text,
  },
  dayTextEmpty: {
    color: 'transparent',
  },
  dayTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  dayTextToday: {
    color: COLORS.primary,
    fontWeight: '600',
  },
});
