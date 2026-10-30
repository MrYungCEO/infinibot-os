/**
 * PanelBody — panel.type → native body (web masonry-grid renderPanel switch).
 * Every body gets { panel, gateway, navigation, onPatch, refreshSignal } and
 * fills its parent (flex: 1). A body that throws is contained by a small
 * boundary so one broken panel never blanks the grid.
 */
import React from 'react';

import { PanelEmpty, PanelError } from './panel-kit';
import { SessionPanel } from './panels/SessionPanel';
import { GroupChatPanel } from './panels/GroupChatPanel';
import { KanbanPanel } from './panels/KanbanPanel';
import { ActivityPanel } from './panels/ActivityPanel';
import { CreditsPanel } from './panels/CreditsPanel';
import { GpuPanel } from './panels/GpuPanel';
import { DatabasePanel } from './panels/DatabasePanel';
import { ChartPanel } from './panels/ChartPanel';
import { KnowledgeGraphPanel } from './panels/KnowledgeGraphPanel';
import { TerminalPanel } from './panels/TerminalPanel';
import { AgencyOpsPanel } from './panels/AgencyOpsPanel';
import { CanvasPanel, VideoPanel, ViewPanel, VoicePanel } from './panels/LaunchPanels';

class PanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <PanelError message={String(this.state.error?.message || this.state.error)} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function Body(props) {
  switch (props.panel.type) {
    case 'session': return <SessionPanel {...props} />;
    case 'group_chat': return <GroupChatPanel {...props} initialTab="chat" />;
    case 'workflow_builder': return <GroupChatPanel {...props} initialTab="workflows" />;
    case 'kanban': return <KanbanPanel {...props} variant="kanban" />;
    case 'projects': return <KanbanPanel {...props} variant="projects" />;
    case 'tasks': return <KanbanPanel {...props} variant="tasks" />;
    case 'activity': return <ActivityPanel {...props} />;
    case 'credits': return <CreditsPanel {...props} />;
    case 'gpu': return <GpuPanel {...props} />;
    case 'database': return <DatabasePanel {...props} />;
    case 'chart': return <ChartPanel {...props} />;
    case 'knowledgeGraph': return <KnowledgeGraphPanel {...props} />;
    case 'terminal': return <TerminalPanel {...props} />;
    case 'agencyOps': return <AgencyOpsPanel {...props} />;
    case 'voice': return <VoicePanel {...props} />;
    case 'video': return <VideoPanel {...props} />;
    case 'canvas': return <CanvasPanel {...props} />;
    case 'view': return <ViewPanel {...props} />;
    default: return <PanelEmpty icon="help-circle-outline" title="Unknown panel" message={String(props.panel.type)} />;
  }
}

export const PanelBody = React.memo(function PanelBody(props) {
  return (
    <PanelBoundary>
      <Body {...props} />
    </PanelBoundary>
  );
});
