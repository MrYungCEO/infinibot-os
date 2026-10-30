import { resolveDeepLink, graphEntry } from '../navigation/deep-links';
import { SCREEN_SECTIONS } from '../navigation/screen-registry';

describe('knowledge graph deep links', () => {
  test('infinibot://knowledge stays the Knowledge tab', () => {
    expect(resolveDeepLink('infinibot://knowledge')).toMatchObject({ tab: 'Knowledge' });
  });

  test('infinibot://knowledge/graph opens the native graph', () => {
    expect(resolveDeepLink('infinibot://knowledge/graph')).toEqual({ tab: 'Knowledge', params: { screen: 'KnowledgeGraph' }, title: 'Knowledge Graph' });
    expect(resolveDeepLink('infinibot://graph')).toMatchObject({ tab: 'Knowledge', params: { screen: 'KnowledgeGraph' } });
  });

  test('infinibot://knowledge/<nodeId> focuses a node', () => {
    expect(resolveDeepLink('infinibot://knowledge/project:abc-123')).toMatchObject({
      tab: 'Knowledge', params: { screen: 'KnowledgeGraph', params: { focus: 'project:abc-123' } },
    });
    expect(resolveDeepLink('infinibot://knowledge/graph/note%3Arow_1')).toMatchObject({ params: { params: { focus: 'note:row_1' } } });
    expect(resolveDeepLink('infinibot://knowledge/graph?focus=project:x&family=1')).toMatchObject({ params: { params: { focus: 'project:x', family: true } } });
  });

  test('knowledge/<screen> opens Knowledge-tab screens', () => {
    expect(resolveDeepLink('infinibot://knowledge/ideas')).toEqual({ tab: 'Knowledge', params: { screen: 'Ideas' }, title: 'Ideas' });
    expect(resolveDeepLink('infinibot://knowledge/research')).toMatchObject({ params: { screen: 'Research' } });
  });

  test('the web /knowledge-graph route and App Links land on the native screen', () => {
    expect(resolveDeepLink('/knowledge-graph')).toMatchObject({ tab: 'Knowledge', params: { screen: 'KnowledgeGraph' } });
    expect(resolveDeepLink('https://host.example/m/knowledge/project:p1')).toMatchObject({ params: { params: { focus: 'project:p1' } } });
  });

  test('infinibot://reports/<id> opens that report', () => {
    expect(resolveDeepLink('infinibot://reports/rpt_1')).toEqual({ screen: 'ReportsScreen', params: { reportId: 'rpt_1' }, title: 'Reports' });
    expect(resolveDeepLink('infinibot://reports')).toMatchObject({ screen: 'ReportsScreen' });
  });

  test('graphEntry without a node has no nested params', () => {
    expect(graphEntry(null)).toEqual({ tab: 'Knowledge', params: { screen: 'KnowledgeGraph' }, title: 'Knowledge Graph' });
  });

  test('the More/Launchpad catalogue routes Knowledge Graph natively', () => {
    const all = SCREEN_SECTIONS.flatMap((s) => s.items);
    const kg = all.find((i) => i.key === 'kgraph');
    expect(kg).toMatchObject({ tab: 'Knowledge', params: { screen: 'KnowledgeGraph' } });
    expect(kg.webPath).toBeUndefined();
  });
});
