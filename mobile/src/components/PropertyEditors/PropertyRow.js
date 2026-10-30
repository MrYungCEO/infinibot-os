import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

const TYPE_ICONS = {
  title: 'text-outline',
  rich_text: 'document-text-outline',
  number: 'calculator-outline',
  select: 'radio-button-on-outline',
  multi_select: 'checkbox-outline',
  status: 'pulse-outline',
  date: 'calendar-outline',
  people: 'people-outline',
  checkbox: 'checkbox-outline',
  url: 'link-outline',
  email: 'mail-outline',
  phone_number: 'call-outline',
  relation: 'git-branch-outline',
  rollup: 'analytics-outline',
  formula: 'code-outline',
  files: 'attach-outline',
  created_time: 'time-outline',
  last_edited_time: 'refresh-outline',
  created_by: 'person-outline',
  last_edited_by: 'person-outline',
  unique_id: 'finger-print-outline',
};

export function PropertyRow({
  schema,
  value,
  displayValue,
  onPress,
  disabled,
  compact,
  showType,
}) {
  const { name, type, editable, readonly } = schema;
  const icon = TYPE_ICONS[type] || 'help-circle-outline';
  const isClickable = editable && !disabled && onPress;

  const renderValue = () => {
    if (displayValue !== undefined) {
      return <Text style={styles.valueText} numberOfLines={compact ? 1 : 2}>{String(displayValue)}</Text>;
    }

    if (value === null || value === undefined) {
      return <Text style={styles.emptyText}>Empty</Text>;
    }

    if (typeof value === 'boolean') {
      return (
        <Ionicons
          name={value ? 'checkbox' : 'square-outline'}
          size={18}
          color={value ? COLORS.success : COLORS.textMuted}
        />
      );
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <Text style={styles.emptyText}>None</Text>;
      }
      // Render as tags for multi-select
      if (type === 'multi_select' || type === 'people') {
        return (
          <View style={styles.tagsRow}>
            {value.slice(0, 3).map((v, i) => (
              <View key={i} style={[styles.tag, v.color && { backgroundColor: getNotionColor(v.color) + '22' }]}>
                <Text style={[styles.tagText, v.color && { color: getNotionColor(v.color) }]}>
                  {v.name || v.email || v.display || String(v)}
                </Text>
              </View>
            ))}
            {value.length > 3 && (
              <Text style={styles.moreText}>+{value.length - 3}</Text>
            )}
          </View>
        );
      }
      return <Text style={styles.valueText}>{value.length} items</Text>;
    }

    if (typeof value === 'object') {
      if (value.name) {
        return (
          <View style={[styles.selectTag, value.color && { backgroundColor: getNotionColor(value.color) + '22' }]}>
            <Text style={[styles.selectTagText, value.color && { color: getNotionColor(value.color) }]}>
              {value.name}
            </Text>
          </View>
        );
      }
      if (value.start) {
        return <Text style={styles.valueText}>{formatDate(value.start)}</Text>;
      }
      if (value.display) {
        return <Text style={styles.valueText}>{value.display}</Text>;
      }
      return <Text style={styles.valueText}>{JSON.stringify(value)}</Text>;
    }

    return <Text style={styles.valueText} numberOfLines={compact ? 1 : 2}>{String(value)}</Text>;
  };

  const content = (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <View style={styles.labelCol}>
        <Ionicons name={icon} size={14} color={COLORS.textMuted} style={styles.icon} />
        <Text style={styles.labelText} numberOfLines={1}>{name}</Text>
        {showType && <Text style={styles.typeText}>{type}</Text>}
      </View>
      <View style={styles.valueCol}>
        {renderValue()}
        {isClickable && (
          <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} style={styles.chevron} />
        )}
        {readonly && (
          <Ionicons name="lock-closed-outline" size={12} color={COLORS.textMuted} style={styles.lockIcon} />
        )}
      </View>
    </View>
  );

  if (isClickable) {
    return (
      <TouchableOpacity
        style={styles.touchable}
        onPress={onPress}
        activeOpacity={0.7}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

function getNotionColor(color) {
  const colors = {
    default: COLORS.textMuted,
    gray: '#787774',
    brown: '#9F6B53',
    orange: '#D9730D',
    yellow: '#CB912F',
    green: '#448361',
    blue: '#337EA9',
    purple: '#9065B0',
    pink: '#C14C8A',
    red: '#D44C47',
  };
  return colors[color] || colors.default;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

const styles = StyleSheet.create({
  touchable: {},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border + '44',
    minHeight: 44,
  },
  rowCompact: {
    paddingVertical: SPACING.xs,
    minHeight: 36,
  },
  labelCol: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 140,
    paddingRight: SPACING.sm,
  },
  icon: {
    marginRight: SPACING.xs,
  },
  labelText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    flex: 1,
  },
  typeText: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginLeft: 4,
    opacity: 0.6,
  },
  valueCol: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  valueText: {
    fontSize: 14,
    color: COLORS.text,
    flex: 1,
  },
  emptyText: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontStyle: 'italic',
    flex: 1,
  },
  chevron: {
    marginLeft: SPACING.xs,
  },
  lockIcon: {
    marginLeft: SPACING.xs,
    opacity: 0.5,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    flex: 1,
    gap: 4,
  },
  tag: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 12,
    color: COLORS.text,
  },
  moreText: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginLeft: 4,
  },
  selectTag: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 4,
  },
  selectTagText: {
    fontSize: 13,
    color: COLORS.text,
  },
});
