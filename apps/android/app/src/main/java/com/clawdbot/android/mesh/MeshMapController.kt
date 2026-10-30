package com.clawdbot.android.mesh

import android.util.Log
import com.clawdbot.android.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Neural Mesh Map Controller
 *
 * Manages the mesh network visualization state:
 * - Polls gateway for federation status
 * - Maintains node topology
 * - Syncs state changes to web dashboard
 * - Handles real-time events
 */
class MeshMapController(
  private val scope: CoroutineScope,
  private val operatorSession: GatewaySession,
  private val nodeSession: GatewaySession,
) {
  companion object {
    private const val TAG = "MeshMapController"
    private const val POLL_INTERVAL_MS = 5000L // 5 second polling
    private const val FAST_POLL_INTERVAL_MS = 1500L // Fast poll when events detected
  }

  private val json = Json { ignoreUnknownKeys = true }

  private val _meshState = MutableStateFlow(MeshMapState())
  val meshState: StateFlow<MeshMapState> = _meshState.asStateFlow()

  private val _isEnabled = MutableStateFlow(false)
  val isEnabled: StateFlow<Boolean> = _isEnabled.asStateFlow()

  private val _lastError = MutableStateFlow<String?>(null)
  val lastError: StateFlow<String?> = _lastError.asStateFlow()

  private var pollJob: Job? = null
  private var fastPollUntil: Long = 0

  /**
   * Enable mesh map syncing
   */
  fun enable() {
    if (_isEnabled.value) return
    _isEnabled.value = true
    startPolling()
    Log.i(TAG, "Mesh map enabled")
  }

  /**
   * Disable mesh map syncing
   */
  fun disable() {
    _isEnabled.value = false
    pollJob?.cancel()
    pollJob = null
    Log.i(TAG, "Mesh map disabled")
  }

  /**
   * Force refresh of mesh state
   */
  fun refresh() {
    scope.launch {
      fetchMeshState()
    }
  }

  /**
   * Trigger fast polling (when events detected)
   */
  fun triggerFastPoll() {
    fastPollUntil = System.currentTimeMillis() + 15000 // 15 seconds of fast polling
  }

  /**
   * Handle gateway events that affect mesh state
   */
  fun handleGatewayEvent(event: String, payloadJson: String?) {
    when (event) {
      "federation.node.connected",
      "federation.node.disconnected",
      "session.spawned",
      "session.completed",
      "session.progress",
      "mesh.update" -> {
        // Trigger fast polling on relevant events
        triggerFastPoll()
        refresh()
      }
    }

    // Try to apply incremental update from event
    if (event == "mesh.update" && payloadJson != null) {
      applyIncrementalUpdate(payloadJson)
    }
  }

  private fun startPolling() {
    pollJob?.cancel()
    pollJob = scope.launch(Dispatchers.IO) {
      while (isActive && _isEnabled.value) {
        try {
          fetchMeshState()
        } catch (err: Throwable) {
          Log.w(TAG, "Mesh poll error: ${err.message}")
          _lastError.value = err.message
        }

        // Use fast poll interval if recently triggered
        val interval = if (System.currentTimeMillis() < fastPollUntil) {
          FAST_POLL_INTERVAL_MS
        } else {
          POLL_INTERVAL_MS
        }
        delay(interval)
      }
    }
  }

  private suspend fun fetchMeshState() {
    try {
      // Request mesh status from gateway
      val params = buildJsonObject {
        put("includeAgents", JsonPrimitive(true))
        put("includeCapabilities", JsonPrimitive(true))
        put("includeLoad", JsonPrimitive(true))
      }.toString()

      val response = operatorSession.request("federation.mesh.status", params, timeoutMs = 8000)
      
      val newState = MeshMapState.fromJson(response)
      if (newState != null) {
        _meshState.value = newState
        _lastError.value = null
        
        // Emit state update for web sync
        emitStateToWeb(newState)
      }
    } catch (err: Throwable) {
      Log.w(TAG, "Failed to fetch mesh state: ${err.message}")
      _lastError.value = err.message
    }
  }

  private fun applyIncrementalUpdate(payloadJson: String) {
    try {
      val update = json.parseToJsonElement(payloadJson) as? JsonObject ?: return
      val currentState = _meshState.value
      
      // Parse update type
      val updateType = (update["type"] as? JsonPrimitive)?.content ?: return
      
      when (updateType) {
        "node.status" -> {
          val nodeId = (update["nodeId"] as? JsonPrimitive)?.content ?: return
          val status = (update["status"] as? JsonPrimitive)?.content ?: return
          val updatedNodes = currentState.nodes.map { node ->
            if (node.id == nodeId) node.copy(status = status) else node
          }
          _meshState.value = currentState.copy(nodes = updatedNodes, lastUpdateMs = System.currentTimeMillis())
        }
        "node.load" -> {
          val nodeId = (update["nodeId"] as? JsonPrimitive)?.content ?: return
          val load = (update["load"] as? JsonPrimitive)?.content?.toIntOrNull() ?: return
          val updatedNodes = currentState.nodes.map { node ->
            if (node.id == nodeId) node.copy(currentLoad = load) else node
          }
          _meshState.value = currentState.copy(nodes = updatedNodes, lastUpdateMs = System.currentTimeMillis())
        }
        "agent.spawned", "agent.completed" -> {
          // Full refresh for agent changes
          triggerFastPoll()
        }
      }
    } catch (err: Throwable) {
      Log.w(TAG, "Failed to apply incremental update: ${err.message}")
    }
  }

  private fun emitStateToWeb(state: MeshMapState) {
    // Send state update through node session for web dashboard sync
    scope.launch {
      try {
        val eventPayload = buildJsonObject {
          put("event", JsonPrimitive("mesh.map.update"))
          put("state", JsonPrimitive(state.toJson()))
          put("timestamp", JsonPrimitive(System.currentTimeMillis()))
        }.toString()
        
        nodeSession.sendNodeEvent("mesh.map.update", eventPayload)
      } catch (err: Throwable) {
        Log.w(TAG, "Failed to emit mesh state to web: ${err.message}")
      }
    }
  }

  /**
   * Get formatted status text for UI display
   */
  fun getStatusText(): String {
    val state = _meshState.value
    if (!state.isConnected) return "Disconnected"
    
    val nodeCount = state.nodes.size
    val agentCount = state.totalAgents
    val sessionCount = state.totalSessions
    
    return buildString {
      append("$nodeCount node")
      if (nodeCount != 1) append("s")
      if (agentCount > 0) {
        append(" • $agentCount agent")
        if (agentCount != 1) append("s")
      }
      if (sessionCount > 0) {
        append(" • $sessionCount session")
        if (sessionCount != 1) append("s")
      }
    }
  }
}
