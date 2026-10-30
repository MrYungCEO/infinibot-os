/**
 * Dev harness for the Agent Ops activity map — open /activity-map-harness.html
 * under `npm run dev` to exercise the map with fake mesh data, no gateway
 * required. Used to verify the Galactic HQ world theme.
 */

import { ActivityMap } from '../ui/views/agent-ops/activity-map';

const container = document.getElementById('map')!;

const map = new ActivityMap(container, {
  height: window.innerHeight,
  worldTheme: 'galactic',
  onAgentClick: agent => console.log('[harness] agent click', agent),
  onNodeClick: node => console.log('[harness] node click', node),
  onZoneClick: sector => console.log('[harness] zone click', sector.id),
});

map.addNode({ id: 'hub', name: 'Hub', role: 'hub', status: 'online', agentCount: 3 });
map.addNode({ id: 'sat1', name: 'Satellite 01', role: 'satellite', status: 'online', agentCount: 2 });
map.addNode({ id: 'sat2', name: 'Satellite 02', role: 'satellite', status: 'connecting', agentCount: 1 });

map.addAgent({ sessionKey: 'a1', agentId: 'main', label: 'Orchestrator', nodeId: 'hub', status: 'working', progress: 64, currentTask: 'Coordinating subagents' });
map.addAgent({ sessionKey: 'a2', agentId: 'coder', label: 'Coder', nodeId: 'hub', status: 'idle', progress: 100 });
map.addAgent({ sessionKey: 'a3', agentId: 'coder', label: 'Reviewer', nodeId: 'hub', status: 'working', progress: 35 });
map.addAgent({ sessionKey: 'a4', agentId: 'default', label: 'Researcher', nodeId: 'sat1', status: 'blocked', progress: 30 });
map.addAgent({ sessionKey: 'a5', agentId: 'default', label: 'Scraper', nodeId: 'sat1', status: 'working', progress: 80 });
map.addAgent({ sessionKey: 'a6', agentId: 'default', label: 'Janitor', nodeId: 'sat2', status: 'idle', progress: 0 });

// Demo: light up a few sectors as if live events were flowing
map.setSectorActivity('mission-control', true);
map.setSectorActivity('comms-deck', true);

(window as unknown as Record<string, unknown>).activityMap = map;
