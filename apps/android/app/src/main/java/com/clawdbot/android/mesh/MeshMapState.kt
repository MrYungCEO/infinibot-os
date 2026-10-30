package com.clawdbot.android.mesh

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Neural Mesh Map State
 *
 * Represents the federation network topology including:
 * - Connected nodes (master + satellites)
 * - Active agents/sessions per node
 * - Real-time connection status
 * - Capability badges
 */

/** Status of a node in the mesh */
enum class NodeStatus {
  Online,
  Connecting,
  Offline,
  Unknown
}

/** Capabilities a node can have */
@Serializable
data class NodeCapabilities(
  val hasOllama: Boolean = false,
  val ollamaModels: List<String> = emptyList(),
  val hasComfyUI: Boolean = false,
  val hasVoice: Boolean = false,
  val gpu: String? = null,
  val gpuVRAM: Int? = null,
  val systemRAM: Int? = null,
  val mcpServers: List<String> = emptyList(),
  val agents: List<String> = emptyList(),
  val platform: String? = null,
  val arch: String? = null,
  val hasCamera: Boolean = false,
  val hasScreen: Boolean = false,
  val hasLocation: Boolean = false,
)

/** An agent running on a node */
@Serializable
data class MeshAgent(
  val sessionKey: String,
  val agentId: String,
  val label: String,
  val status: String = "idle",
  val progress: Int = 0,
  val currentTask: String? = null,
)

/** A node in the mesh network */
@Serializable
data class MeshNode(
  val id: String,
  val name: String,
  val hostname: String,
  val isMaster: Boolean = false,
  val isLocal: Boolean = false,
  val status: String = "unknown",
  val capabilities: NodeCapabilities = NodeCapabilities(),
  val agents: List<MeshAgent> = emptyList(),
  val activeSessions: Int = 0,
  val currentLoad: Int = 0,
  val lastSeenMs: Long = 0,
  /** Position on the mesh map (0-360 degrees from center) */
  val mapAngle: Float = 0f,
  /** Distance from center (0.0-1.0) */
  val mapRadius: Float = 0.5f,
)

/** The full mesh map state */
@Serializable
data class MeshMapState(
  val nodes: List<MeshNode> = emptyList(),
  val masterNodeId: String? = null,
  val localNodeId: String? = null,
  val totalAgents: Int = 0,
  val totalSessions: Int = 0,
  val lastUpdateMs: Long = 0,
  val isConnected: Boolean = false,
) {
  companion object {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Parse mesh state from gateway response JSON
     */
    fun fromJson(jsonString: String): MeshMapState? {
      return try {
        val root = json.parseToJsonElement(jsonString)
        val obj = root as? JsonObject ?: return null
        parseFromObject(obj)
      } catch (_: Throwable) {
        null
      }
    }

    private fun parseFromObject(obj: JsonObject): MeshMapState {
      val nodesArray = (obj["nodes"] as? kotlinx.serialization.json.JsonArray) ?: return MeshMapState()
      val nodes = nodesArray.mapIndexed { index, element ->
        val nodeObj = element as? JsonObject ?: return@mapIndexed null
        parseNode(nodeObj, index, nodesArray.size)
      }.filterNotNull()

      val masterNodeId = (obj["masterNodeId"] as? JsonPrimitive)?.content
      val localNodeId = (obj["localNodeId"] as? JsonPrimitive)?.content

      return MeshMapState(
        nodes = nodes,
        masterNodeId = masterNodeId,
        localNodeId = localNodeId,
        totalAgents = nodes.sumOf { it.agents.size },
        totalSessions = nodes.sumOf { it.activeSessions },
        lastUpdateMs = System.currentTimeMillis(),
        isConnected = nodes.any { it.status == "online" },
      )
    }

    private fun parseNode(obj: JsonObject, index: Int, totalNodes: Int): MeshNode {
      val id = (obj["id"] as? JsonPrimitive)?.content ?: "unknown"
      val name = (obj["name"] as? JsonPrimitive)?.content ?: "Node $index"
      val hostname = (obj["hostname"] as? JsonPrimitive)?.content ?: "unknown"
      val isMaster = (obj["isMaster"] as? JsonPrimitive)?.content?.toBoolean() ?: false
      val isLocal = (obj["isLocal"] as? JsonPrimitive)?.content?.toBoolean() ?: false
      val status = (obj["status"] as? JsonPrimitive)?.content ?: "unknown"
      val currentLoad = (obj["currentLoad"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
      val activeSessions = (obj["activeSessions"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
      val lastSeenMs = (obj["lastSeenMs"] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L

      // Parse capabilities
      val capObj = obj["capabilities"] as? JsonObject
      val capabilities = if (capObj != null) parseCapabilities(capObj) else NodeCapabilities()

      // Parse agents
      val agentsArray = obj["agents"] as? kotlinx.serialization.json.JsonArray
      val agents = agentsArray?.mapNotNull { parseAgent(it as? JsonObject) } ?: emptyList()

      // Calculate map position: master at center, others in circle
      val angle = if (isMaster) 0f else (360f / (totalNodes - 1).coerceAtLeast(1)) * index
      val radius = if (isMaster) 0f else 0.6f

      return MeshNode(
        id = id,
        name = name,
        hostname = hostname,
        isMaster = isMaster,
        isLocal = isLocal,
        status = status,
        capabilities = capabilities,
        agents = agents,
        activeSessions = activeSessions,
        currentLoad = currentLoad,
        lastSeenMs = lastSeenMs,
        mapAngle = angle,
        mapRadius = radius,
      )
    }

    private fun parseCapabilities(obj: JsonObject): NodeCapabilities {
      return NodeCapabilities(
        hasOllama = (obj["hasOllama"] as? JsonPrimitive)?.content?.toBoolean() ?: false,
        ollamaModels = (obj["ollamaModels"] as? kotlinx.serialization.json.JsonArray)
          ?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
        hasComfyUI = (obj["hasComfyUI"] as? JsonPrimitive)?.content?.toBoolean() ?: false,
        hasVoice = (obj["hasVoice"] as? JsonPrimitive)?.content?.toBoolean() ?: false,
        gpu = (obj["gpu"] as? JsonPrimitive)?.content,
        gpuVRAM = (obj["gpuVRAM"] as? JsonPrimitive)?.content?.toIntOrNull(),
        systemRAM = (obj["systemRAM"] as? JsonPrimitive)?.content?.toIntOrNull(),
        mcpServers = (obj["mcpServers"] as? kotlinx.serialization.json.JsonArray)
          ?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
        agents = (obj["agents"] as? kotlinx.serialization.json.JsonArray)
          ?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
        platform = (obj["platform"] as? JsonPrimitive)?.content,
        arch = (obj["arch"] as? JsonPrimitive)?.content,
        hasCamera = (obj["hasCamera"] as? JsonPrimitive)?.content?.toBoolean() ?: false,
        hasScreen = (obj["hasScreen"] as? JsonPrimitive)?.content?.toBoolean() ?: false,
        hasLocation = (obj["hasLocation"] as? JsonPrimitive)?.content?.toBoolean() ?: false,
      )
    }

    private fun parseAgent(obj: JsonObject?): MeshAgent? {
      if (obj == null) return null
      val sessionKey = (obj["sessionKey"] as? JsonPrimitive)?.content ?: return null
      return MeshAgent(
        sessionKey = sessionKey,
        agentId = (obj["agentId"] as? JsonPrimitive)?.content ?: "unknown",
        label = (obj["label"] as? JsonPrimitive)?.content ?: sessionKey,
        status = (obj["status"] as? JsonPrimitive)?.content ?: "idle",
        progress = (obj["progress"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0,
        currentTask = (obj["currentTask"] as? JsonPrimitive)?.content,
      )
    }
  }

  /**
   * Serialize to JSON for web sync
   */
  fun toJson(): String {
    return json.encodeToString(serializer(), this)
  }

  /**
   * Get master node
   */
  fun getMasterNode(): MeshNode? = nodes.find { it.isMaster }

  /**
   * Get local node
   */
  fun getLocalNode(): MeshNode? = nodes.find { it.isLocal }

  /**
   * Get satellite nodes (non-master)
   */
  fun getSatelliteNodes(): List<MeshNode> = nodes.filter { !it.isMaster }
}
