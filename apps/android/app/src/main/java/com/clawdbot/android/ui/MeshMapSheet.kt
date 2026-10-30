package com.clawdbot.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawdbot.android.MainViewModel

/**
 * Mesh Map Bottom Sheet
 *
 * Displays the Neural Mesh Map visualization showing:
 * - Connected federation nodes
 * - Active agents/sessions
 * - Real-time status synced to web dashboard
 */
@Composable
fun MeshMapSheet(viewModel: MainViewModel) {
  val isEnabled by viewModel.meshMapEnabled.collectAsState()
  val meshState by viewModel.meshState.collectAsState()

  Column(
    modifier = Modifier
      .fillMaxWidth()
      .fillMaxHeight(0.85f)
      .padding(horizontal = 16.dp),
  ) {
    // Header
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier
        .fillMaxWidth()
        .padding(bottom = 16.dp),
    ) {
      Icon(
        imageVector = Icons.Default.Hub,
        contentDescription = "Mesh Map",
        tint = MaterialTheme.colorScheme.primary,
      )
      Spacer(modifier = Modifier.width(12.dp))
      Column(modifier = Modifier.weight(1f)) {
        Text(
          text = "Neural Mesh Map",
          fontWeight = FontWeight.Bold,
          fontSize = 18.sp,
        )
        Text(
          text = if (isEnabled) {
            "Synced to web dashboard"
          } else {
            "Enable to visualize federation"
          },
          fontSize = 12.sp,
          color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
      }

      // Enable/disable toggle
      Switch(
        checked = isEnabled,
        onCheckedChange = { enabled ->
          if (enabled) viewModel.meshMap.enable() else viewModel.meshMap.disable()
        },
      )
    }

    // Stats bar
    if (isEnabled) {
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(bottom = 12.dp),
      ) {
        StatBadge(
          label = "Nodes",
          value = meshState.nodes.size.toString(),
        )
        Spacer(modifier = Modifier.width(16.dp))
        StatBadge(
          label = "Agents",
          value = meshState.totalAgents.toString(),
        )
        Spacer(modifier = Modifier.width(16.dp))
        StatBadge(
          label = "Sessions",
          value = meshState.totalSessions.toString(),
        )
        Spacer(modifier = Modifier.weight(1f))
        IconButton(onClick = { viewModel.meshMap.refresh() }) {
          Icon(
            imageVector = Icons.Default.Refresh,
            contentDescription = "Refresh",
            tint = MaterialTheme.colorScheme.primary,
          )
        }
      }
    }

    // Mesh Map Visualization
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .weight(1f),
    ) {
      MeshMapView(
        controller = viewModel.meshMap,
        onNodeClick = { node ->
          // Could show node details or navigate
        },
      )
    }
  }
}

@Composable
private fun StatBadge(
  label: String,
  value: String,
) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Text(
      text = value,
      fontWeight = FontWeight.Bold,
      fontSize = 20.sp,
      color = MaterialTheme.colorScheme.primary,
    )
    Text(
      text = label,
      fontSize = 11.sp,
      color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
    )
  }
}
