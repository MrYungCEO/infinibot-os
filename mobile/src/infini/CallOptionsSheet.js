/**
 * CallOptionsSheet — long-press the InfiniBot face. Same choices as the web
 * Voice Terminal: target type (gateway agent / CLI agent), agent, session,
 * brain (model / subscription CLI / local, BrainSection), CLI backend + session, voice engine (Local voice, the default / Cloud voice (Robovoice), optional), hands-free,
 * and "Hey Infini" (on/off, phrases, sensitivity, test, diagnostics).
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';

import { BottomSheet, SegmentedControl, useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { CLI_BACKENDS, sessionShortLabel } from './useCallOptions';
import { ChipIcon, CloudIcon, TerminalIcon, CheckIcon } from './icons';
import { WakePhraseEditor } from './WakePhraseEditor';
import { BrainSection } from './BrainSection';

function Option({ selected, title, subtitle, onPress, busy, testID, icon }) {
  const { colors, type } = useUIKit();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: !!selected, busy: !!busy }}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      testID={testID}
      style={[
        styles.option,
        {
          borderColor: selected ? withAlpha(colors.primary, 0.7) : withAlpha(colors.text, 0.1),
          backgroundColor: selected ? withAlpha(colors.primary, 0.1) : withAlpha(colors.text, 0.03),
        },
      ]}
    >
      {icon ? <View style={styles.optIcon}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {busy ? <ActivityIndicator size="small" color={colors.primary} /> : selected ? <CheckIcon size={18} color={colors.primary} /> : null}
    </Pressable>
  );
}

function Section({ label, children }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ gap: SPACE.sm, marginBottom: SPACE.lg }}>
      <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text>
      {children}
    </View>
  );
}

export function CallOptionsSheet({ visible, onClose, options, onOpenCloudConsole, wake }) {
  const { colors, type } = useUIKit();
  const { width, height } = useWindowDimensions();
  const o = options;
  const cliMode = o.route?.mode === 'cli';
  // Which half of the sheet shows; CLI can be picked before any session is open.
  const [cliView, setCliView] = useState(cliMode);
  useEffect(() => {
    if (visible) setCliView(cliMode);
  }, [visible, cliMode]);
  const openCli = (o.catalogue.open || []).filter((s) => ['claude', 'codex', 'opencode', 'grok'].includes(String(s.cliType)));
  const installed = new Set((o.catalogue.installed || []).map((i) => i.id));

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Call options" subtitle="Who you talk to and how" maxHeightRatio={0.88} side={width > height} testID="call-options-sheet">
      <Section label="Talk to">
        <SegmentedControl
          options={[
            { key: 'agent', label: 'Gateway agent' },
            { key: 'cli', label: 'CLI agent' },
          ]}
          value={cliView ? 'cli' : 'agent'}
          onChange={(k) => {
            setCliView(k === 'cli');
            if (k === 'agent' && cliMode) void o.routeToAgent();
            if (k === 'cli' && !cliMode && openCli[0]) void o.routeToSession(openCli[0]);
          }}
          testID="call-target-type"
        />
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {cliView
            ? 'Your voice goes straight into the CLI session; its answer is spoken back. Shared with the web Voice page.'
            : 'An InfiniBot agent answers (with its tools); spawned work reports back on the call.'}
        </Text>
      </Section>

      {!cliView ? (
        <>
          <Section label="Brain">
            <Text style={[type.caption, { color: colors.textMuted }]}>Which model answers. Shared with the web Voice page.</Text>
            <BrainSection options={o} />
          </Section>
          <Section label="Agent">
            {o.agents.length ? (
              o.agents.map((a) => (
                <Option
                  key={a.id}
                  title={a.name}
                  subtitle={a.id}
                  selected={o.prefs.agentId === a.id}
                  onPress={() => o.savePrefs({ agentId: a.id, sessionKey: null })}
                  testID={`call-agent-${a.id}`}
                />
              ))
            ) : (
              <Text style={[type.small, { color: colors.textMuted }]}>{o.error ? o.error : 'Loading agents…'}</Text>
            )}
          </Section>
          <Section label="Session">
            <Option title="Main session" subtitle="The agent's own conversation" selected={!o.prefs.sessionKey} onPress={() => o.savePrefs({ sessionKey: null })} testID="call-session-main" />
            {o.agentSessions.slice(0, 12).map((sess) => (
              <Option key={sess.key} title={sessionShortLabel(sess)} subtitle={sess.key} selected={o.prefs.sessionKey === sess.key} onPress={() => o.savePrefs({ sessionKey: sess.key })} />
            ))}
          </Section>
        </>
      ) : (
        <Section label="CLI session">
          {openCli.map((sess) => (
            <Option
              key={sess.id}
              icon={<TerminalIcon size={18} color={colors.primary} />}
              title={`${CLI_BACKENDS.find((b) => b.id === sess.cliType)?.label || sess.cliType} · ${sess.label}`}
              subtitle={sess.cwd || sess.status}
              selected={o.route?.target && (o.route.target.runId ? o.route.target.runId === sess.runId : o.route.target.terminalId === sess.terminalId)}
              busy={o.busy === `cli:${sess.id}`}
              onPress={() => void o.routeToSession(sess)}
            />
          ))}
          {!openCli.length ? <Text style={[type.small, { color: colors.textMuted }]}>No Claude Code / Codex / OpenCode / Grok Build session is open. Start one:</Text> : null}
          <View style={styles.row}>
            {CLI_BACKENDS.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => void o.startCli(b.id)}
                disabled={!installed.has(b.id) || !!o.busy}
                accessibilityRole="button"
                accessibilityLabel={`Start a new ${b.label} session`}
                style={[styles.pill, { borderColor: withAlpha(colors.primary, installed.has(b.id) ? 0.5 : 0.15), opacity: installed.has(b.id) ? 1 : 0.45 }]}
              >
                {o.busy === `start:${b.id}` ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={[type.caption, { color: colors.text }]}>New {b.label}</Text>}
              </Pressable>
            ))}
          </View>
          {o.routeAlive === false ? <Text style={[type.caption, { color: colors.warning }]}>The routed session isn't running — the next turn falls back to the agent.</Text> : null}
        </Section>
      )}

      <Section label="Voice engine">
        <Option
          icon={<ChipIcon size={18} color={colors.primary} />}
          title="Local voice (default)"
          subtitle="Runs on your own computer — private, no account"
          selected={o.engine === 'local'}
          busy={o.busy === 'engine' && o.engine !== 'local'}
          onPress={() => void o.setEngine('local')}
          testID="call-engine-local"
        />
        <Option
          icon={<CloudIcon size={18} color={colors.primary} />}
          title="Cloud voice (Robovoice)"
          subtitle="Optional and free — opens the Robovoice console for the call"
          selected={o.engine === 'cloud'}
          busy={o.busy === 'engine' && o.engine !== 'cloud'}
          onPress={async () => {
            await o.setEngine('cloud');
            onOpenCloudConsole?.();
          }}
          testID="call-engine-cloud"
        />
      </Section>

      <Section label="Listening">
        <View style={[styles.option, { borderColor: withAlpha(colors.text, 0.1) }]}>
          <View style={{ flex: 1 }}>
            <Text style={[type.smallStrong, { color: colors.text }]}>Hands-free</Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>Listen again after each reply; a pause ends what you said.</Text>
          </View>
          <Switch
            value={o.prefs.handsFree !== false}
            onValueChange={(v) => o.savePrefs({ handsFree: v })}
            trackColor={{ true: withAlpha(colors.primary, 0.6) }}
            thumbColor={colors.primary}
            accessibilityLabel="Hands-free listening"
          />
        </View>
        <View style={[styles.option, { borderColor: withAlpha(colors.text, 0.1) }]}>
          <View style={{ flex: 1 }}>
            <Text style={[type.smallStrong, { color: colors.text }]}>“Hey Infini” — always listening</Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>
              {wake?.tier === 'native'
                ? 'While this page is open, say a wake phrase to talk to the selected target. Recognised on this phone; no audio leaves it.'
                : 'While this page is open, say a wake phrase to talk to the selected target. Short clips of speech go only to your own gateway (local Whisper) to spot the phrase — never to a third party. Pauses when the app is in the background or the mic is muted.'}
            </Text>
            {wake?.permissionDenied ? (
              <Text style={[type.caption, { color: colors.error, marginTop: 2 }]}>Microphone access is off — allow it in Settings, then switch this on again.</Text>
            ) : null}
          </View>
          <Switch
            value={o.prefs.wake === true}
            onValueChange={(v) => o.savePrefs({ wake: v })}
            trackColor={{ true: withAlpha(colors.primary, 0.6) }}
            thumbColor={colors.primary}
            accessibilityLabel="Hey Infini, always listening"
            testID="call-wake-toggle"
          />
        </View>
        <WakePhraseEditor options={o} wake={wake} targetTitle={o.label?.title} />
      </Section>
      {o.error ? <Text style={[type.caption, { color: colors.error }]}>{o.error}</Text> : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    minHeight: 52,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
  },
  optIcon: { width: 28, alignItems: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  pill: { minHeight: 44, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
