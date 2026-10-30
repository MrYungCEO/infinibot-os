/**
 * useMesh — Hook for Neural Mesh / Federation Data
 * 
 * Fetches and manages:
 * - Active agents and their sessions
 * - Federation nodes
 * - Mesh status
 * - Real-time activity events
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { COLORS } from '../constants/theme';

// Agent display name mapping
const AGENT_NAMES = {
  'main': 'ASH',
  'coder': 'CODER',
  'coder-claude': 'CLAUDE CODER',
  'claude-coder': 'CLAUDE CODER',
  'gemini-coder': 'GEMINI CODER',
  'architect': 'ARCHITECT',
  'inspector': 'INSPECTOR',
  'deep-thinker': 'DEEP THINKER',
  'opus': 'DEEP THINKER',
  'canvas': 'CANVAS',
  'pixel': 'PIXEL',
  'overseer': 'OVERSEER',
  'dev': 'DEV',
  'tester': 'TESTER',
  'researcher': 'RESEARCHER',
};

// Agent color palette
const AGENT_COLORS = {
  'main': COLORS.primary,
  'ash': COLORS.primary,
  'coder': '#FF69B4',
  'coder-claude': '#FF69B4',
  'claude-coder': '#FF69B4',
  'gemini-coder': '#00FFFF',
  'architect': '#9B59B6',
  'inspector': '#2ECC71',
  'deep-thinker': '#3498DB',
  'opus': '#3498DB',
  'canvas': '#E74C3C',
  'pixel': '#F39C12',
  'overseer': '#FF6B6B',
  'dev': '#00CED1',
  'tester': '#A855F7',
  'researcher': '#10B981',
};

export function getAgentDisplayName(agentId) {
  if (!agentId) return 'Unknown';
  const id = agentId.replace(/^agent:/, '').split(':')[0].toLowerCase();
  return AGENT_NAMES[id] || id.toUpperCase();
}

export function getAgentColor(agentId) {
  if (!agentId) return '#888888';
  const id = agentId.replace(/^agent:/, '').split(':')[0].toLowerCase();
  
  // Check direct match
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  
  // Check partial match
  for (const [key, color] of Object.entries(AGENT_COLORS)) {
    if (id.includes(key)) return color;
  }
  
  // Generate consistent color from hash
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

// Cap for sessions.list — the store can hold thousands of sessions.
const SESSIONS_LIMIT = 100;

export function useMesh(gateway) {
  const [agents, setAgents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [federationNodes, setFederationNodes] = useState([]);
  const [meshStatus, setMeshStatus] = useState(null);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const pollIntervalRef = useRef(null);
  const lastFetchRef = useRef(0);

  // Fetch all mesh data
  const fetchMeshData = useCallback(async (force = false) => {
    if (!gateway?.sendReq) return;
    
    // Throttle fetches to avoid spam
    const now = Date.now();
    if (!force && now - lastFetchRef.current < 3000) return;
    lastFetchRef.current = now;

    try {
      const results = await Promise.allSettled([
        // 1. Get sessions list
        // Bounded + metadata-only: the mesh only groups sessions by agent and
        // reads their timestamps, so no per-session transcript reads
        // (includeDerivedTitles / includeLastMessage) and never an unbounded
        // list. `messageLimit` is not a sessions.list param (strict schema).
        gateway.sendReq('sessions.list', {
          includeGlobal: false,
          includeFederated: true,
          limit: SESSIONS_LIMIT,
        }),
        
        // 2. Get federation status
        gateway.sendReq('federation.status', {}),
        
        // 3. Get mesh status (if available)
        gateway.sendReq('mesh.status', {}),
        
        // 4. Get nodes status
        gateway.sendReq('nodes.status', {}),
      ]);

      // Process sessions
      const sessionsResult = results[0];
      if (sessionsResult.status === 'fulfilled' && sessionsResult.value?.sessions) {
        const sessionsList = sessionsResult.value.sessions;
        setSessions(sessionsList);
        
        // Group sessions by agent type
        const agentMap = new Map();
        
        sessionsList.forEach(session => {
          const sessionKey = session.sessionKey || session.key || '';
          const parts = sessionKey.split(':');
          const agentType = parts[1] || 'main';
          const agentId = `agent:${agentType}`;
          
          if (!agentMap.has(agentId)) {
            agentMap.set(agentId, {
              id: agentId,
              type: agentType,
              displayName: getAgentDisplayName(agentType),
              color: getAgentColor(agentType),
              sessions: [],
              sessionCount: 0,
              isActive: false,
              isThinking: false,
              nodeId: session.nodeId || 'local',
              lastActivity: null,
            });
          }
          
          const agent = agentMap.get(agentId);
          agent.sessions.push(session);
          agent.sessionCount++;
          
          // Determine activity status
          const lastActive = session.lastActiveAt || session.updatedAt || session.createdAt;
          if (lastActive) {
            const timestamp = new Date(lastActive).getTime();
            if (!agent.lastActivity || timestamp > agent.lastActivity) {
              agent.lastActivity = timestamp;
            }
            
            const diff = Date.now() - timestamp;
            if (diff < 60 * 1000) { // Active in last minute
              agent.isThinking = true;
              agent.isActive = true;
            } else if (diff < 5 * 60 * 1000) { // Active in last 5 mins
              agent.isActive = true;
            }
          }
          
          // Check for streaming/thinking state
          if (session.state === 'streaming' || session.state === 'thinking') {
            agent.isThinking = true;
            agent.isActive = true;
          }
        });
        
        setAgents(Array.from(agentMap.values()));
        setError(null);
      } else if (sessionsResult.status === 'rejected') {
        // Sessions are the backbone of the mesh view; surface the failure
        // (the other three calls are optional overlays and stay best-effort).
        setError(sessionsResult.reason?.message || String(sessionsResult.reason || 'sessions.list failed'));
      }

      // Process federation nodes
      const fedResult = results[1];
      if (fedResult.status === 'fulfilled' && fedResult.value) {
        const nodes = fedResult.value.nodes || fedResult.value.satellites || [];
        setFederationNodes(nodes.map(node => ({
          id: node.id || node.nodeId,
          name: node.name || node.hostname || node.id,
          isOnline: node.status === 'online' || node.connected === true,
          lastSeen: node.lastSeen || node.lastHeartbeat,
          capabilities: node.capabilities || [],
          agentCount: node.sessions?.length || 0,
        })));
      }

      // Process mesh status
      const meshResult = results[2];
      if (meshResult.status === 'fulfilled' && meshResult.value) {
        setMeshStatus(meshResult.value);
        
        // Add any mesh agents not in sessions
        if (meshResult.value.agents) {
          const existingIds = new Set(agents.map(a => a.id));
          meshResult.value.agents.forEach(ma => {
            const agentId = ma.sessionKey || ma.id;
            if (!existingIds.has(agentId)) {
              setAgents(prev => [...prev, {
                id: agentId,
                type: ma.agentId || 'unknown',
                displayName: getAgentDisplayName(ma.agentId || ma.label || agentId),
                color: getAgentColor(ma.agentId || agentId),
                sessions: [],
                sessionCount: 0,
                isActive: ma.status === 'working' || ma.status === 'idle',
                isThinking: ma.status === 'working',
                nodeId: ma.nodeId || 'local',
                lastActivity: Date.now(),
              }]);
            }
          });
        }
      }

    } catch (err) {
      console.error('Mesh fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  // Add activity entry
  const addActivity = useCallback((activity) => {
    setActivities(prev => [{
      id: `act-${Date.now()}`,
      time: new Date().toLocaleTimeString(),
      ...activity,
    }, ...prev].slice(0, 50)); // Keep last 50
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    fetchMeshData(true);
    
    // Poll every 5 seconds for updates
    pollIntervalRef.current = setInterval(() => {
      fetchMeshData();
    }, 5000);
    
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [fetchMeshData]);

  // Stats computed from data
  const stats = {
    agentCount: agents.length,
    sessionCount: sessions.length,
    nodeCount: federationNodes.length + 1, // +1 for local
    activeCount: agents.filter(a => a.isActive).length,
    thinkingCount: agents.filter(a => a.isThinking).length,
  };

  // NOTE: there is no gateway RPC for a client to push mesh state (the old
  // `federation.mesh.sync` call had no handler). The web mesh reads the same
  // server-side sources this hook does, so nothing needs to be pushed.

  return {
    agents,
    sessions,
    federationNodes,
    meshStatus,
    activities,
    stats,
    loading,
    error,
    refresh: () => fetchMeshData(true),
    addActivity,
  };
}

export default useMesh;
