import React from 'react';
import { View, Text, Switch, StyleSheet, TouchableOpacity, Alert, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { GlassCard } from './GlassCard';
import { COLORS, SPACING, TYPOGRAPHY } from '../constants/theme';

export function NotificationSettings({ 
  settings, 
  onSettingsChange, 
  permissionStatus,
  pushToken,
  onTestNotification,
}) {
  const openSystemSettings = () => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
  };

  const handleToggle = (key) => {
    onSettingsChange({
      ...settings,
      [key]: !settings[key],
    });
  };

  const testNotification = () => {
    onTestNotification?.();
  };

  const copyToken = () => {
    if (pushToken) {
      // Note: In a real app, you'd use Clipboard API
      Alert.alert('Push Token', pushToken, [
        { text: 'OK' }
      ]);
    }
  };

  const hasPermission = permissionStatus === 'granted';

  return (
    <View style={styles.container}>
      {/* Permission Status */}
      <GlassCard style={styles.section}>
        <View style={styles.sectionHeader}>
          <Ionicons name="notifications" size={20} color={COLORS.gold} />
          <Text style={styles.sectionTitle}>Notification Status</Text>
        </View>
        
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Permission</Text>
          <View style={[styles.statusBadge, hasPermission ? styles.statusGranted : styles.statusDenied]}>
            <Text style={styles.statusText}>
              {hasPermission ? 'Granted' : permissionStatus || 'Unknown'}
            </Text>
          </View>
        </View>

        {!hasPermission && (
          <TouchableOpacity style={styles.settingsButton} onPress={openSystemSettings}>
            <Ionicons name="settings-outline" size={16} color={COLORS.gold} />
            <Text style={styles.settingsButtonText}>Open System Settings</Text>
          </TouchableOpacity>
        )}

        {pushToken && (
          <TouchableOpacity style={styles.tokenRow} onPress={copyToken}>
            <Text style={styles.tokenLabel}>Push Token</Text>
            <Text style={styles.tokenValue} numberOfLines={1}>
              {pushToken.slice(0, 20)}...
            </Text>
            <Ionicons name="copy-outline" size={16} color={COLORS.muted} />
          </TouchableOpacity>
        )}
      </GlassCard>

      {/* Master Toggle */}
      <GlassCard style={styles.section}>
        <View style={styles.sectionHeader}>
          <Ionicons name="toggle" size={20} color={COLORS.gold} />
          <Text style={styles.sectionTitle}>Notifications</Text>
        </View>

        <SettingRow
          icon="notifications"
          label="Enable Notifications"
          description="Receive push notifications from Infinibot"
          value={settings.enabled}
          onToggle={() => handleToggle('enabled')}
        />
      </GlassCard>

      {/* Notification Types */}
      {settings.enabled && (
        <GlassCard style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="layers" size={20} color={COLORS.gold} />
            <Text style={styles.sectionTitle}>Notification Types</Text>
          </View>

          <SettingRow
            icon="chatbubbles"
            label="Agent Messages"
            description="Messages from Ash and other agents"
            value={settings.agentMessages}
            onToggle={() => handleToggle('agentMessages')}
          />

          <View style={styles.divider} />

          <SettingRow
            icon="checkbox"
            label="Task Updates"
            description="Kanban task and project changes"
            value={settings.taskUpdates}
            onToggle={() => handleToggle('taskUpdates')}
          />

          <View style={styles.divider} />

          <SettingRow
            icon="warning"
            label="System Alerts"
            description="Gateway status and system notifications"
            value={settings.systemAlerts}
            onToggle={() => handleToggle('systemAlerts')}
          />
        </GlassCard>
      )}

      {/* Sound & Vibration */}
      {settings.enabled && (
        <GlassCard style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="volume-high" size={20} color={COLORS.gold} />
            <Text style={styles.sectionTitle}>Alerts</Text>
          </View>

          <SettingRow
            icon="musical-notes"
            label="Sound"
            description="Play sound for notifications"
            value={settings.sound}
            onToggle={() => handleToggle('sound')}
          />

          <View style={styles.divider} />

          <SettingRow
            icon="phone-portrait"
            label="Vibration"
            description="Vibrate for notifications"
            value={settings.vibration}
            onToggle={() => handleToggle('vibration')}
          />
        </GlassCard>
      )}

      {/* Test Button */}
      {settings.enabled && hasPermission && (
        <TouchableOpacity style={styles.testButton} onPress={testNotification}>
          <Ionicons name="paper-plane" size={18} color={COLORS.black} />
          <Text style={styles.testButtonText}>Send Test Notification</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function SettingRow({ icon, label, description, value, onToggle }) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingIcon}>
        <Ionicons name={icon} size={18} color={COLORS.muted} />
      </View>
      <View style={styles.settingContent}>
        <Text style={styles.settingLabel}>{label}</Text>
        {description && (
          <Text style={styles.settingDescription}>{description}</Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: COLORS.border, true: COLORS.goldDim }}
        thumbColor={value ? COLORS.gold : COLORS.muted}
        ios_backgroundColor={COLORS.border}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.md,
  },
  section: {
    padding: SPACING.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  sectionTitle: {
    ...TYPOGRAPHY.label,
    color: COLORS.gold,
    fontSize: 14,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  statusLabel: {
    ...TYPOGRAPHY.body,
    color: COLORS.text,
  },
  statusBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusGranted: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
  },
  statusDenied: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.text,
    textTransform: 'capitalize',
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.goldDim,
    marginTop: SPACING.sm,
  },
  settingsButtonText: {
    color: COLORS.gold,
    fontSize: 13,
    fontWeight: '500',
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  tokenLabel: {
    color: COLORS.muted,
    fontSize: 12,
  },
  tokenValue: {
    flex: 1,
    color: COLORS.textDim,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  settingIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    ...TYPOGRAPHY.body,
    color: COLORS.text,
    fontWeight: '500',
  },
  settingDescription: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: SPACING.xs,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.gold,
    paddingVertical: SPACING.md,
    borderRadius: 12,
  },
  testButtonText: {
    color: COLORS.black,
    fontSize: 15,
    fontWeight: '600',
  },
});

export default NotificationSettings;
