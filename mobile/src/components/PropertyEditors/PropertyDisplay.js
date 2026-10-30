import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

const NOTION_COLORS = {
  default: { bg: COLORS.surface, text: COLORS.text },
  gray: { bg: '#787774', text: '#FFFFFF' },
  brown: { bg: '#9F6B53', text: '#FFFFFF' },
  orange: { bg: '#D9730D', text: '#FFFFFF' },
  yellow: { bg: '#CB912F', text: '#FFFFFF' },
  green: { bg: '#448361', text: '#FFFFFF' },
  blue: { bg: '#337EA9', text: '#FFFFFF' },
  purple: { bg: '#9065B0', text: '#FFFFFF' },
  pink: { bg: '#C14C8A', text: '#FFFFFF' },
  red: { bg: '#D44C47', text: '#FFFFFF' },
};

/**
 * Read-only display of a property value
 * Used for inline display in cards, lists, etc.
 */
export function PropertyDisplay({
  type,
  value,
  compact,
  maxItems = 3,
}) {
  if (value === null || value === undefined) {
    return compact ? null : <Text style={styles.empty}>—</Text>;
  }

  switch (type) {
    case 'title':
    case 'rich_text':
      return (
        <Text style={[styles.text, compact && styles.textCompact]} numberOfLines={compact ? 1 : 3}>
          {String(value)}
        </Text>
      );

    case 'number':
      return (
        <Text style={[styles.number, compact && styles.numberCompact]}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </Text>
      );

    case 'select':
    case 'status':
      if (!value?.name) return compact ? null : <Text style={styles.empty}>—</Text>;
      const color = NOTION_COLORS[value.color] || NOTION_COLORS.default;
      return (
        <View style={[styles.selectBadge, { backgroundColor: color.bg + 'CC' }, compact && styles.selectBadgeCompact]}>
          <Text style={[styles.selectText, { color: color.text }, compact && styles.selectTextCompact]}>
            {value.name}
          </Text>
        </View>
      );

    case 'multi_select':
      if (!Array.isArray(value) || value.length === 0) {
        return compact ? null : <Text style={styles.empty}>—</Text>;
      }
      return (
        <View style={styles.tagsRow}>
          {value.slice(0, maxItems).map((v, i) => {
            const c = NOTION_COLORS[v.color] || NOTION_COLORS.default;
            return (
              <View key={i} style={[styles.tag, { backgroundColor: c.bg + 'AA' }, compact && styles.tagCompact]}>
                <Text style={[styles.tagText, { color: c.text }, compact && styles.tagTextCompact]}>
                  {v.name}
                </Text>
              </View>
            );
          })}
          {value.length > maxItems && (
            <Text style={styles.moreText}>+{value.length - maxItems}</Text>
          )}
        </View>
      );

    case 'date':
      if (!value?.start) return compact ? null : <Text style={styles.empty}>—</Text>;
      const dateStr = formatDate(value.start, compact);
      const hasEnd = value.end;
      return (
        <View style={styles.dateRow}>
          <Ionicons name="calendar-outline" size={compact ? 12 : 14} color={COLORS.textSecondary} />
          <Text style={[styles.dateText, compact && styles.dateTextCompact]}>
            {dateStr}
            {hasEnd && ` → ${formatDate(value.end, compact)}`}
          </Text>
        </View>
      );

    case 'people':
      if (!Array.isArray(value) || value.length === 0) {
        return compact ? null : <Text style={styles.empty}>—</Text>;
      }
      return (
        <View style={styles.peopleRow}>
          {value.slice(0, maxItems).map((p, i) => (
            <View key={i} style={[styles.avatar, compact && styles.avatarCompact, { marginLeft: i > 0 ? -8 : 0 }]}>
              <Text style={[styles.avatarText, compact && styles.avatarTextCompact]}>
                {(p.name || p.email || 'U')[0].toUpperCase()}
              </Text>
            </View>
          ))}
          {value.length > maxItems && (
            <Text style={styles.moreText}>+{value.length - maxItems}</Text>
          )}
        </View>
      );

    case 'checkbox':
      return (
        <Ionicons
          name={value ? 'checkbox' : 'square-outline'}
          size={compact ? 16 : 20}
          color={value ? COLORS.success : COLORS.textMuted}
        />
      );

    case 'url':
      return (
        <View style={styles.urlRow}>
          <Ionicons name="link-outline" size={compact ? 12 : 14} color={COLORS.textSecondary} />
          <Text style={[styles.urlText, compact && styles.urlTextCompact]} numberOfLines={1}>
            {String(value).replace(/^https?:\/\//, '')}
          </Text>
        </View>
      );

    case 'email':
      return (
        <View style={styles.urlRow}>
          <Ionicons name="mail-outline" size={compact ? 12 : 14} color={COLORS.textSecondary} />
          <Text style={[styles.urlText, compact && styles.urlTextCompact]} numberOfLines={1}>
            {String(value)}
          </Text>
        </View>
      );

    case 'phone_number':
      return (
        <View style={styles.urlRow}>
          <Ionicons name="call-outline" size={compact ? 12 : 14} color={COLORS.textSecondary} />
          <Text style={[styles.urlText, compact && styles.urlTextCompact]} numberOfLines={1}>
            {String(value)}
          </Text>
        </View>
      );

    case 'relation':
      if (!Array.isArray(value) || value.length === 0) {
        return compact ? null : <Text style={styles.empty}>—</Text>;
      }
      return (
        <View style={styles.relationRow}>
          <MaterialCommunityIcons name="link-variant" size={compact ? 12 : 14} color={COLORS.textSecondary} />
          <Text style={[styles.relationText, compact && styles.relationTextCompact]}>
            {value.length} item{value.length !== 1 ? 's' : ''}
          </Text>
        </View>
      );

    case 'rollup':
      if (typeof value === 'number') {
        return <Text style={styles.number}>{value.toLocaleString()}</Text>;
      }
      if (Array.isArray(value)) {
        return <Text style={styles.text}>{value.length} items</Text>;
      }
      return <Text style={styles.text}>{String(value)}</Text>;

    case 'formula':
      if (typeof value === 'boolean') {
        return (
          <Ionicons
            name={value ? 'checkmark-circle' : 'close-circle'}
            size={compact ? 16 : 20}
            color={value ? COLORS.success : COLORS.error}
          />
        );
      }
      return <Text style={styles.text}>{String(value)}</Text>;

    case 'created_time':
    case 'last_edited_time':
      return (
        <Text style={[styles.timestamp, compact && styles.timestampCompact]}>
          {formatDate(value, compact)}
        </Text>
      );

    case 'unique_id':
      const display = value?.display || `${value?.prefix || ''}${value?.number || ''}`;
      return (
        <View style={styles.idBadge}>
          <Text style={styles.idText}>{display}</Text>
        </View>
      );

    default:
      return <Text style={styles.text}>{JSON.stringify(value)}</Text>;
  }
}

function formatDate(dateStr, compact) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();
  
  if (compact) {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }
  
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: isThisYear ? undefined : 'numeric',
  });
}

const styles = StyleSheet.create({
  empty: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  text: {
    fontSize: 14,
    color: COLORS.text,
  },
  textCompact: {
    fontSize: 12,
  },
  number: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '500',
  },
  numberCompact: {
    fontSize: 12,
  },
  selectBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  selectBadgeCompact: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  selectText: {
    fontSize: 13,
    fontWeight: '500',
  },
  selectTextCompact: {
    fontSize: 11,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  tagCompact: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagText: {
    fontSize: 12,
    fontWeight: '500',
  },
  tagTextCompact: {
    fontSize: 10,
  },
  moreText: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginLeft: 4,
    alignSelf: 'center',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dateText: {
    fontSize: 13,
    color: COLORS.text,
  },
  dateTextCompact: {
    fontSize: 11,
  },
  peopleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: COLORS.background,
  },
  avatarCompact: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
  },
  avatarText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  avatarTextCompact: {
    fontSize: 10,
  },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  urlText: {
    fontSize: 13,
    color: COLORS.primary,
    textDecorationLine: 'underline',
  },
  urlTextCompact: {
    fontSize: 11,
  },
  relationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  relationText: {
    fontSize: 13,
    color: COLORS.textSecondary,
  },
  relationTextCompact: {
    fontSize: 11,
  },
  timestamp: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  timestampCompact: {
    fontSize: 10,
  },
  idBadge: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  idText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
