/**
 * Vault Courses View — Course list, builder, module/lesson editor
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { g8GlassStyles } from "./glass-g8.js";
import type { VaultState, VaultCourse, VaultModule, VaultLesson } from "../controllers/vault";
import {
  loadCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  publishCourse,
  archiveCourse,
  createModule,
  updateModule,
  deleteModule,
  createLesson,
  updateLesson,
  deleteLesson,
} from "../controllers/vault";

// ── Styles ───────────────────────────────────────────────────

const S = {
  container: "display:flex;flex-direction:column;gap:1rem;",
  header: "display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;",
  
  // Course cards
  courseGrid: "display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem;",
  courseCard: "background:#111;border:1px solid #222;border-radius:12px;overflow:hidden;cursor:pointer;transition:all 0.15s;",
  courseCardActive: "background:#111;border:1px solid var(--g-primary);border-radius:12px;overflow:hidden;cursor:pointer;",
  courseCover: "height:120px;background:linear-gradient(135deg,#1a1a0a 0%,#2a2a1a 100%);display:flex;align-items:center;justify-content:center;",
  courseCoverImg: "width:100%;height:120px;object-fit:cover;",
  courseBody: "padding:1rem;",
  courseTitle: "font-size:1rem;font-weight:700;color:#e5e5e5;margin-bottom:0.3rem;",
  courseDesc: "font-size:0.82rem;color:#888;line-height:1.4;margin-bottom:0.6rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;",
  courseMeta: "display:flex;justify-content:space-between;align-items:center;",
  courseStats: "display:flex;gap:0.75rem;font-size:0.75rem;color:#666;",
  courseStatus: (status: string) => {
    const colors: Record<string, string> = {
      draft: '#666',
      published: '#22c55e',
      archived: '#ef4444',
    };
    return `background:${colors[status] || '#666'}20;color:${colors[status] || '#666'};font-size:0.65rem;padding:0.15rem 0.4rem;border-radius:4px;font-weight:600;text-transform:uppercase;`;
  },
  courseTier: "background:var(--g-primary);color:#000;font-size:0.65rem;padding:0.15rem 0.4rem;border-radius:4px;font-weight:600;",
  
  // Course editor
  editorContainer: "display:grid;grid-template-columns:280px 1fr;gap:1rem;height:calc(100vh - 280px);min-height:500px;",
  editorSidebar: "background:#111;border:1px solid #222;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;",
  editorMain: "background:#111;border:1px solid #222;border-radius:10px;padding:1.25rem;overflow-y:auto;",
  
  // Module list
  moduleList: "flex:1;overflow-y:auto;",
  moduleItem: (active: boolean) => `padding:0.6rem 1rem;cursor:pointer;border-left:3px solid ${active ? 'var(--g-primary)' : 'transparent'};background:${active ? '#1a1a0a' : 'transparent'};transition:all 0.15s;`,
  moduleTitle: "font-size:0.88rem;font-weight:600;color:#e5e5e5;margin-bottom:0.2rem;",
  moduleMeta: "font-size:0.72rem;color:#666;",
  lessonItem: (active: boolean) => `padding:0.4rem 1rem 0.4rem 1.5rem;cursor:pointer;background:${active ? '#1a1a0a' : 'transparent'};font-size:0.82rem;color:${active ? 'var(--g-primary)' : '#888'};border-left:2px solid ${active ? 'var(--g-primary)' : '#222'};`,
  
  // Add buttons
  addButton: "display:flex;align-items:center;gap:0.4rem;padding:0.6rem 1rem;color:var(--g-primary);font-size:0.82rem;cursor:pointer;border-top:1px solid #222;background:#0a0a0a;",
  
  // Forms
  formGroup: "margin-bottom:1rem;",
  input: "background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:0.5rem 0.75rem;color:#e5e5e5;font-size:0.9rem;width:100%;box-sizing:border-box;font-family:inherit;outline:none;",
  textarea: "background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:0.5rem 0.75rem;color:#e5e5e5;font-size:0.9rem;width:100%;box-sizing:border-box;font-family:inherit;min-height:100px;resize:vertical;outline:none;line-height:1.5;",
  contentEditor: "background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:0.75rem;color:#e5e5e5;font-size:0.9rem;width:100%;box-sizing:border-box;font-family:inherit;min-height:300px;resize:vertical;outline:none;line-height:1.6;",
  select: "background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:0.5rem 0.75rem;color:#e5e5e5;font-size:0.9rem;font-family:inherit;outline:none;cursor:pointer;",
  label: "display:block;font-size:0.72rem;color:#666;margin-bottom:0.3rem;text-transform:uppercase;letter-spacing:0.05em;",
  
  // Buttons
  primaryBtn: "background:var(--g-primary);color:#000;border:none;border-radius:6px;padding:0.45rem 1rem;cursor:pointer;font-weight:600;font-size:0.85rem;font-family:inherit;transition:all 0.15s;",
  secondaryBtn: "background:#1a1a1a;color:var(--g-primary);border:1px solid #333;border-radius:6px;padding:0.4rem 0.8rem;cursor:pointer;font-size:0.82rem;font-family:inherit;",
  dangerBtn: "background:#1a0a0a;color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:0.4rem 0.8rem;cursor:pointer;font-size:0.82rem;font-family:inherit;",
  successBtn: "background:#0a1a0a;color:#22c55e;border:1px solid #22c55e;border-radius:6px;padding:0.4rem 0.8rem;cursor:pointer;font-size:0.82rem;font-family:inherit;",
  
  // Messages
  empty: "color:#555;font-size:0.9rem;text-align:center;padding:3rem 1rem;",
  loading: "color:#666;font-size:0.85rem;text-align:center;padding:2rem;",

  // ── Control Deck ─────────────────────────────────────────
  controlDeck: "position:relative;overflow:hidden;border-radius:14px;padding:1.5rem;background:radial-gradient(ellipse at top left,color-mix(in srgb,var(--vault-accent,var(--g-primary)) 12%,transparent) 0%,transparent 60%),linear-gradient(135deg,color-mix(in srgb,var(--g-primary) 6%,transparent) 0%,color-mix(in srgb,var(--vault-accent,var(--g-primary)) 3%,transparent) 100%);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);box-shadow:0 20px 60px -20px color-mix(in srgb,var(--vault-accent,var(--g-primary)) 30%,transparent),0 0 0 1px color-mix(in srgb,var(--vault-accent,var(--g-primary)) 15%,transparent),inset 0 1px 0 color-mix(in srgb,white 8%,transparent);animation:vault-deck-in 0.4s ease both;",
  deckGlow: "position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--vault-accent,var(--g-primary)) 70%,white),transparent);pointer-events:none;",
  deckHero: "display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;",
  deckTitle: "font-size:1.35rem;font-weight:800;color:var(--vault-text,#e4e4e7);letter-spacing:-0.02em;display:flex;align-items:center;gap:0.4rem;",
  deckSub: "font-size:0.68rem;color:var(--vault-text-dim,#71717a);text-transform:uppercase;letter-spacing:0.12em;margin-top:0.25rem;",
  deckActions: "display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;",
  deckSearchWrap: "display:flex;align-items:center;gap:0.35rem;background:color-mix(in srgb,var(--g-primary) 4%,transparent);border:1px solid color-mix(in srgb,var(--vault-accent,var(--g-primary)) 18%,transparent);border-radius:6px;padding:0.3rem 0.55rem;",
  deckSearchInput: "background:none;border:none;outline:none;color:var(--vault-text,#e4e4e7);font-size:0.82rem;font-family:inherit;width:150px;",
  deckPrimaryBtn: "background:var(--vault-accent,var(--g-primary));color:#000;border:none;border-radius:6px;padding:0.4rem 0.85rem;cursor:pointer;font-weight:700;font-size:0.8rem;font-family:inherit;letter-spacing:0.02em;transition:opacity 0.15s;white-space:nowrap;",
  deckSecondaryBtn: "background:color-mix(in srgb,var(--g-primary) 7%,transparent);border:1px solid color-mix(in srgb,var(--vault-accent,var(--g-primary)) 22%,transparent);color:var(--vault-accent,var(--g-primary));border-radius:6px;padding:0.38rem 0.65rem;cursor:pointer;font-size:0.88rem;font-family:inherit;transition:all 0.15s;",
  statStrip: "display:flex;gap:0;border-top:1px solid color-mix(in srgb,var(--vault-accent,var(--g-primary)) 10%,transparent);border-bottom:1px solid color-mix(in srgb,var(--vault-accent,var(--g-primary)) 10%,transparent);margin-bottom:0.9rem;overflow-x:auto;scrollbar-width:none;",
  statCell: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.12rem;padding:0.55rem 1.1rem;border-right:1px solid color-mix(in srgb,var(--vault-accent,var(--g-primary)) 10%,transparent);min-width:72px;flex-shrink:0;",
  statValue: (color: string) => `font-size:1.3rem;font-weight:700;color:${color};font-family:var(--vault-mono,'JetBrains Mono',monospace);line-height:1;`,
  statBar: (pct: number, color: string) => `width:${Math.max(2, Math.round(pct * 40))}px;height:3px;background:${color};border-radius:2px;margin-top:0.1rem;transition:width 0.4s ease;`,
  statLabel: "font-size:0.6rem;color:var(--vault-text-dim,#71717a);text-transform:uppercase;letter-spacing:0.1em;",
  filterRow: "display:flex;gap:0.35rem;flex-wrap:wrap;",
  filterChip: (active: boolean) => `background:${active ? 'var(--vault-accent,var(--g-primary))' : 'color-mix(in srgb,var(--g-primary) 5%,transparent)'};color:${active ? '#000' : 'var(--vault-text-dim,#71717a)'};border:1px solid ${active ? 'var(--vault-accent,var(--g-primary))' : 'color-mix(in srgb,var(--vault-accent,var(--g-primary)) 15%,transparent)'};border-radius:20px;padding:0.22rem 0.7rem;cursor:pointer;font-size:0.73rem;font-family:inherit;font-weight:${active ? '700' : '500'};transition:all 0.15s;white-space:nowrap;`,

  // Modal
  modalOverlay: "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:1000;",
  modal: "background:#111;border:1px solid #333;border-radius:12px;padding:1.5rem;max-width:500px;width:90%;max-height:80vh;overflow-y:auto;",
  modalHeader: "display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;",
  modalTitle: "font-size:1.1rem;font-weight:700;color:var(--g-primary);",
  modalClose: "background:none;border:none;color:#666;font-size:1.2rem;cursor:pointer;",
  
  // Content type icons
  contentTypeIcon: (type: string) => {
    const icons: Record<string, string> = {
      text: '📝',
      video: '🎬',
      quiz: '❓',
      assignment: '📋',
    };
    return icons[type] || '📄';
  },
};

// ── Control Deck Keyframes ───────────────────────────────────

const controlDeckStyles = html`<style>
  @keyframes vault-deck-in {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes vault-stat-in {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .vault-stat-in { animation: vault-stat-in 0.45s ease both; }
  .vault-stat-d1 { animation-delay: 0.05s; }
  .vault-stat-d2 { animation-delay: 0.10s; }
  .vault-stat-d3 { animation-delay: 0.15s; }
  .vault-stat-d4 { animation-delay: 0.20s; }
  .vault-stat-d5 { animation-delay: 0.25s; }
  @media (prefers-reduced-motion: reduce) {
    .vault-courses-deck { animation: none !important; }
    .vault-stat-in { animation: none !important; }
  }
  @media (max-width: 640px) {
    .vault-deck-hero { flex-direction: column !important; }
    .vault-deck-hero > div:last-child { width: 100%; }
    .vault-deck-actions { flex-wrap: wrap; }
    .vault-deck-search { flex: 1 1 100%; min-width: 0; box-sizing: border-box; }
    .vault-deck-search input { width: 100% !important; min-width: 0; }
    .vault-deck-stats { width: 100%; max-width: 100%; }
  }
</style>`;

// ── State Extension ──────────────────────────────────────────

interface CourseEditorState {
  selectedModuleId: string | null;
  selectedLessonId: string | null;
  editingCourse: boolean;
  editingModule: boolean;
  editingLesson: boolean;
}

// ── Render Functions ─────────────────────────────────────────

function renderCoursesList(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  const courses = Array.isArray(vs.courses) ? vs.courses : [];

  if (courses.length === 0 && !vs.loading) {
    vs.loading = true;
    loadCourses(gw)
      .then(loadedCourses => {
        vs.courses = Array.isArray(loadedCourses) ? loadedCourses : [];
        vs.loading = false;
        state.requestUpdate?.();
      })
      .catch(err => {
        console.warn("[vault-courses] Failed to load courses:", err);
        vs.courses = [];
        vs.loading = false;
        state.requestUpdate?.();
      });
  }

  const filter: string = (vs as any).courseFilter ?? 'all';
  const searchTerm: string = (vs as any).courseSearch ?? '';

  const published = courses.filter(c => c.status === 'published').length;
  const drafts = courses.filter(c => c.status === 'draft').length;
  const archived = courses.filter(c => c.status === 'archived').length;
  const totalEnrollments = courses.reduce((sum, c) => sum + (c.enrollmentCount || 0), 0);

  let visible = courses;
  if (filter !== 'all') visible = visible.filter(c => c.status === filter);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    visible = visible.filter(c =>
      c.title.toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q)
    );
  }

  return html`
    ${g8GlassStyles}
    <div class="g8-page vault-courses" style=${S.container}>
      ${controlDeckStyles}
      ${renderControlDeck(vs, state, gw, courses, filter, searchTerm, published, drafts, archived, totalEnrollments)}

      ${vs.loading ? html`<div style=${S.loading}>Loading courses…</div>` : nothing}

      ${!vs.loading && visible.length === 0
        ? html`
            <div style=${S.empty}>
              <div style="font-size:2rem;margin-bottom:0.5rem;">📚</div>
              <div>${courses.length === 0 ? 'No courses yet' : 'No courses match'}</div>
              ${courses.length === 0 ? html`
                <button style="${S.primaryBtn};margin-top:1rem;" @click=${() => {
                  vs.showCourseModal = true;
                  vs.courseForm = { title: '', description: '', tier: 'free', status: 'draft', modules: [] };
                  state.requestUpdate?.();
                }}>Create Your First Course</button>
              ` : nothing}
            </div>
          `
        : html`
            <div style=${S.courseGrid}>
              ${visible.map(c => renderCourseCard(c, vs, state))}
            </div>
          `
      }

      ${renderCourseModal(vs, state, gw)}
    </div>
  `;
}

function renderControlDeck(
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient,
  courses: VaultCourse[],
  filter: string,
  searchTerm: string,
  published: number,
  drafts: number,
  archived: number,
  totalEnrollments: number,
) {
  return html`
    <div class="vault-courses-deck" style=${S.controlDeck}>
      <div style=${S.deckGlow}></div>

      <div class="vault-deck-hero" style=${S.deckHero}>
        <div>
          <div style=${S.deckTitle}>
            <span style="color:var(--vault-accent,var(--g-primary));font-size:0.8rem;">◆</span>
            Courses
          </div>
          <div style=${S.deckSub}>Content library &amp; learning modules</div>
        </div>
        <div class="vault-deck-actions" style=${S.deckActions}>
          <div class="vault-deck-search" style=${S.deckSearchWrap}>
            <span style="color:var(--vault-text-dim,#71717a);font-size:0.82rem;">⌕</span>
            <input
              style=${S.deckSearchInput}
              placeholder="Search courses..."
              .value=${searchTerm}
              @input=${(e: Event) => {
                (vs as any).courseSearch = (e.target as HTMLInputElement).value;
                state.requestUpdate?.();
              }}
            />
          </div>
          <button style=${S.deckSecondaryBtn} @click=${async () => {
            vs.courses = await loadCourses(gw);
            state.requestUpdate?.();
          }}>↺</button>
          <button style=${S.deckPrimaryBtn} @click=${() => {
            vs.showCourseModal = true;
            vs.courseForm = { title: '', description: '', tier: 'free', status: 'draft', modules: [] };
            state.requestUpdate?.();
          }}>+ New Course</button>
        </div>
      </div>

      <div class="vault-deck-stats" style=${S.statStrip}>
        ${renderDeckStat('Total', courses.length, 'var(--vault-accent,var(--g-primary))', 1, 'vault-stat-d1')}
        ${renderDeckStat('Published', published, '#22c55e', published / Math.max(1, courses.length), 'vault-stat-d2')}
        ${renderDeckStat('Drafts', drafts, 'var(--vault-text-dim,#a8a8b3)', drafts / Math.max(1, courses.length), 'vault-stat-d3')}
        ${renderDeckStat('Archived', archived, '#ef4444', archived / Math.max(1, courses.length), 'vault-stat-d4')}
        ${renderDeckStat('Enrollments', totalEnrollments, 'var(--vault-accent,var(--g-primary))', Math.min(1, totalEnrollments / Math.max(1, courses.length * 10)), 'vault-stat-d5')}
      </div>

      <div style=${S.filterRow}>
        ${(['all', 'published', 'draft', 'archived'] as const).map(f => html`
          <button
            style=${S.filterChip(f === filter)}
            @click=${() => {
              (vs as any).courseFilter = f;
              state.requestUpdate?.();
            }}
          >${f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}</button>
        `)}
      </div>
    </div>
  `;
}

function renderDeckStat(label: string, value: number, color: string, pct: number, delayClass: string) {
  return html`
    <div style=${S.statCell}>
      <span class="vault-stat-in ${delayClass}" style=${S.statValue(color)}>${value}</span>
      <div style=${S.statBar(pct, color)}></div>
      <span style=${S.statLabel}>${label}</span>
    </div>
  `;
}

function renderCourseCard(course: VaultCourse, vs: VaultState, state: AppViewState) {
  const isSelected = vs.selectedCourse?.id === course.id;
  
  return html`
    <div 
      style=${isSelected ? S.courseCardActive : S.courseCard}
      @click=${() => {
        vs.selectedCourse = course;
        state.requestUpdate?.();
      }}
    >
      <div style=${S.courseCover}>
        ${course.coverImage 
          ? html`<img src=${course.coverImage} alt=${course.title} style=${S.courseCoverImg} />`
          : html`<span style="font-size:3rem;">📚</span>`
        }
      </div>
      <div style=${S.courseBody}>
        <div style=${S.courseTitle}>${course.title}</div>
        <div style=${S.courseDesc}>${course.description || 'No description'}</div>
        <div style=${S.courseMeta}>
          <div style=${S.courseStats}>
            <span>📖 ${course.modules.length} modules</span>
            <span>👥 ${course.enrollmentCount}</span>
            <span>✅ ${course.completionRate}%</span>
          </div>
          <div style="display:flex;gap:0.3rem;">
            <span style=${S.courseStatus(course.status)}>${course.status}</span>
            <span style=${S.courseTier}>${course.tier}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCourseEditor(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  const course = vs.selectedCourse;
  if (!course) return nothing;
  
  // Track editor state in vaultState
  const editorState = (vs as any).courseEditorState as CourseEditorState || {
    selectedModuleId: null,
    selectedLessonId: null,
    editingCourse: false,
    editingModule: false,
    editingLesson: false,
  };
  (vs as any).courseEditorState = editorState;
  
  const selectedModule = course.modules.find(m => m.id === editorState.selectedModuleId);
  const selectedLesson = selectedModule?.lessons.find(l => l.id === editorState.selectedLessonId);
  
  return html`
    ${g8GlassStyles}
    <div class="g8-page vault-course-editor" style=${S.container}>
      <div style=${S.header}>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <button style=${S.secondaryBtn} @click=${() => {
            vs.selectedCourse = null;
            state.requestUpdate?.();
          }}>← Back</button>
          <span style="color:var(--g-primary);font-weight:700;font-size:1.1rem;">${course.title}</span>
          <span style=${S.courseStatus(course.status)}>${course.status}</span>
        </div>
        <div style="display:flex;gap:0.5rem;">
          ${course.status === 'draft' ? html`
            <button style=${S.successBtn} @click=${async () => {
              await publishCourse(gw, course.id);
              course.status = 'published';
              state.requestUpdate?.();
            }}>🚀 Publish</button>
          ` : course.status === 'published' ? html`
            <button style=${S.dangerBtn} @click=${async () => {
              await archiveCourse(gw, course.id);
              course.status = 'archived';
              state.requestUpdate?.();
            }}>📦 Archive</button>
          ` : nothing}
          <button style=${S.secondaryBtn} @click=${() => {
            editorState.editingCourse = true;
            vs.courseForm = { ...course };
            state.requestUpdate?.();
          }}>✏️ Edit</button>
          <button style=${S.dangerBtn} @click=${async () => {
            if (confirm('Delete this course? This cannot be undone.')) {
              await deleteCourse(gw, course.id);
              vs.selectedCourse = null;
              vs.courses = await loadCourses(gw);
              state.requestUpdate?.();
            }
          }}>🗑️</button>
        </div>
      </div>
      
      <div style=${S.editorContainer}>
        <!-- Sidebar: Modules & Lessons -->
        <div style=${S.editorSidebar}>
          <div style="padding:0.75rem 1rem;border-bottom:1px solid #222;">
            <span style="font-size:0.85rem;font-weight:600;color:#e5e5e5;">Structure</span>
          </div>
          <div style=${S.moduleList}>
            ${course.modules.length === 0 
              ? html`<div style="padding:1rem;color:#555;font-size:0.82rem;text-align:center;">No modules yet</div>`
              : course.modules.map(m => html`
                  <div 
                    style=${S.moduleItem(editorState.selectedModuleId === m.id)}
                    @click=${() => {
                      editorState.selectedModuleId = m.id;
                      editorState.selectedLessonId = null;
                      state.requestUpdate?.();
                    }}
                  >
                    <div style=${S.moduleTitle}>${m.title}</div>
                    <div style=${S.moduleMeta}>${m.lessons.length} lessons</div>
                  </div>
                  ${editorState.selectedModuleId === m.id ? m.lessons.map(l => html`
                    <div 
                      style=${S.lessonItem(editorState.selectedLessonId === l.id)}
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        editorState.selectedLessonId = l.id;
                        state.requestUpdate?.();
                      }}
                    >
                      ${S.contentTypeIcon(l.contentType)} ${l.title}
                    </div>
                  `) : nothing}
                `)
            }
          </div>
          <div style=${S.addButton} @click=${async () => {
            const title = prompt('Module title:');
            if (title) {
              const module = await createModule(gw, course.id, { title, order: course.modules.length });
              course.modules.push(module);
              editorState.selectedModuleId = module.id;
              state.requestUpdate?.();
            }
          }}>
            <span>➕</span> Add Module
          </div>
        </div>
        
        <!-- Main: Content Editor -->
        <div style=${S.editorMain}>
          ${selectedLesson 
            ? renderLessonEditor(selectedLesson, selectedModule!, course, vs, state, gw, editorState)
            : selectedModule 
              ? renderModuleEditor(selectedModule, course, vs, state, gw, editorState)
              : renderCourseDetails(course, vs, state)
          }
        </div>
      </div>
      
      ${editorState.editingCourse ? renderCourseModal(vs, state, gw) : nothing}
    </div>
  `;
}

function renderCourseDetails(course: VaultCourse, vs: VaultState, state: AppViewState) {
  return html`
    <div>
      <h3 style="color:var(--g-primary);margin:0 0 1rem 0;">Course Overview</h3>
      <div style="margin-bottom:1rem;">
        <label style=${S.label}>Description</label>
        <p style="color:#999;font-size:0.9rem;line-height:1.5;">${course.description || 'No description provided.'}</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1rem;">
        <div style="background:#0a0a0a;padding:1rem;border-radius:8px;text-align:center;">
          <div style="font-size:1.5rem;font-weight:700;color:var(--g-primary);">${course.modules.length}</div>
          <div style="font-size:0.75rem;color:#666;">Modules</div>
        </div>
        <div style="background:#0a0a0a;padding:1rem;border-radius:8px;text-align:center;">
          <div style="font-size:1.5rem;font-weight:700;color:var(--g-primary);">${course.enrollmentCount}</div>
          <div style="font-size:0.75rem;color:#666;">Enrolled</div>
        </div>
        <div style="background:#0a0a0a;padding:1rem;border-radius:8px;text-align:center;">
          <div style="font-size:1.5rem;font-weight:700;color:var(--g-primary);">${course.completionRate}%</div>
          <div style="font-size:0.75rem;color:#666;">Completion</div>
        </div>
      </div>
      <p style="color:#555;font-size:0.82rem;">Select a module from the sidebar to edit its content, or add a new module to get started.</p>
    </div>
  `;
}

function renderModuleEditor(
  module: VaultModule, 
  course: VaultCourse, 
  vs: VaultState, 
  state: AppViewState, 
  gw: GatewayBrowserClient,
  editorState: CourseEditorState
) {
  return html`
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h3 style="color:var(--g-primary);margin:0;">Module: ${module.title}</h3>
        <div style="display:flex;gap:0.5rem;">
          <button style=${S.secondaryBtn} @click=${async () => {
            const title = prompt('New lesson title:');
            if (title) {
              const lesson = await createLesson(gw, module.id, { 
                title, 
                contentType: 'text', 
                content: '',
                order: module.lessons.length 
              });
              module.lessons.push(lesson);
              editorState.selectedLessonId = lesson.id;
              state.requestUpdate?.();
            }
          }}>+ Add Lesson</button>
          <button style=${S.dangerBtn} @click=${async () => {
            if (confirm('Delete this module and all its lessons?')) {
              await deleteModule(gw, module.id);
              course.modules = course.modules.filter(m => m.id !== module.id);
              editorState.selectedModuleId = null;
              state.requestUpdate?.();
            }
          }}>🗑️ Delete</button>
        </div>
      </div>
      
      <div style=${S.formGroup}>
        <label style=${S.label}>Module Title</label>
        <input 
          style=${S.input}
          .value=${module.title}
          @blur=${async (e: Event) => {
            const title = (e.target as HTMLInputElement).value;
            if (title !== module.title) {
              await updateModule(gw, module.id, { title });
              module.title = title;
              state.requestUpdate?.();
            }
          }}
        />
      </div>
      
      <div style=${S.formGroup}>
        <label style=${S.label}>Description</label>
        <textarea 
          style=${S.textarea}
          .value=${module.description || ''}
          @blur=${async (e: Event) => {
            const description = (e.target as HTMLTextAreaElement).value;
            if (description !== module.description) {
              await updateModule(gw, module.id, { description });
              module.description = description;
            }
          }}
          placeholder="Module description..."
        ></textarea>
      </div>
      
      <div style="margin-top:1rem;">
        <label style=${S.label}>Lessons (${module.lessons.length})</label>
        ${module.lessons.length === 0 
          ? html`<p style="color:#555;font-size:0.85rem;">No lessons yet. Click "Add Lesson" to create one.</p>`
          : html`
              <div style="display:flex;flex-direction:column;gap:0.5rem;">
                ${module.lessons.map(l => html`
                  <div 
                    style="display:flex;justify-content:space-between;align-items:center;background:#0a0a0a;padding:0.6rem 0.8rem;border-radius:6px;cursor:pointer;"
                    @click=${() => {
                      editorState.selectedLessonId = l.id;
                      state.requestUpdate?.();
                    }}
                  >
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                      <span>${S.contentTypeIcon(l.contentType)}</span>
                      <span style="color:#e5e5e5;font-size:0.88rem;">${l.title}</span>
                    </div>
                    <span style="color:#666;font-size:0.75rem;">${l.contentType}</span>
                  </div>
                `)}
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderLessonEditor(
  lesson: VaultLesson,
  module: VaultModule,
  course: VaultCourse,
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient,
  editorState: CourseEditorState
) {
  return html`
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <button style=${S.secondaryBtn} @click=${() => {
            editorState.selectedLessonId = null;
            state.requestUpdate?.();
          }}>← Back</button>
          <h3 style="color:var(--g-primary);margin:0;">${S.contentTypeIcon(lesson.contentType)} ${lesson.title}</h3>
        </div>
        <button style=${S.dangerBtn} @click=${async () => {
          if (confirm('Delete this lesson?')) {
            await deleteLesson(gw, lesson.id);
            module.lessons = module.lessons.filter(l => l.id !== lesson.id);
            editorState.selectedLessonId = null;
            state.requestUpdate?.();
          }
        }}>🗑️ Delete</button>
      </div>
      
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;">
        <div style=${S.formGroup}>
          <label style=${S.label}>Lesson Title</label>
          <input 
            style=${S.input}
            .value=${lesson.title}
            @blur=${async (e: Event) => {
              const title = (e.target as HTMLInputElement).value;
              if (title !== lesson.title) {
                await updateLesson(gw, lesson.id, { title });
                lesson.title = title;
                state.requestUpdate?.();
              }
            }}
          />
        </div>
        
        <div style=${S.formGroup}>
          <label style=${S.label}>Content Type</label>
          <select 
            style=${S.select}
            .value=${lesson.contentType}
            @change=${async (e: Event) => {
              const contentType = (e.target as HTMLSelectElement).value as any;
              await updateLesson(gw, lesson.id, { contentType });
              lesson.contentType = contentType;
              state.requestUpdate?.();
            }}
          >
            <option value="text">📝 Text</option>
            <option value="video">🎬 Video</option>
            <option value="quiz">❓ Quiz</option>
            <option value="assignment">📋 Assignment</option>
          </select>
        </div>
      </div>
      
      ${lesson.contentType === 'video' ? html`
        <div style=${S.formGroup}>
          <label style=${S.label}>Video URL</label>
          <input 
            style=${S.input}
            type="url"
            placeholder="https://youtube.com/watch?v=..."
            .value=${lesson.videoUrl || ''}
            @blur=${async (e: Event) => {
              const videoUrl = (e.target as HTMLInputElement).value;
              if (videoUrl !== lesson.videoUrl) {
                await updateLesson(gw, lesson.id, { videoUrl });
                lesson.videoUrl = videoUrl;
              }
            }}
          />
        </div>
        <div style=${S.formGroup}>
          <label style=${S.label}>Duration (minutes)</label>
          <input 
            style=${S.input}
            type="number"
            min="0"
            .value=${String(lesson.duration || '')}
            @blur=${async (e: Event) => {
              const duration = parseInt((e.target as HTMLInputElement).value) || undefined;
              if (duration !== lesson.duration) {
                await updateLesson(gw, lesson.id, { duration });
                lesson.duration = duration;
              }
            }}
          />
        </div>
      ` : nothing}
      
      <div style=${S.formGroup}>
        <label style=${S.label}>Content</label>
        <textarea 
          style=${S.contentEditor}
          .value=${lesson.content || ''}
          @blur=${async (e: Event) => {
            const content = (e.target as HTMLTextAreaElement).value;
            if (content !== lesson.content) {
              await updateLesson(gw, lesson.id, { content });
              lesson.content = content;
            }
          }}
          placeholder="Write your lesson content here... (Markdown supported)"
        ></textarea>
      </div>
    </div>
  `;
}

function renderCourseModal(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  if (!vs.showCourseModal && !(vs as any).courseEditorState?.editingCourse) return nothing;
  
  const form = vs.courseForm as Partial<VaultCourse>;
  const isEditing = !!(vs as any).courseEditorState?.editingCourse || !!form.id;
  
  return html`
    <div style=${S.modalOverlay} @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        vs.showCourseModal = false;
        if ((vs as any).courseEditorState) {
          (vs as any).courseEditorState.editingCourse = false;
        }
        state.requestUpdate?.();
      }
    }}>
      <div style=${S.modal}>
        <div style=${S.modalHeader}>
          <span style=${S.modalTitle}>${isEditing ? '✏️ Edit Course' : '📚 New Course'}</span>
          <button style=${S.modalClose} @click=${() => { 
            vs.showCourseModal = false;
            if ((vs as any).courseEditorState) {
              (vs as any).courseEditorState.editingCourse = false;
            }
            state.requestUpdate?.(); 
          }}>✕</button>
        </div>
        
        <div style=${S.formGroup}>
          <label style=${S.label}>Title</label>
          <input 
            style=${S.input}
            .value=${form.title || ''}
            @input=${(e: Event) => { form.title = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
            placeholder="Course title..."
          />
        </div>
        
        <div style=${S.formGroup}>
          <label style=${S.label}>Description</label>
          <textarea 
            style=${S.textarea}
            .value=${form.description || ''}
            @input=${(e: Event) => { form.description = (e.target as HTMLTextAreaElement).value; state.requestUpdate?.(); }}
            placeholder="Course description..."
          ></textarea>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div style=${S.formGroup}>
            <label style=${S.label}>Tier</label>
            <select 
              style=${S.select}
              .value=${form.tier || 'free'}
              @change=${(e: Event) => { form.tier = (e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}
            >
              <option value="free">Free</option>
              <option value="basic">Basic</option>
              <option value="premium">Premium</option>
              <option value="vip">VIP</option>
            </select>
          </div>
          
          <div style=${S.formGroup}>
            <label style=${S.label}>Cover Image URL</label>
            <input 
              style=${S.input}
              type="url"
              .value=${form.coverImage || ''}
              @input=${(e: Event) => { form.coverImage = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
              placeholder="https://..."
            />
          </div>
        </div>
        
        <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem;">
          <button style=${S.secondaryBtn} @click=${() => { 
            vs.showCourseModal = false;
            if ((vs as any).courseEditorState) {
              (vs as any).courseEditorState.editingCourse = false;
            }
            state.requestUpdate?.(); 
          }}>Cancel</button>
          <button 
            style=${S.primaryBtn}
            ?disabled=${!form.title}
            @click=${async () => {
              if (isEditing && form.id) {
                await updateCourse(gw, form.id, form);
                if (vs.selectedCourse) {
                  Object.assign(vs.selectedCourse, form);
                }
              } else {
                const newCourse = await createCourse(gw, form);
                // Ensure courses is an array before pushing
                if (!Array.isArray(vs.courses)) {
                  vs.courses = [];
                }
                vs.courses.push(newCourse);
                vs.selectedCourse = newCourse;
              }
              vs.showCourseModal = false;
              if ((vs as any).courseEditorState) {
                (vs as any).courseEditorState.editingCourse = false;
              }
              state.requestUpdate?.();
            }}
          >
            ${isEditing ? 'Save Changes' : 'Create Course'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Main Export ──────────────────────────────────────────────

export function renderVaultCourses(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  if (vs.selectedCourse) {
    return renderCourseEditor(vs, state, gw);
  }
  return renderCoursesList(vs, state, gw);
}
