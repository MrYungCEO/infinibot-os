/**
 * Project picker + capture auto-association (pure logic).
 */
import {
  filterProjects,
  localMatchProject,
  normalizeProjects,
  pickerRows,
  projectPath,
  recordUsage,
  resolveAutoProject,
  suggestionLabel,
} from '../lib/project-picker-model';
import { assignItemProject } from '../lib/project-assign';

const RAW = [
  { id: 'ib', name: 'InfiniBot', updatedAt: 100 },
  { id: 'ib-gw', name: 'InfiniBot gateway stability', parentProjectId: 'ib', updatedAt: 300 },
  { id: 'kv', name: 'KinglyVault', description: 'Membership vault with CEO pricing', aliases: ['vault'], updatedAt: 200 },
  { id: 'fp', name: 'FlyPic', updatedAt: 50 },
  { id: 'arch', name: 'Archived thing', archived: true },
  { id: 'web', title: 'Company Website', updatedAt: 10 },
  { id: '', name: 'no id' },
];
const P = normalizeProjects(RAW);

describe('normalizeProjects', () => {
  it('keeps every live project with parent names, drops archived / id-less', () => {
    expect(P.map((p) => p.id)).toEqual(['ib', 'ib-gw', 'kv', 'fp', 'web']);
    expect(P.find((p) => p.id === 'ib-gw')).toMatchObject({ parentId: 'ib', parentName: 'InfiniBot' });
    expect(P.find((p) => p.id === 'web').name).toBe('Company Website');
    expect(projectPath(P[1])).toBe('InfiniBot › InfiniBot gateway stability');
    expect(normalizeProjects({ projects: RAW })).toHaveLength(5);
  });

  it('handles 1000+ projects (no 30-item cap)', () => {
    const many = normalizeProjects(Array.from({ length: 1100 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })));
    expect(many).toHaveLength(1100);
    expect(filterProjects(many, 'project 1099').map((p) => p.id)[0]).toBe('p1099');
  });
});

describe('filterProjects / pickerRows', () => {
  it('ranks prefix > word-start > substring > spacing variant > description', () => {
    expect(filterProjects(P, 'infini').map((p) => p.id)).toEqual(['ib', 'ib-gw']);
    expect(filterProjects(P, 'gateway').map((p) => p.id)).toEqual(['ib-gw']);
    expect(filterProjects(P, 'kingly vault').map((p) => p.id)).toEqual(['kv']);
    expect(filterProjects(P, 'vault')[0].id).toBe('kv'); // alias
    expect(filterProjects(P, 'pricing').map((p) => p.id)).toEqual(['kv']); // description
    expect(filterProjects(P, 'website').map((p) => p.id)).toEqual(['web']);
    expect(filterProjects(P, 'zzz')).toEqual([]);
  });

  it('sub-projects are found by their parent name too', () => {
    expect(filterProjects(P, 'infinibot stability').map((p) => p.id)).toEqual(['ib-gw']);
  });

  it('usage boosts matches and puts recent projects first when there is no query', () => {
    let usage = recordUsage({}, 'fp', 1000);
    usage = recordUsage(usage, 'fp', 2000);
    usage = recordUsage(usage, 'web', 1500);
    expect(usage.fp).toEqual({ count: 2, last: 2000 });
    expect(filterProjects(P, '', usage).map((p) => p.id)).toEqual(['fp', 'web', 'ib-gw', 'kv', 'ib']);
    const rows = pickerRows(P, '', usage);
    expect(rows[0]).toMatchObject({ type: 'header', title: 'Recent' });
    expect(rows.slice(1, 3).map((r) => r.project.id)).toEqual(['fp', 'web']);
    expect(rows[3]).toMatchObject({ type: 'header', title: 'All projects (5)' });
    expect(rows.filter((r) => r.type === 'project')).toHaveLength(5); // no duplicates
    const q = pickerRows(P, 'infini', usage);
    expect(q[0]).toMatchObject({ type: 'header', title: '2 matches' });
  });

  it('no usage → most recently active first', () => {
    expect(filterProjects(P, '').map((p) => p.id)).toEqual(['ib-gw', 'kv', 'ib', 'fp', 'web']);
    expect(pickerRows(P, '')[0]).toMatchObject({ title: 'All projects (5)' });
  });
});

describe('auto association', () => {
  it('preselects a confident gateway suggestion with an Auto chip', () => {
    const r = resolveAutoProject(
      { kind: 'task', projectId: 'kv', projectName: 'KinglyVault', projectSuggestion: { id: 'kv', name: 'KinglyVault', confidence: 0.96, reason: 'named it', source: 'ai', auto: true } },
      P,
    );
    expect(r).toMatchObject({ projectId: 'kv', autoSelected: true });
    expect(suggestionLabel(r.suggestion, { selected: true })).toBe('Auto: KinglyVault · named it');
  });

  it('a low-confidence suggestion is offered, not selected', () => {
    const r = resolveAutoProject({ kind: 'note', projectSuggestion: { id: 'fp', name: 'FlyPic', confidence: 0.35, reason: 'guess', source: 'ai', auto: false } }, P);
    expect(r.projectId).toBeUndefined();
    expect(r.suggestion).toMatchObject({ id: 'fp', auto: false });
    expect(suggestionLabel(r.suggestion)).toBe('Suggested: FlyPic · guess');
  });

  it('never selects an id missing from the project list', () => {
    const r = resolveAutoProject({ kind: 'idea', projectId: 'ghost', projectSuggestion: { id: 'ghost', name: 'Ghost', confidence: 0.99, auto: true }, transcript: 'nothing relevant' }, P);
    expect(r).toMatchObject({ projectId: undefined, suggestion: null });
  });

  it('old gateway (projectId, no suggestion) is treated as a confident match', () => {
    const r = resolveAutoProject({ kind: 'idea', projectId: 'fp', projectName: 'FlyPic' }, P);
    expect(r).toMatchObject({ projectId: 'fp', autoSelected: true });
  });

  it('falls back to on-device matching of the transcript', () => {
    expect(resolveAutoProject({ kind: 'task', transcript: 'fix the kingly vault checkout' }, P)).toMatchObject({ projectId: 'kv', autoSelected: true });
    expect(resolveAutoProject({ kind: 'note', transcript: 'buy milk' }, P)).toMatchObject({ projectId: undefined, suggestion: null });
    expect(resolveAutoProject({ kind: 'project', transcript: 'FlyPic v2' }, P).suggestion).toBeNull();
  });

  it('localMatchProject prefers the longest (sub-project) name', () => {
    expect(localMatchProject('infinibot gateway stability is flaky', P)).toMatchObject({ id: 'ib-gw', auto: true });
    expect(localMatchProject('the gateway stability on infinibot', P)?.id).toBe('ib-gw');
  });
});

describe('assignItemProject', () => {
  it('uses capture.assignProject when the gateway has it', async () => {
    const calls = [];
    const sendReq = async (m, p) => {
      calls.push([m, p]);
      return { kind: 'idea', id: 'i1', projectId: 'kv' };
    };
    await assignItemProject(sendReq, { kind: 'idea', id: 'i1', projectId: 'kv', previousProjectId: 'fp' });
    expect(calls).toEqual([['capture.assignProject', { kind: 'idea', id: 'i1', projectId: 'kv', previousProjectId: 'fp' }]]);
  });

  it('falls back to each store on an older gateway', async () => {
    const calls = [];
    const sendReq = async (m, p) => {
      calls.push([m, p]);
      if (m === 'capture.assignProject') throw new Error('unknown method: capture.assignProject');
      return {};
    };
    await assignItemProject(sendReq, { kind: 'idea', id: 'i1', projectId: null });
    await assignItemProject(sendReq, { kind: 'note', id: 'n1', projectId: null });
    await assignItemProject(sendReq, { kind: 'task', id: 't1', projectId: 'kv' });
    expect(calls.filter((c) => c[0] !== 'capture.assignProject')).toEqual([
      ['ideas.update', { id: 'i1', patch: { projectIds: [] } }],
      ['notes.update', { id: 'n1', projectId: '' }],
      ['kanban.tasks.update', { id: 't1', patch: { projectId: 'kv' } }],
      ['notion.update', { pageId: 't1', properties: { Project: { relation: [{ id: 'kv' }] } } }],
    ]);
  });

  it('surfaces real errors', async () => {
    const sendReq = async () => {
      throw new Error('project kv not found');
    };
    await expect(assignItemProject(sendReq, { kind: 'idea', id: 'i1', projectId: 'kv' })).rejects.toThrow('project kv not found');
  });
});
