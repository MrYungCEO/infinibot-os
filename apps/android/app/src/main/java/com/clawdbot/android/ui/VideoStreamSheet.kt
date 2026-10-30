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
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawdbot.android.MainViewModel
import com.clawdbot.android.stream.VideoStreamController

/**
 * Video Stream Bottom Sheet
 *
 * Provides controls for streaming video feed to master device:
 * - Camera preview
 * - Start/stop/pause streaming
 * - Quality and FPS settings
 * - Switch front/back camera
 */
@Composable
fun VideoStreamSheet(viewModel: MainViewModel) {
  val streamState by viewModel.videoStreamState.collectAsState()
  val fps by viewModel.videoStreamFps.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  val isStreaming = streamState == VideoStreamController.StreamState.Streaming

  Column(
    modifier = Modifier
      .fillMaxWidth()
      .fillMaxHeight(0.9f)
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
        imageVector = if (isStreaming) Icons.Default.Videocam else Icons.Default.VideocamOff,
        contentDescription = "Video Stream",
        tint = if (isStreaming) Color(0xFF4CAF50) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
      )
      Spacer(modifier = Modifier.width(12.dp))
      Column(modifier = Modifier.weight(1f)) {
        Text(
          text = "Video Stream to Master",
          fontWeight = FontWeight.Bold,
          fontSize = 18.sp,
        )
        Text(
          text = when {
            !isConnected -> "Connect to gateway first"
            isStreaming -> "Streaming at ${fps}fps"
            streamState == VideoStreamController.StreamState.Paused -> "Stream paused"
            streamState == VideoStreamController.StreamState.Starting -> "Starting..."
            else -> "Ready to stream"
          },
          fontSize = 12.sp,
          color = if (isStreaming) {
            Color(0xFF4CAF50)
          } else {
            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
          },
        )
      }
    }

    // Connection warning
    if (!isConnected) {
      ConnectionWarning(
        modifier = Modifier
          .fillMaxWidth()
          .padding(bottom = 16.dp),
      )
    }

    // Video Stream View
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .weight(1f),
    ) {
      VideoStreamView(
        controller = viewModel.videoStream,
        showPreview = true,
        compact = false,
      )
    }
  }
}

@Composable
private fun ConnectionWarning(modifier: Modifier = Modifier) {
  Row(
    verticalAlignment = Alignment.CenterVertically,
    modifier = modifier
      .padding(12.dp),
  ) {
    Icon(
      imageVector = Icons.Default.VideocamOff,
      contentDescription = "Not connected",
      tint = Color(0xFFFFC107),
    )
    Spacer(modifier = Modifier.width(8.dp))
    Text(
      text = "Connect to a gateway to start streaming",
      fontSize = 13.sp,
      color = Color(0xFFFFC107),
    )
  }
}
