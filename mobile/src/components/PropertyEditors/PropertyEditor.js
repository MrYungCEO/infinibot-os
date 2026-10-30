import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

import { TextEditor } from './TextEditor';
import { NumberEditor } from './NumberEditor';
import { SelectEditor } from './SelectEditor';
import { MultiSelectEditor } from './MultiSelectEditor';
import { StatusEditor } from './StatusEditor';
import { DateEditor } from './DateEditor';
import { CheckboxEditor } from './CheckboxEditor';
import { UrlEditor } from './UrlEditor';
import { PeopleEditor } from './PeopleEditor';
import { RelationEditor } from './RelationEditor';

/**
 * Dynamic property editor that renders the appropriate editor
 * based on the Notion property type
 */
export function PropertyEditor({
  schema,
  value,
  onChange,
  onSave,
  disabled,
  // Additional props passed to specific editors
  users,
  loadUsers,
  relatedItems,
  loadRelatedItems,
  autoFocus,
}) {
  if (!schema) {
    return (
      <View style={styles.errorState}>
        <Ionicons name="help-circle-outline" size={24} color={COLORS.textMuted} />
        <Text style={styles.errorText}>Unknown property</Text>
      </View>
    );
  }

  const { type, inputType, editable, readonly } = schema;

  // Read-only properties
  if (readonly) {
    return (
      <View style={styles.readonlyState}>
        <Ionicons name="lock-closed-outline" size={16} color={COLORS.textMuted} />
        <Text style={styles.readonlyText}>
          This property is computed automatically and cannot be edited.
        </Text>
      </View>
    );
  }

  // Unknown or unsupported types
  if (!editable) {
    return (
      <View style={styles.unsupportedState}>
        <Ionicons name="code-working-outline" size={24} color={COLORS.textMuted} />
        <Text style={styles.unsupportedText}>
          Editing "{type}" properties is not supported yet.
        </Text>
      </View>
    );
  }

  // Render the appropriate editor
  switch (inputType || type) {
    case 'title':
    case 'rich_text':
    case 'text':
      return (
        <TextEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          multiline={type === 'rich_text'}
          autoFocus={autoFocus}
          disabled={disabled}
        />
      );

    case 'number':
      return (
        <NumberEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          autoFocus={autoFocus}
          disabled={disabled}
        />
      );

    case 'select':
      return (
        <SelectEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          options={schema.options}
          disabled={disabled}
        />
      );

    case 'multiSelect':
    case 'multi_select':
      return (
        <MultiSelectEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          options={schema.options}
          disabled={disabled}
        />
      );

    case 'status':
      return (
        <StatusEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          options={schema.options}
          groups={schema.groups}
          disabled={disabled}
        />
      );

    case 'date':
      return (
        <DateEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          disabled={disabled}
        />
      );

    case 'people':
      return (
        <PeopleEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          users={users}
          loadUsers={loadUsers}
          disabled={disabled}
        />
      );

    case 'checkbox':
      return (
        <CheckboxEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          disabled={disabled}
        />
      );

    case 'url':
      return (
        <UrlEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          type="url"
          autoFocus={autoFocus}
          disabled={disabled}
        />
      );

    case 'email':
      return (
        <UrlEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          type="email"
          autoFocus={autoFocus}
          disabled={disabled}
        />
      );

    case 'phone':
    case 'phone_number':
      return (
        <UrlEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          type="phone"
          autoFocus={autoFocus}
          disabled={disabled}
        />
      );

    case 'relation':
      return (
        <RelationEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          schema={schema}
          relatedItems={relatedItems}
          loadRelatedItems={loadRelatedItems}
          disabled={disabled}
        />
      );

    case 'files':
      // File upload requires more complex implementation
      return (
        <View style={styles.unsupportedState}>
          <Ionicons name="cloud-upload-outline" size={24} color={COLORS.textMuted} />
          <Text style={styles.unsupportedText}>
            File upload coming soon. Use Notion directly for now.
          </Text>
        </View>
      );

    default:
      return (
        <View style={styles.unsupportedState}>
          <Ionicons name="help-circle-outline" size={24} color={COLORS.textMuted} />
          <Text style={styles.unsupportedText}>
            Unknown property type: {type}
          </Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  errorState: {
    alignItems: 'center',
    padding: SPACING.lg,
  },
  errorText: {
    fontSize: 14,
    color: COLORS.textMuted,
    marginTop: SPACING.sm,
  },
  readonlyState: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: COLORS.surface + '88',
    borderRadius: 8,
    gap: SPACING.sm,
  },
  readonlyText: {
    fontSize: 13,
    color: COLORS.textMuted,
    flex: 1,
  },
  unsupportedState: {
    alignItems: 'center',
    padding: SPACING.lg,
    backgroundColor: COLORS.surface + '44',
    borderRadius: 8,
  },
  unsupportedText: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
});
