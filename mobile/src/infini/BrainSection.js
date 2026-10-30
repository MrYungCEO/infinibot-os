/**
 * BrainSection — the call's voice brain, 1:1 with the web Voice page picker
 * (ui/src/ui/views/voice-robovoice/brain-models.ts):
 *
 *   Agent default        the agent's own model
 *   Subscriptions (CLI)  claude-cli, codex-cli… with installed / signed-in state
 *   API providers        configured providers, each with its live model list
 *                        (search, Free badges, Free only); unconfigured ones
 *                        offer "Add key" (check key → pick model → Test & use)
 *   Local                Ollama / vLLM models on the gateway's machine
 *
 * Picking calls voice.cliRoute.set { mode: 'api', model } through useCallOptions,
 * so the phone and the web share one choice (stored on the gateway).
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, useUIKit, SPACE, RADIUS, MONO_FAMILY } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { BotIcon, CheckIcon, ChevronIcon, ChipIcon, KeyIcon, ServerIcon } from './icons';

const FEATURED = ['ollama-cloud', 'openrouter', 'anthropic', 'openai', 'google', 'groq'];
const rank = (id) => (FEATURED.includes(id) ? FEATURED.indexOf(id) : FEATURED.length);

export function cliState(c) {
  if (!c.installed) return { text: 'Not installed', usable: false, tone: 'off' };
  if (c.auth === 'signed-out') return { text: 'Signed out', usable: false, tone: 'warn' };
  if (c.auth === 'signed-in') return { text: 'Signed in', usable: true, tone: 'ok' };
  if (c.auth === 'api-key' || c.auth === 'env') return { text: 'Key set', usable: true, tone: 'ok' };
  return { text: 'Installed', usable: true, tone: 'ok' };
}

function Row({ title, subtitle, selected, busy, onPress, icon, right, testID, disabled }) {
  const { colors, type } = useUIKit();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole={onPress && !disabled ? 'radio' : undefined}
      accessibilityState={{ selected: !!selected, busy: !!busy, disabled: !!disabled }}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      testID={testID}
      style={[
        styles.row,
        {
          borderColor: selected ? withAlpha(colors.primary, 0.7) : withAlpha(colors.text, 0.1),
          backgroundColor: selected ? withAlpha(colors.primary, 0.1) : withAlpha(colors.text, 0.03),
          opacity: disabled ? 0.65 : 1,
        },
      ]}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
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
      {right}
      {busy ? <ActivityIndicator size="small" color={colors.primary} /> : selected ? <CheckIcon size={18} color={colors.primary} /> : null}
    </Pressable>
  );
}

function Tag({ text, tone }) {
  const { colors, type } = useUIKit();
  const c = tone === 'ok' ? colors.success || '#6fe3a1' : tone === 'warn' ? colors.warning || '#f5b942' : colors.textMuted;
  return (
    <View style={[styles.tag, { borderColor: withAlpha(c, 0.5) }]}>
      <Text style={[type.caption, { color: c }]}>{text}</Text>
    </View>
  );
}

function Group({ label, icon, children }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ gap: SPACE.sm, marginTop: SPACE.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon}
        <Text style={[type.label, { color: colors.primary }]}>{label}</Text>
      </View>
      {children}
    </View>
  );
}

function ModelList({ provider, current, busy, onPick }) {
  const { colors, type } = useUIKit();
  const [q, setQ] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const anyFree = provider.models.some((m) => m.free);
  const shown = provider.models
    .filter((m) => (!freeOnly || m.free) && (!q.trim() || m.id.toLowerCase().includes(q.trim().toLowerCase())))
    // The active model leads, so it is visible without scrolling (same as web).
    .sort((a, b) => Number(current === `${provider.id}/${b.id}`) - Number(current === `${provider.id}/${a.id}`));
  return (
    <View style={[styles.nested, { borderLeftColor: withAlpha(colors.primary, 0.2) }]}>
      {provider.models.length > 8 || anyFree ? (
        <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'center' }}>
          {provider.models.length > 8 ? (
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={`Search ${provider.models.length} models`}
              placeholderTextColor={withAlpha(colors.text, 0.4)}
              accessibilityLabel={`Search ${provider.label} models`}
              style={[styles.input, { flex: 1, color: colors.text, borderColor: withAlpha(colors.text, 0.14) }]}
            />
          ) : null}
          {anyFree ? (
            <Pressable
              onPress={() => setFreeOnly(!freeOnly)}
              accessibilityRole="switch"
              accessibilityState={{ checked: freeOnly }}
              style={[styles.pill, { borderColor: withAlpha(freeOnly ? '#6fe3a1' : colors.text, freeOnly ? 0.6 : 0.16) }]}
            >
              <Text style={[type.caption, { color: freeOnly ? '#6fe3a1' : colors.text }]}>Free only</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {shown.slice(0, 120).map((m) => {
        const ref = `${provider.id}/${m.id}`;
        const sel = current === ref;
        return (
          <Pressable
            key={m.id}
            onPress={() => onPick(ref)}
            accessibilityRole="radio"
            accessibilityState={{ selected: sel }}
            testID={`call-brain-model-${ref}`}
            style={[styles.model, { borderColor: sel ? withAlpha(colors.primary, 0.7) : 'transparent', backgroundColor: sel ? withAlpha(colors.primary, 0.1) : 'transparent' }]}
          >
            <Text style={[type.caption, { color: colors.text, flex: 1, fontFamily: MONO_FAMILY }]}>{m.id}</Text>
            {m.free ? <Tag text="Free" tone="ok" /> : null}
            {busy === `model:${ref}` ? <ActivityIndicator size="small" color={colors.primary} /> : sel ? <CheckIcon size={16} color={colors.primary} /> : null}
          </Pressable>
        );
      })}
      {!shown.length ? <Text style={[type.caption, { color: colors.textMuted }]}>No models match.</Text> : null}
    </View>
  );
}

function AddKey({ provider, options }) {
  const { colors, type } = useUIKit();
  const [key, setKey] = useState('');
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [msg, setMsg] = useState(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    setMsg(null);
    try {
      const res = await options.checkKey(provider.id, key.trim());
      if (res?.error) throw new Error(res.error);
      const list = (res?.models || []).map((m) => (typeof m === 'string' ? { id: m } : m));
      setModels(list);
      setModel(res?.defaultModel && list.some((m) => m.id === res.defaultModel) ? res.defaultModel : list[0]?.id || '');
      const free = list.filter((m) => m.free).length;
      setMsg({ ok: true, text: `Key works. ${list.length} models${free ? `, ${free} free` : ''}. Pick one, then Test & use.` });
    } catch (e) {
      setMsg({ ok: false, text: `That key didn't work: ${e?.message || String(e)}` });
    } finally {
      setChecking(false);
    }
  };
  return (
    <View style={[styles.addkey, { borderColor: withAlpha(colors.primary, 0.25) }]}>
      <TextInput
        value={key}
        onChangeText={(v) => {
          setKey(v);
          setModels([]);
          setMsg(null);
        }}
        placeholder={provider.keyHint || `${provider.label} API key`}
        placeholderTextColor={withAlpha(colors.text, 0.4)}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={`${provider.label} API key`}
        style={[styles.input, { color: colors.text, borderColor: withAlpha(colors.text, 0.14), fontFamily: MONO_FAMILY }]}
      />
      {provider.keyUrl ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>
          Get a key at{' '}
          <Text style={{ color: colors.primary }} onPress={() => Linking.openURL(provider.keyUrl)}>
            {provider.keyUrl.replace(/^https?:\/\//, '').split('/')[0]}
          </Text>
          . Stored only on your computer.
        </Text>
      ) : null}
      {models.length ? <ModelList provider={{ ...provider, models }} current={`${provider.id}/${model}`} busy={null} onPick={(ref) => setModel(ref.slice(provider.id.length + 1))} /> : null}
      {msg ? <Text style={[type.caption, { color: msg.ok ? '#8cebb6' : colors.error }]}>{msg.text}</Text> : null}
      <View style={{ flexDirection: 'row', gap: SPACE.sm, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Button title={checking ? 'Checking…' : 'Check key'} variant="secondary" size="sm" disabled={!key.trim() || checking} onPress={check} />
        <Button
          title={options.busy === `key:${provider.id}` ? 'Testing…' : 'Test & use'}
          size="sm"
          disabled={!key.trim() || !model || !!options.busy}
          loading={options.busy === `key:${provider.id}`}
          onPress={() => void options.saveKeyAndUse(provider.id, key, model)}
        />
      </View>
    </View>
  );
}

export function BrainSection({ options }) {
  const { colors, type } = useUIKit();
  const o = options;
  const b = o.brain;
  const current = o.route?.mode === 'cli' ? null : o.route?.model || null;
  const sessionRouted = o.route?.mode === 'cli';
  const [open, setOpen] = useState(() => new Set(current ? [current.split('/')[0]] : []));
  const [addKeyFor, setAddKeyFor] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const api = useMemo(() => [...(b?.api || [])].sort((x, y) => rank(x.id) - rank(y.id) || x.label.localeCompare(y.label)), [b]);
  const configured = api.filter((p) => p.configured);
  const unconfigured = api.filter((p) => !p.configured);
  const featuredUnconf = unconfigured.filter((p) => FEATURED.includes(p.id));
  const moreUnconf = unconfigured.filter((p) => !FEATURED.includes(p.id));
  const toggle = (id) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  if (!b) return <Text style={[type.small, { color: colors.textMuted }]}>Loading your models…</Text>;

  return (
    <View style={{ gap: SPACE.sm }}>
      <Row
        icon={<BotIcon size={18} color={colors.primary} />}
        title="Agent default"
        subtitle={b.agentModel || "The agent's own model"}
        selected={!sessionRouted && !current}
        busy={o.busy === 'model:agent'}
        onPress={() => void o.pickModel(null)}
        testID="call-brain-agent-default"
      />

      <Group label="Subscriptions (CLI)" icon={<ChipIcon size={14} color={colors.primary} />}>
        {(b.cli || []).map((c) => {
          const st = cliState(c);
          const ref = `${c.id}/${c.model}`;
          return (
            <Row
              key={c.id}
              icon={<ChipIcon size={18} color={colors.primary} />}
              title={c.account || c.label}
              subtitle={`${c.label} · ${c.model}`}
              selected={!sessionRouted && current === ref}
              busy={o.busy === `model:${ref}`}
              disabled={!st.usable}
              onPress={() => void o.pickModel(ref)}
              right={<Tag text={st.text} tone={st.tone} />}
              testID={`call-brain-cli-${c.id}`}
            />
          );
        })}
        {!(b.cli || []).length ? <Text style={[type.caption, { color: colors.textMuted }]}>Subscription CLIs aren't available on this gateway.</Text> : null}
      </Group>

      <Group label="API providers" icon={<KeyIcon size={14} color={colors.primary} />}>
        {configured.map((p) => {
          const isOpen = open.has(p.id);
          const free = p.models.filter((m) => m.free).length;
          return (
            <View key={p.id} style={{ gap: SPACE.xs }}>
              <Row
                icon={<KeyIcon size={18} color={colors.primary} />}
                title={p.label}
                subtitle={p.error ? "Couldn't list models" : `${p.models.length} models${free ? ` · ${free} free` : ''}`}
                selected={!sessionRouted && !!current && current.startsWith(`${p.id}/`)}
                onPress={() => toggle(p.id)}
                right={<ChevronIcon open={isOpen} size={16} color={colors.textMuted} />}
                testID={`call-brain-provider-${p.id}`}
              />
              {isOpen ? (
                p.error ? (
                  <Text style={[type.caption, { color: colors.error }]}>{p.label}: {p.error}</Text>
                ) : (
                  <ModelList provider={p} current={sessionRouted ? null : current} busy={o.busy} onPick={(ref) => void o.pickModel(ref)} />
                )
              ) : null}
            </View>
          );
        })}
        {!configured.length ? <Text style={[type.caption, { color: colors.textMuted }]}>No API provider has a key yet. Add one below.</Text> : null}
        {unconfigured.length ? <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>Add a provider</Text> : null}
        {[...featuredUnconf, ...(showMore ? moreUnconf : [])].map((p) => (
          <View key={p.id} style={{ gap: SPACE.xs }}>
            <Row
              title={p.label}
              subtitle="Bring your own key"
              right={
                <Button
                  title={addKeyFor === p.id ? 'Cancel' : 'Add key'}
                  size="sm"
                  variant={addKeyFor === p.id ? 'secondary' : 'primary'}
                  onPress={() => setAddKeyFor(addKeyFor === p.id ? null : p.id)}
                  testID={`call-brain-addkey-${p.id}`}
                />
              }
            />
            {addKeyFor === p.id ? <AddKey provider={p} options={o} /> : null}
          </View>
        ))}
        {moreUnconf.length ? (
          <Button title={showMore ? 'Fewer providers' : `More providers (${moreUnconf.length})`} variant="ghost" size="sm" onPress={() => setShowMore(!showMore)} />
        ) : null}
      </Group>

      <Group label="Local" icon={<ServerIcon size={14} color={colors.primary} />}>
        {(b.local || []).map((l) => (
          <Row
            key={l.ref}
            icon={<ServerIcon size={18} color={colors.primary} />}
            title={l.model}
            subtitle={`${l.provider}${l.note ? ` · ${l.note}` : ' · on your computer'}`}
            selected={!sessionRouted && current === l.ref}
            busy={o.busy === `model:${l.ref}`}
            onPress={() => void o.pickModel(l.ref)}
            right={<Tag text={l.onDemand ? 'On demand' : 'Running'} tone={l.onDemand ? 'warn' : 'ok'} />}
            testID={`call-brain-local-${l.ref}`}
          />
        ))}
        {!(b.local || []).length ? <Text style={[type.caption, { color: colors.textMuted }]}>No local model is running. Start Ollama or vLLM to use one.</Text> : null}
      </Group>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 52, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, borderWidth: 1 },
  icon: { width: 28, alignItems: 'center' },
  tag: { borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 2 },
  nested: { gap: 4, marginLeft: SPACE.md, paddingLeft: SPACE.md, borderLeftWidth: 1 },
  model: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.sm || 8, borderWidth: 1 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md },
  pill: { minHeight: 44, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  addkey: { gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
});
