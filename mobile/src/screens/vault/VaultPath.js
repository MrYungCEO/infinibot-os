/**
 * VaultPath — port of ui/src/ui/views/vault-onboarding.ts: the learning-path
 * wizard (welcome → interests → goals → skill → commitment → focus →
 * generating → result) over vault.learningPath.generate, plus the saved path
 * (vault.learningPath.get) for the current member.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, SectionTitle, Button, Field, Chip, ProgressBar, EmptyState, useUIKit, SPACE, RADIUS, MONO_FAMILY } from '../../ui-kit';
import {
  INTEREST_OPTIONS,
  GOAL_OPTIONS,
  FOCUS_OPTIONS,
  SKILL_LEVELS,
  HOURS_PRESETS,
  PATH_STEPS,
  emptyAnswers,
  canAdvancePath,
  buildLearningPathParams,
  normalizeLearningPath,
  toggleIn,
  formatDate,
  errorText,
} from './vault-model';
import { OptionChips } from './vault-ui';

const HERO = [
  { icon: 'ribbon-outline', title: 'Your kingdom awaits', text: 'Welcome to the Kingly Vault. Craft a personalised learning path forged from your ambitions, drawn from the curated courses.' },
  { icon: 'compass-outline', title: 'What interests you?', text: 'Select the areas that spark your curiosity. You can pick several.' },
  { icon: 'locate-outline', title: 'What are your goals?', text: 'What do you hope to achieve on your journey?' },
  { icon: 'bulb-outline', title: 'Your current level', text: 'Where would you place yourself today?' },
  { icon: 'time-outline', title: 'Your time commitment', text: 'How many hours per week can you dedicate to learning?' },
  { icon: 'sparkles-outline', title: 'What excites you most?', text: 'Tell us what you really want to learn, or write your own focus.' },
];

export function VaultPath({ ctx }) {
  const { colors, type } = useUIKit();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(emptyAnswers());
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [path, setPath] = useState(null);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    ctx.sendReq('vault.learningPath.get', { memberId: 'current' })
      .then((r) => setSaved(normalizeLearningPath(r)))
      .catch(() => setSaved(null));
  }, [ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    setStep(0);
    setAnswers(emptyAnswers());
    setPath(null);
    setError(null);
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await ctx.sendReq('vault.learningPath.generate', buildLearningPathParams(answers, 'current'));
      const lp = normalizeLearningPath(res);
      if (lp) {
        setPath(lp);
        setSaved(lp);
      } else setError(new Error('No path returned. Please try again.'));
    } catch (e) {
      setError(e);
    } finally {
      setGenerating(false);
    }
  };

  const next = () => {
    if (step < 5) setStep(step + 1);
    else generate();
  };

  if (generating) {
    return (
      <Card padded style={{ marginTop: SPACE.lg }}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={[type.h3, { color: colors.text }]}>Forging your path</Text>
          <Text style={[type.small, { color: colors.textSecondary, textAlign: 'center' }]}>Analysing your interests and matching them with available courses...</Text>
        </View>
      </Card>
    );
  }

  if (path || error) {
    return (
      <View>
        {error ? (
          <EmptyState icon="alert-circle-outline" tone="danger" title="Could not generate a path" message={errorText(error)} actionLabel="Try again" onAction={() => { setError(null); setStep(5); }} secondaryLabel="Start over" onSecondary={reset} />
        ) : (
          <PathView path={path} footer={<Button title="Path saved - start learning" icon="checkmark" onPress={() => { reset(); ctx.go('courses'); }} fullWidth />} />
        )}
      </View>
    );
  }

  const hero = HERO[step];
  const toggleChip = (field, v) => setAnswers({ ...answers, [field]: toggleIn(answers[field], v) });

  return (
    <View>
      <View style={{ marginTop: SPACE.md, gap: SPACE.xs }}>
        <View style={styles.rowBetween}>
          <Text style={[type.label, { color: colors.textSecondary }]}>{PATH_STEPS[step]}</Text>
          <Text style={[type.monoSmall, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>{step + 1} / 7</Text>
        </View>
        <ProgressBar value={(step + 1) / 7} />
      </View>

      <Card padded style={{ marginTop: SPACE.md }}>
        <View style={{ gap: SPACE.md }}>
          <View style={styles.center}>
            <Ionicons name={hero.icon} size={32} color={colors.primary} />
            <Text style={[type.h2, { color: colors.text, textAlign: 'center' }]}>{hero.title}</Text>
            <Text style={[type.small, { color: colors.textSecondary, textAlign: 'center' }]}>{hero.text}</Text>
          </View>

          {step === 1 ? (
            <OptionChips label="Pick your interests" multi options={INTEREST_OPTIONS} value={answers.interests} onChange={(v) => toggleChip('interests', v)} />
          ) : null}
          {step === 2 ? (
            <OptionChips label="Select your goals" multi options={GOAL_OPTIONS} value={answers.goals} onChange={(v) => toggleChip('goals', v)} />
          ) : null}
          {step === 3 ? (
            <View style={{ gap: SPACE.sm }}>
              {SKILL_LEVELS.map((o) => (
                <Card key={o.key} padded tint={answers.skillLevel === o.key ? 'primary' : 'neutral'} onPress={() => setAnswers({ ...answers, skillLevel: o.key })} accessibilityLabel={`${o.label}: ${o.desc}`}>
                  <View style={styles.rowBetween}>
                    <View style={{ flex: 1 }}>
                      <Text style={[type.bodyStrong, { color: colors.text }]}>{o.label}</Text>
                      <Text style={[type.caption, { color: colors.textMuted }]}>{o.desc}</Text>
                    </View>
                    {answers.skillLevel === o.key ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
                  </View>
                </Card>
              ))}
            </View>
          ) : null}
          {step === 4 ? (
            <View style={{ gap: SPACE.sm }}>
              <OptionChips label="Hours per week" options={HOURS_PRESETS.map((h) => ({ key: h, label: `${h} hrs` }))} value={answers.hoursPerWeek} onChange={(v) => v && setAnswers({ ...answers, hoursPerWeek: v })} />
              <Field
                label="Custom hours (1-80)"
                value={String(answers.hoursPerWeek || '')}
                onChangeText={(t) => {
                  const v = parseInt(t.replace(/[^0-9]/g, ''), 10);
                  setAnswers({ ...answers, hoursPerWeek: Number.isFinite(v) ? Math.min(v, 80) : 0 });
                }}
                keyboardType="number-pad"
                mono
              />
            </View>
          ) : null}
          {step === 5 ? (
            <View style={{ gap: SPACE.sm }}>
              <OptionChips
                label="Choose a focus"
                options={FOCUS_OPTIONS}
                value={FOCUS_OPTIONS.includes(answers.wantToLearn) ? answers.wantToLearn : null}
                onChange={(v) => setAnswers({ ...answers, wantToLearn: answers.wantToLearn === v ? '' : v || '' })}
              />
              <Field
                label="Or write your own focus"
                value={FOCUS_OPTIONS.includes(answers.wantToLearn) ? '' : answers.wantToLearn}
                onChangeText={(v) => setAnswers({ ...answers, wantToLearn: v })}
                placeholder="e.g. I want to build AI-powered marketing funnels..."
                multiline
                rows={3}
              />
            </View>
          ) : null}

          <View style={styles.actions}>
            {step > 0 ? <Button title="Back" icon="arrow-back" variant="ghost" onPress={() => setStep(step - 1)} /> : null}
            <Button
              title={step === 0 ? 'Begin your path' : step === 5 ? 'Generate my path' : 'Continue'}
              icon={step === 5 ? 'sparkles-outline' : undefined}
              disabled={!canAdvancePath(step, answers)}
              onPress={next}
            />
          </View>
        </View>
      </Card>

      {saved && step === 0 ? (
        <>
          <SectionTitle title="Saved learning path" subtitle={saved.generatedAt ? `Generated ${formatDate(saved.generatedAt)}` : undefined} />
          <PathView path={saved} />
        </>
      ) : null}
    </View>
  );
}

function PathView({ path, footer }) {
  const { colors, type } = useUIKit();
  if (!path) return null;
  return (
    <View style={{ gap: SPACE.sm, marginTop: SPACE.md }}>
      <Card padded>
        <View style={{ gap: SPACE.sm }}>
          <Text style={[type.h3, { color: colors.text }]}>Your learning path</Text>
          {path.summary ? <Text style={[type.small, { color: colors.textSecondary }]}>{path.summary}</Text> : null}
          <View style={styles.rowBetween}>
            <Stat label="Weeks" value={path.totalWeeks} />
            <Stat label="Courses" value={path.totalCourses} />
            <Stat label="Per week" value={`${path.hoursPerWeek}h`} />
          </View>
        </View>
      </Card>
      {path.weeks.map((w) => (
        <Card key={w.week} padded>
          <View style={{ gap: SPACE.xs }}>
            <View style={styles.rowBetween}>
              <Text style={[type.smallStrong, { color: colors.primary }]}>Week {w.week}</Text>
              <Text style={[type.caption, { color: colors.textMuted, flex: 1, textAlign: 'right' }]} numberOfLines={2}>{w.focus}</Text>
            </View>
            <View style={styles.chips}>
              {w.courses.map((c) => <Chip key={`${w.week}-${c.id}`} label={c.name} size="sm" tone="primary" accessibilityLabel={`${c.name}${c.reason ? `: ${c.reason}` : ''}`} />)}
            </View>
            {w.courses.some((c) => c.reason) ? (
              <Text style={[type.caption, { color: colors.textMuted }]}>{w.courses.map((c) => c.reason).filter(Boolean).join(' · ')}</Text>
            ) : null}
          </View>
        </Card>
      ))}
      {footer || null}
    </View>
  );
}

function Stat({ label, value }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.stat, { borderColor: colors.border }]}>
      <Text style={[type.metricSmall, { color: colors.text, fontFamily: MONO_FAMILY }]}>{String(value)}</Text>
      <Text style={[type.caption, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  stat: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.sm, paddingVertical: SPACE.sm },
});

export default VaultPath;
