/**
 * VaultCourses — port of ui/src/ui/views/vault-courses.ts.
 * Control deck (search, refresh, new, stats, status filter), course cards,
 * course editor (publish / archive / edit / delete, module + lesson structure),
 * module editor and lesson editor. Params use the gateway vocabulary
 * (name/requiredTier/thumbnailUrl, moduleId+courseId, lessonId+moduleId).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Card,
  ListRow,
  Divider,
  SectionTitle,
  Button,
  Field,
  Chip,
  StatusChip,
  BottomSheet,
  EmptyState,
  SkeletonRow,
  useUIKit,
  SPACE,
  RADIUS,
  MONO_FAMILY,
} from '../../ui-kit';
import {
  COURSE_FILTERS,
  COURSE_TIERS,
  LESSON_TYPES,
  normalizeCourse,
  courseStats,
  filterCourses,
  buildCourseParams,
  courseForm,
  buildModuleCreate,
  buildModuleUpdate,
  buildLessonCreate,
  buildLessonUpdate,
  unwrap,
  titleCase,
  formatNumber,
} from './vault-model';
import { OptionChips, StatGrid, SectionError } from './vault-ui';

const lessonIcon = (t) => (LESSON_TYPES.find((x) => x.key === t) || LESSON_TYPES[0]).icon;

export function VaultCourses({ ctx, courseId }) {
  const { colors, type } = useUIKit();
  const { sendReq, dialogs } = ctx;
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(courseId || null);
  const [course, setCourse] = useState(null);
  const [courseErr, setCourseErr] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | 'edit'
  const [moduleOpen, setModuleOpen] = useState(null);
  const [lessonOpen, setLessonOpen] = useState(null);
  const [busy, setBusy] = useState(null);

  const loadList = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('vault.courses.list', {});
      setCourses((Array.isArray(res?.courses) ? res.courses : []).map(normalizeCourse));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [sendReq]);

  const loadCourse = useCallback(async (id) => {
    if (!sendReq || !id) return null;
    try {
      const res = await sendReq('vault.courses.get', { id });
      const c = res?.course ? normalizeCourse(res.course) : null;
      setCourse(c);
      setCourseErr(c ? null : new Error('Course not found'));
      if (c) setCourses((prev) => (prev ? prev.map((x) => (x.id === c.id ? c : x)) : prev));
      return c;
    } catch (e) {
      setCourseErr(e);
      return null;
    }
  }, [sendReq]);

  useEffect(() => { loadList(); }, [ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (courseId) setOpenId(courseId); }, [courseId]);
  useEffect(() => {
    setCourse(null);
    setCourseErr(null);
    if (openId) loadCourse(openId);
  }, [openId, ctx.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = ctx.intent?.type;
    if (!t) return;
    if (t === 'newCourse') { setOpenId(null); setEditing('new'); ctx.clearIntent(); }
    else if (t.startsWith('openCourse:')) { setOpenId(t.slice('openCourse:'.length)); ctx.clearIntent(); }
  }, [ctx.intent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the open module / lesson sheets pointing at fresh objects after a reload.
  useEffect(() => {
    if (!course) return;
    if (moduleOpen) setModuleOpen(course.modules.find((m) => m.id === moduleOpen.id) || null);
    if (lessonOpen) {
      const mod = course.modules.find((m) => m.id === lessonOpen.moduleId);
      setLessonOpen(mod?.lessons.find((l) => l.id === lessonOpen.id) || null);
    }
  }, [course]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key, fn, okText) => {
    setBusy(key);
    try {
      await fn();
      if (okText) ctx.notify(okText);
      return true;
    } catch (e) {
      ctx.fail(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ── Course editor view ──
  if (openId) {
    const back = (
      <Button title="All courses" icon="chevron-back" variant="ghost" size="sm" onPress={() => { setOpenId(null); setCourse(null); }} style={{ alignSelf: 'flex-start', marginTop: SPACE.sm }} />
    );
    if (courseErr) return <View>{back}<SectionError error={courseErr} onRetry={() => loadCourse(openId)} what="this course" /></View>;
    if (!course) return <View>{back}<Card padded={false}><SkeletonRow /><SkeletonRow /></Card></View>;

    const publish = () => act('publish', async () => { await sendReq('vault.courses.publish', { id: course.id }); await loadCourse(course.id); }, 'Course published');
    const archive = () => act('archive', async () => { await sendReq('vault.courses.archive', { id: course.id }); await loadCourse(course.id); }, 'Course archived');
    const remove = async () => {
      const ok = await dialogs.confirm({ title: 'Delete this course?', message: 'This cannot be undone. Use Archive for a reversible removal.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      const done = await act('delete', () => sendReq('vault.courses.delete', { id: course.id }), 'Course deleted');
      if (done) { setOpenId(null); setCourse(null); loadList(); }
    };
    const addModule = async () => {
      const title = await dialogs.prompt({ title: 'New module', placeholder: 'Module title', required: true, confirmLabel: 'Add' });
      if (!title || !title.trim()) return;
      act('addModule', async () => {
        const res = await sendReq('vault.modules.create', buildModuleCreate(course.id, title, course.modules.length));
        const c = await loadCourse(course.id);
        const created = unwrap(res, 'module');
        const m = c?.modules.find((x) => x.id === String(created?.id));
        if (m) setModuleOpen(m);
      }, 'Module added');
    };

    return (
      <View>
        {back}
        <Card padded>
          <View style={{ gap: SPACE.sm }}>
            {course.coverImage ? <Image source={{ uri: course.coverImage }} style={styles.cover} resizeMode="cover" accessibilityLabel={`${course.title} cover`} /> : null}
            <Text style={[type.h2, { color: colors.text }]}>{course.title}</Text>
            <View style={styles.chips}>
              <StatusChip status={course.status} />
              <Chip label={course.tier.toUpperCase()} tone="primary" />
              {course.slug ? <Chip label={course.slug} size="sm" /> : null}
            </View>
            <Text style={[type.body, { color: colors.textSecondary }]}>{course.description || 'No description provided.'}</Text>
            <View style={styles.chips}>
              {course.status === 'draft' ? <Button title="Publish" icon="rocket-outline" size="sm" loading={busy === 'publish'} onPress={publish} /> : null}
              {course.status === 'published' ? <Button title="Archive" icon="archive-outline" size="sm" variant="secondary" loading={busy === 'archive'} onPress={archive} /> : null}
              <Button title="Edit" icon="create-outline" size="sm" variant="secondary" onPress={() => setEditing('edit')} />
              <Button title="Delete" icon="trash-outline" size="sm" variant="danger" loading={busy === 'delete'} onPress={remove} />
            </View>
          </View>
        </Card>

        <SectionTitle title="Course overview" />
        <StatGrid
          items={[
            { key: 'm', label: 'Modules', value: String(course.modules.length), icon: 'layers-outline' },
            { key: 'l', label: 'Lessons', value: String(course.lessonCount), icon: 'document-text-outline' },
            { key: 'e', label: 'Enrolled', value: formatNumber(course.enrollmentCount), icon: 'people-outline' },
            { key: 'c', label: 'Completion', value: `${course.completionRate}%`, icon: 'checkmark-done-outline' },
          ]}
        />

        <SectionTitle title="Structure" count={course.modules.length} actionLabel="Add module" actionIcon="add" onAction={addModule} />
        {course.modules.length === 0 ? (
          <EmptyState icon="layers-outline" title="No modules yet" message="Add a module, then lessons inside it." actionLabel="Add module" onAction={addModule} compact />
        ) : (
          <Card padded={false}>
            {course.modules.map((m, i) => (
              <View key={m.id}>
                {i > 0 ? <Divider /> : null}
                <ListRow
                  icon="layers-outline"
                  title={m.title}
                  subtitle={m.description || undefined}
                  value={`${m.lessons.length} lessons`}
                  onPress={() => setModuleOpen(m)}
                  accessibilityLabel={`Module ${m.title}, ${m.lessons.length} lessons`}
                />
                {m.lessons.map((l) => (
                  <ListRow
                    key={l.id}
                    dense
                    style={{ paddingLeft: SPACE.xl }}
                    icon={lessonIcon(l.contentType)}
                    iconTone="neutral"
                    title={l.title}
                    value={l.contentType}
                    onPress={() => setLessonOpen(l)}
                    accessibilityLabel={`Lesson ${l.title}`}
                  />
                ))}
              </View>
            ))}
          </Card>
        )}

        <CourseSheet ctx={ctx} mode={editing} course={editing === 'edit' ? course : null} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await loadCourse(course.id); loadList(); }} />
        <ModuleSheet ctx={ctx} mod={moduleOpen} onClose={() => setModuleOpen(null)} reload={() => loadCourse(course.id)} onOpenLesson={(l) => { setModuleOpen(null); setLessonOpen(l); }} />
        <LessonSheet ctx={ctx} lesson={lessonOpen} onClose={() => setLessonOpen(null)} reload={() => loadCourse(course.id)} />
      </View>
    );
  }

  // ── List view ──
  const list = courses || [];
  const stats = courseStats(list);
  const visible = filterCourses(list, { status: filter, search });

  return (
    <View>
      <View style={{ marginTop: SPACE.md, gap: SPACE.sm }}>
        <Field value={search} onChangeText={setSearch} placeholder="Search courses..." icon="search-outline" accessibilityLabel="Search courses" />
        <View style={styles.chips}>
          {COURSE_FILTERS.map((f) => (
            <Chip key={f} label={f === 'all' ? 'All' : titleCase(f)} selected={filter === f} tone="primary" onPress={() => setFilter(f)} accessibilityLabel={`Show ${f} courses`} />
          ))}
          <View style={{ flex: 1 }} />
          <Button title="New" icon="add" size="sm" onPress={() => setEditing('new')} />
        </View>
      </View>

      <SectionTitle title="Content library" subtitle="Courses and learning modules" />
      <StatGrid
        items={[
          { key: 't', label: 'Total', value: String(stats.total), icon: 'library-outline' },
          { key: 'p', label: 'Published', value: String(stats.published), icon: 'checkmark-circle-outline', tone: 'success' },
          { key: 'd', label: 'Drafts', value: String(stats.draft), icon: 'create-outline' },
          { key: 'a', label: 'Archived', value: String(stats.archived), icon: 'archive-outline', tone: 'danger' },
          { key: 'e', label: 'Enrollments', value: formatNumber(stats.enrollments), icon: 'people-outline' },
        ]}
      />

      <SectionTitle title="Courses" count={courses ? visible.length : undefined} />
      {error ? (
        <SectionError error={error} onRetry={loadList} what="vault courses" />
      ) : !courses ? (
        <Card padded={false}><SkeletonRow /><SkeletonRow /><SkeletonRow /></Card>
      ) : visible.length === 0 ? (
        <EmptyState
          icon="book-outline"
          title={list.length === 0 ? 'No courses yet' : 'No courses match'}
          actionLabel={list.length === 0 ? 'Create your first course' : 'Clear filters'}
          onAction={list.length === 0 ? () => setEditing('new') : () => { setFilter('all'); setSearch(''); }}
          compact
        />
      ) : (
        <View style={{ gap: SPACE.sm }}>
          {visible.map((c) => (
            <Card key={c.id} padded onPress={() => setOpenId(c.id)} accessibilityLabel={`Open course ${c.title}`}>
              <View style={styles.courseRow}>
                {c.coverImage ? (
                  <Image source={{ uri: c.coverImage }} style={styles.thumb} />
                ) : (
                  <View style={[styles.thumb, styles.thumbEmpty, { borderColor: colors.border }]}>
                    <Ionicons name="book-outline" size={22} color={colors.primary} />
                  </View>
                )}
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={[type.h3, { color: colors.text }]} numberOfLines={1}>{c.title}</Text>
                  <Text style={[type.small, { color: colors.textSecondary }]} numberOfLines={2}>{c.description || 'No description'}</Text>
                  <Text style={[type.monoSmall, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>
                    {c.modules.length} modules · {c.enrollmentCount} enrolled · {c.completionRate}% done
                  </Text>
                  <View style={styles.chips}>
                    <StatusChip status={c.status} size="sm" />
                    <Chip label={c.tier} size="sm" tone="primary" />
                  </View>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}

      <CourseSheet
        ctx={ctx}
        mode={editing === 'new' ? 'new' : null}
        course={null}
        onClose={() => setEditing(null)}
        onSaved={async (created) => { setEditing(null); await loadList(); if (created?.id) setOpenId(String(created.id)); }}
      />
    </View>
  );
}

// ── Course create / edit ─────────────────────────────────────

function CourseSheet({ ctx, mode, course, onClose, onSaved }) {
  const [form, setForm] = useState(courseForm(null));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode) setForm(courseForm(mode === 'edit' ? course : null));
  }, [mode, course?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const isEdit = mode === 'edit' && course;
  const save = async () => {
    setBusy(true);
    try {
      if (isEdit) {
        await ctx.sendReq('vault.courses.update', buildCourseParams(form, course.id));
        ctx.notify('Course saved');
        await onSaved(null);
      } else {
        const res = await ctx.sendReq('vault.courses.create', buildCourseParams(form));
        ctx.notify('Course created');
        await onSaved(res?.course || null);
      }
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet
      visible={Boolean(mode)}
      onClose={onClose}
      title={isEdit ? 'Edit course' : 'New course'}
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title={isEdit ? 'Save changes' : 'Create course'} onPress={save} loading={busy} disabled={!form.title.trim()} />
        </View>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <Field label="Title" value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder="Course title..." required />
        <Field label="Description" value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} placeholder="Course description..." multiline rows={4} />
        <OptionChips label="Tier" options={COURSE_TIERS.map((t) => ({ key: t, label: titleCase(t) }))} value={form.tier} onChange={(v) => v && setForm({ ...form, tier: v })} />
        <Field label="Cover image URL" value={form.coverImage} onChangeText={(v) => setForm({ ...form, coverImage: v })} placeholder="https://..." keyboardType="url" autoCapitalize="none" mono />
      </View>
    </BottomSheet>
  );
}

// ── Module editor ────────────────────────────────────────────

function ModuleSheet({ ctx, mod, onClose, reload, onOpenLesson }) {
  const { colors, type } = useUIKit();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    if (mod) {
      setTitle(mod.title);
      setDescription(mod.description || '');
    }
  }, [mod?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mod) return null;
  const dirty = title !== mod.title || description !== (mod.description || '');

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      if (ok) ctx.notify(ok);
      return true;
    } catch (e) {
      ctx.fail(e);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const save = () => run('save', async () => { await ctx.sendReq('vault.modules.update', buildModuleUpdate(mod, { title, description })); await reload(); }, 'Module saved');
  const remove = async () => {
    const ok = await ctx.dialogs.confirm({ title: 'Delete this module?', message: 'Deletes the module and all its lessons.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    if (await run('delete', () => ctx.sendReq('vault.modules.delete', { moduleId: mod.id }), 'Module deleted')) {
      onClose();
      reload();
    }
  };
  const addLesson = async () => {
    const t = await ctx.dialogs.prompt({ title: 'New lesson', placeholder: 'Lesson title', required: true, confirmLabel: 'Add' });
    if (!t || !t.trim()) return;
    run('addLesson', async () => {
      const res = await ctx.sendReq('vault.lessons.create', buildLessonCreate(mod.id, t, mod.lessons.length));
      const c = await reload();
      const created = unwrap(res, 'lesson');
      const l = c?.modules.find((x) => x.id === mod.id)?.lessons.find((x) => x.id === String(created?.id));
      if (l) onOpenLesson(l);
    }, 'Lesson added');
  };

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={`Module: ${mod.title}`}
      subtitle={`${mod.lessons.length} lessons`}
      footer={
        <View style={styles.footer}>
          <Button title="Delete" icon="trash-outline" variant="danger" size="sm" loading={busy === 'delete'} onPress={remove} />
          <Button title="Add lesson" icon="add" variant="secondary" size="sm" loading={busy === 'addLesson'} onPress={addLesson} />
          <Button title="Save" size="sm" loading={busy === 'save'} disabled={!dirty || !title.trim()} onPress={save} />
        </View>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <Field label="Module title" value={title} onChangeText={setTitle} required />
        <Field label="Description" value={description} onChangeText={setDescription} placeholder="Module description..." multiline rows={3} />
        <Text style={[type.label, { color: colors.textSecondary }]}>Lessons ({mod.lessons.length})</Text>
        {mod.lessons.length === 0 ? (
          <Text style={[type.small, { color: colors.textMuted }]}>No lessons yet. Tap Add lesson to create one.</Text>
        ) : (
          mod.lessons.map((l) => (
            <ListRow key={l.id} dense icon={lessonIcon(l.contentType)} title={l.title} value={l.contentType} onPress={() => onOpenLesson(l)} accessibilityLabel={`Edit lesson ${l.title}`} />
          ))
        )}
      </View>
    </BottomSheet>
  );
}

// ── Lesson editor ────────────────────────────────────────────

function LessonSheet({ ctx, lesson, onClose, reload }) {
  const [form, setForm] = useState({ title: '', contentType: 'text', content: '', videoUrl: '', duration: '' });
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    if (lesson) {
      setForm({
        title: lesson.title,
        contentType: lesson.contentType || 'text',
        content: lesson.content || '',
        videoUrl: lesson.videoUrl || '',
        duration: lesson.duration ? String(lesson.duration) : '',
      });
    }
  }, [lesson?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!lesson) return null;

  const save = async () => {
    setBusy('save');
    try {
      await ctx.sendReq('vault.lessons.update', buildLessonUpdate(lesson, form));
      ctx.notify('Lesson saved');
      await reload();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    const ok = await ctx.dialogs.confirm({ title: 'Delete this lesson?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    setBusy('delete');
    try {
      await ctx.sendReq('vault.lessons.delete', { lessonId: lesson.id });
      ctx.notify('Lesson deleted');
      onClose();
      reload();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={lesson.title}
      subtitle={`${titleCase(form.contentType)} lesson`}
      maxHeightRatio={0.92}
      footer={
        <View style={styles.footer}>
          <Button title="Delete" icon="trash-outline" variant="danger" size="sm" loading={busy === 'delete'} onPress={remove} />
          <Button title="Save lesson" size="sm" loading={busy === 'save'} disabled={!form.title.trim()} onPress={save} />
        </View>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <Field label="Lesson title" value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} required />
        <OptionChips label="Content type" options={LESSON_TYPES} value={form.contentType} onChange={(v) => v && setForm({ ...form, contentType: v })} />
        {form.contentType === 'video' ? (
          <>
            <Field label="Video URL" value={form.videoUrl} onChangeText={(v) => setForm({ ...form, videoUrl: v })} placeholder="https://youtube.com/watch?v=..." keyboardType="url" autoCapitalize="none" mono />
            <Field label="Duration (minutes)" value={form.duration} onChangeText={(v) => setForm({ ...form, duration: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" mono />
          </>
        ) : null}
        <Field label="Content" value={form.content} onChangeText={(v) => setForm({ ...form, content: v })} placeholder="Write your lesson content here... (Markdown supported)" multiline rows={10} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  courseRow: { flexDirection: 'row', gap: SPACE.md },
  thumb: { width: 64, height: 64, borderRadius: RADIUS.md },
  thumbEmpty: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cover: { width: '100%', height: 140, borderRadius: RADIUS.md },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm, flexWrap: 'wrap' },
});

export default VaultCourses;
