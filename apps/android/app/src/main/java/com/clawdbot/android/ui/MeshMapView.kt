package com.clawdbot.android.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Adb
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawdbot.android.mesh.MeshMapController
import com.clawdbot.android.mesh.MeshMapState
import com.clawdbot.android.mesh.MeshNode
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Neural Mesh Map Visualization
 *
 * Displays the federation network topology with:
 * - Master node at center
 * - Satellite nodes in orbital positions
 * - Connection lines with pulse animations
 * - Status indicators and capability badges
 * - Agent activity indicators
 */
@Composable
fun MeshMapView(
  controller: MeshMapController,
  modifier: Modifier = Modifier,
  onNodeClick: ((MeshNode) -> Unit)? = null,
) {
  val meshState by controller.meshState.collectAsState()
  val isEnabled by controller.isEnabled.collectAsState()
  val lastError by controller.lastError.collectAsState()
  var selectedNode by remember { mutableStateOf<MeshNode?>(null) }

  Box(modifier = modifier.fillMaxSize()) {
    if (!isEnabled) {
      DisabledOverlay(onEnable = { controller.enable() })
    } else if (meshState.nodes.isEmpty()) {
      EmptyStateView(lastError = lastError, onRefresh = { controller.refresh() })
    } else {
      // Main mesh visualization
      MeshVisualization(
        meshState = meshState,
        selectedNode = selectedNode,
        onNodeClick = { node ->
          selectedNode = if (selectedNode?.id == node.id) null else node
          onNodeClick?.invoke(node)
        },
      )

      // Status bar at bottom
      StatusBar(
        statusText = controller.getStatusText(),
        onRefresh = { controller.refresh() },
        modifier = Modifier.align(Alignment.BottomCenter),
      )

      // Selected node details card
      selectedNode?.let { node ->
        NodeDetailCard(
          node = node,
          onDismiss = { selectedNode = null },
          modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(16.dp),
        )
      }
    }
  }
}

@Composable
private fun MeshVisualization(
  meshState: MeshMapState,
  selectedNode: MeshNode?,
  onNodeClick: (MeshNode) -> Unit,
) {
  val density = LocalDensity.current

  Box(modifier = Modifier.fillMaxSize()) {
    // Draw connection lines
    Canvas(modifier = Modifier.fillMaxSize()) {
      val centerX = size.width / 2
      val centerY = size.height / 2
      val maxRadius = minOf(size.width, size.height) * 0.4f

      val masterNode = meshState.getMasterNode()
      val masterCenter = Offset(centerX, centerY)

      // Draw orbital rings
      val ringColors = listOf(
        Color(0x20FFFFFF),
        Color(0x15FFFFFF),
        Color(0x10FFFFFF),
      )
      ringColors.forEachIndexed { index, color ->
        val radius = maxRadius * (0.4f + index * 0.25f)
        drawCircle(
          color = color,
          radius = radius,
          center = masterCenter,
          style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 10f))),
        )
      }

      // Draw connections from master to satellites
      meshState.getSatelliteNodes().forEach { satellite ->
        val angleRad = Math.toRadians(satellite.mapAngle.toDouble())
        val satelliteX = centerX + (maxRadius * satellite.mapRadius * cos(angleRad)).toFloat()
        val satelliteY = centerY + (maxRadius * satellite.mapRadius * sin(angleRad)).toFloat()

        val isOnline = satellite.status == "online"
        val lineColor = if (isOnline) {
          Color(0xFF4CAF50).copy(alpha = 0.6f)
        } else {
          Color(0xFFFF5722).copy(alpha = 0.3f)
        }

        // Draw connection line with gradient
        drawLine(
          brush = Brush.linearGradient(
            colors = listOf(lineColor, lineColor.copy(alpha = 0.1f)),
            start = masterCenter,
            end = Offset(satelliteX, satelliteY),
          ),
          start = masterCenter,
          end = Offset(satelliteX, satelliteY),
          strokeWidth = 2.dp.toPx(),
        )

        // Draw pulse indicator for active connections
        if (isOnline && satellite.activeSessions > 0) {
          val pulseRadius = 8.dp.toPx()
          drawCircle(
            color = Color(0xFF4CAF50).copy(alpha = 0.5f),
            radius = pulseRadius,
            center = Offset(
              satelliteX * 0.7f + masterCenter.x * 0.3f,
              satelliteY * 0.7f + masterCenter.y * 0.3f,
            ),
          )
        }
      }
    }

    // Render nodes
    val maxRadius = with(density) { 140.dp.toPx() }

    // Master node at center
    meshState.getMasterNode()?.let { master ->
      NodeBubble(
        node = master,
        isSelected = selectedNode?.id == master.id,
        onClick = { onNodeClick(master) },
        modifier = Modifier.align(Alignment.Center),
      )
    }

    // Satellite nodes in orbital positions
    meshState.getSatelliteNodes().forEach { satellite ->
      val angleRad = Math.toRadians(satellite.mapAngle.toDouble())
      val offsetX = (maxRadius * satellite.mapRadius * cos(angleRad)).toFloat()
      val offsetY = (maxRadius * satellite.mapRadius * sin(angleRad)).toFloat()

      NodeBubble(
        node = satellite,
        isSelected = selectedNode?.id == satellite.id,
        onClick = { onNodeClick(satellite) },
        modifier = Modifier
          .align(Alignment.Center)
          .offset { IntOffset(offsetX.roundToInt(), offsetY.roundToInt()) },
      )
    }
  }
}

@Composable
private fun NodeBubble(
  node: MeshNode,
  isSelected: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val isOnline = node.status == "online"
  val scale by animateFloatAsState(
    targetValue = if (isSelected) 1.15f else 1f,
    animationSpec = tween(200),
    label = "nodeScale",
  )

  val statusColor = when (node.status) {
    "online" -> Color(0xFF4CAF50)
    "connecting" -> Color(0xFFFFC107)
    else -> Color(0xFFFF5722)
  }

  val nodeIcon: ImageVector = when {
    node.isMaster -> Icons.Default.Cloud
    node.capabilities.platform == "android" -> Icons.Default.PhoneAndroid
    node.capabilities.hasOllama -> Icons.Default.Memory
    else -> Icons.Default.Computer
  }

  val bubbleSize = if (node.isMaster) 72.dp else 56.dp

  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    modifier = modifier
      .clickable { onClick() }
      .alpha(if (isOnline) 1f else 0.5f),
  ) {
    // Node bubble
    Box(
      contentAlignment = Alignment.Center,
      modifier = Modifier
        .size(bubbleSize * scale)
        .clip(CircleShape)
        .background(
          brush = Brush.radialGradient(
            colors = listOf(
              statusColor.copy(alpha = 0.3f),
              statusColor.copy(alpha = 0.1f),
            ),
          ),
        )
        .border(2.dp, statusColor.copy(alpha = 0.6f), CircleShape),
    ) {
      Icon(
        imageVector = nodeIcon,
        contentDescription = node.name,
        tint = statusColor,
        modifier = Modifier.size(if (node.isMaster) 32.dp else 24.dp),
      )

      // Agent count badge
      if (node.agents.isNotEmpty()) {
        Box(
          contentAlignment = Alignment.Center,
          modifier = Modifier
            .align(Alignment.TopEnd)
            .size(20.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary),
        ) {
          Text(
            text = node.agents.size.toString(),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onPrimary,
          )
        }
      }
    }

    Spacer(modifier = Modifier.height(4.dp))

    // Node name
    Text(
      text = node.name,
      fontSize = 11.sp,
      fontWeight = if (node.isMaster) FontWeight.Bold else FontWeight.Normal,
      color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.9f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      textAlign = TextAlign.Center,
      modifier = Modifier.width(80.dp),
    )

    // Status text
    Text(
      text = if (node.isMaster) "Master" else node.status.replaceFirstChar { it.uppercase() },
      fontSize = 9.sp,
      color = statusColor.copy(alpha = 0.8f),
    )
  }
}

@Composable
private fun NodeDetailCard(
  node: MeshNode,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Card(
    modifier = modifier.width(200.dp),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.95f),
    ),
    elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
  ) {
    Column(modifier = Modifier.padding(12.dp)) {
      Text(
        text = node.name,
        fontWeight = FontWeight.Bold,
        fontSize = 14.sp,
      )

      Text(
        text = "${node.hostname} • ${node.status}",
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
      )

      Spacer(modifier = Modifier.height(8.dp))

      // Capabilities
      Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (node.capabilities.hasOllama) CapabilityBadge("🤖 Ollama")
        if (node.capabilities.hasComfyUI) CapabilityBadge("🎨 ComfyUI")
        if (node.capabilities.hasVoice) CapabilityBadge("🎤 Voice")
        if (node.capabilities.gpu != null) CapabilityBadge("🎮 GPU")
      }

      // Agents
      if (node.agents.isNotEmpty()) {
        Spacer(modifier = Modifier.height(8.dp))
        Text(
          text = "Active Agents",
          fontWeight = FontWeight.Medium,
          fontSize = 11.sp,
        )
        node.agents.take(3).forEach { agent ->
          Text(
            text = "• ${agent.label}",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
          )
        }
        if (node.agents.size > 3) {
          Text(
            text = "+${node.agents.size - 3} more",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.primary,
          )
        }
      }

      // Load indicator
      Spacer(modifier = Modifier.height(8.dp))
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
          text = "Load: ${node.currentLoad}%",
          fontSize = 10.sp,
          color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
          text = "Sessions: ${node.activeSessions}",
          fontSize = 10.sp,
          color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
      }
    }
  }
}

@Composable
private fun CapabilityBadge(text: String) {
  Box(
    modifier = Modifier
      .clip(RoundedCornerShape(4.dp))
      .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f))
      .padding(horizontal = 4.dp, vertical = 2.dp),
  ) {
    Text(
      text = text,
      fontSize = 8.sp,
      color = MaterialTheme.colorScheme.onPrimaryContainer,
    )
  }
}

@Composable
private fun StatusBar(
  statusText: String,
  onRefresh: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.Center,
    modifier = modifier
      .fillMaxWidth()
      .padding(16.dp)
      .clip(RoundedCornerShape(20.dp))
      .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
      .padding(horizontal = 16.dp, vertical = 8.dp),
  ) {
    Text(
      text = statusText,
      fontSize = 12.sp,
      color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
    )
    Spacer(modifier = Modifier.width(8.dp))
    IconButton(onClick = onRefresh, modifier = Modifier.size(24.dp)) {
      Icon(
        imageVector = Icons.Default.Refresh,
        contentDescription = "Refresh",
        tint = MaterialTheme.colorScheme.primary,
        modifier = Modifier.size(16.dp),
      )
    }
  }
}

@Composable
private fun DisabledOverlay(onEnable: () -> Unit) {
  Box(
    contentAlignment = Alignment.Center,
    modifier = Modifier
      .fillMaxSize()
      .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
      .clickable { onEnable() },
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Icon(
        imageVector = Icons.Default.Cloud,
        contentDescription = "Enable Mesh Map",
        tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f),
        modifier = Modifier.size(64.dp),
      )
      Spacer(modifier = Modifier.height(16.dp))
      Text(
        text = "Tap to enable Mesh Map",
        fontSize = 14.sp,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
      )
    }
  }
}

@Composable
private fun EmptyStateView(lastError: String?, onRefresh: () -> Unit) {
  Box(
    contentAlignment = Alignment.Center,
    modifier = Modifier.fillMaxSize(),
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      CircularProgressIndicator(
        modifier = Modifier.size(48.dp),
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f),
      )
      Spacer(modifier = Modifier.height(16.dp))
      Text(
        text = lastError ?: "Loading mesh network...",
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        textAlign = TextAlign.Center,
      )
      Spacer(modifier = Modifier.height(16.dp))
      IconButton(onClick = onRefresh) {
        Icon(
          imageVector = Icons.Default.Refresh,
          contentDescription = "Retry",
          tint = MaterialTheme.colorScheme.primary,
        )
      }
    }
  }
}
