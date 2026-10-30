package com.clawdbot.android.ui

import androidx.camera.view.PreviewView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraFront
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.clawdbot.android.stream.VideoStreamController

/**
 * Video Stream View
 *
 * Displays camera preview and streaming controls.
 * - Start/stop/pause streaming
 * - Switch cameras
 * - Quality settings
 * - FPS and bitrate stats
 */
@Composable
fun VideoStreamView(
  controller: VideoStreamController,
  modifier: Modifier = Modifier,
  showPreview: Boolean = true,
  compact: Boolean = false,
) {
  val state by controller.state.collectAsState()
  val config by controller.config.collectAsState()
  val actualFps by controller.actualFps.collectAsState()
  val bitrate by controller.bitrate.collectAsState()
  val lastError by controller.lastError.collectAsState()

  val lifecycleOwner = LocalLifecycleOwner.current
  var previewView by remember { mutableStateOf<PreviewView?>(null) }
  var showSettings by remember { mutableStateOf(false) }

  val isStreaming = state == VideoStreamController.StreamState.Streaming
  val isPaused = state == VideoStreamController.StreamState.Paused
  val isActive = isStreaming || isPaused

  Box(modifier = modifier.fillMaxSize()) {
    // Camera preview
    if (showPreview && isActive) {
      AndroidView(
        factory = { ctx ->
          PreviewView(ctx).also { previewView = it }
        },
        modifier = Modifier.fillMaxSize(),
      )
    } else {
      // Placeholder when not streaming
      Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
          .fillMaxSize()
          .background(MaterialTheme.colorScheme.surfaceVariant),
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          Icon(
            imageVector = Icons.Default.VideocamOff,
            contentDescription = "No Stream",
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
            modifier = Modifier.size(64.dp),
          )
          Spacer(modifier = Modifier.height(16.dp))
          Text(
            text = when (state) {
              VideoStreamController.StreamState.Starting -> "Starting..."
              VideoStreamController.StreamState.Error -> lastError ?: "Stream error"
              else -> "Tap to start streaming"
            },
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            fontSize = 14.sp,
          )
        }
      }
    }

    // Streaming indicator overlay
    if (isStreaming) {
      StreamingIndicator(
        fps = actualFps,
        bitrate = bitrate,
        modifier = Modifier
          .align(Alignment.TopStart)
          .padding(16.dp),
      )
    }

    // Controls overlay
    if (compact) {
      CompactControls(
        state = state,
        onStartStop = {
          if (isActive) {
            controller.stop()
          } else {
            controller.start(lifecycleOwner, previewView)
          }
        },
        onPauseResume = {
          if (isPaused) controller.resume() else controller.pause()
        },
        modifier = Modifier.align(Alignment.BottomCenter),
      )
    } else {
      FullControls(
        state = state,
        config = config,
        onStartStop = {
          if (isActive) {
            controller.stop()
          } else {
            controller.start(lifecycleOwner, previewView)
          }
        },
        onPauseResume = {
          if (isPaused) controller.resume() else controller.pause()
        },
        onSwitchCamera = {
          controller.switchCamera(lifecycleOwner, previewView)
        },
        onSettingsClick = { showSettings = true },
        modifier = Modifier.align(Alignment.BottomCenter),
      )
    }

    // Settings dialog
    if (showSettings) {
      StreamSettingsDialog(
        config = config,
        onDismiss = { showSettings = false },
        onConfigChange = { newConfig ->
          controller.updateConfig(newConfig)
        },
      )
    }
  }

  // Cleanup on dispose
  DisposableEffect(lifecycleOwner) {
    onDispose {
      controller.stop()
    }
  }
}

@Composable
private fun StreamingIndicator(
  fps: Int,
  bitrate: Long,
  modifier: Modifier = Modifier,
) {
  Row(
    verticalAlignment = Alignment.CenterVertically,
    modifier = modifier
      .clip(RoundedCornerShape(8.dp))
      .background(Color.Black.copy(alpha = 0.6f))
      .padding(horizontal = 12.dp, vertical = 6.dp),
  ) {
    // Recording indicator
    Icon(
      imageVector = Icons.Default.FiberManualRecord,
      contentDescription = "Streaming",
      tint = Color.Red,
      modifier = Modifier.size(12.dp),
    )
    
    Spacer(modifier = Modifier.width(8.dp))
    
    // Stats
    Text(
      text = "${fps}fps",
      color = Color.White,
      fontSize = 12.sp,
      fontWeight = FontWeight.Medium,
    )
    
    Spacer(modifier = Modifier.width(8.dp))
    
    Text(
      text = formatBitrate(bitrate),
      color = Color.White.copy(alpha = 0.8f),
      fontSize = 11.sp,
    )
  }
}

@Composable
private fun CompactControls(
  state: VideoStreamController.StreamState,
  onStartStop: () -> Unit,
  onPauseResume: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val isActive = state == VideoStreamController.StreamState.Streaming ||
    state == VideoStreamController.StreamState.Paused
  val isPaused = state == VideoStreamController.StreamState.Paused

  Row(
    horizontalArrangement = Arrangement.Center,
    modifier = modifier
      .fillMaxWidth()
      .padding(16.dp),
  ) {
    // Main start/stop button
    FilledTonalIconButton(
      onClick = onStartStop,
      modifier = Modifier.size(56.dp),
      colors = IconButtonDefaults.filledTonalIconButtonColors(
        containerColor = if (isActive) Color.Red.copy(alpha = 0.2f) else MaterialTheme.colorScheme.primaryContainer,
      ),
    ) {
      Icon(
        imageVector = if (isActive) Icons.Default.Stop else Icons.Default.Videocam,
        contentDescription = if (isActive) "Stop" else "Start",
        tint = if (isActive) Color.Red else MaterialTheme.colorScheme.onPrimaryContainer,
      )
    }

    // Pause/resume button (only when active)
    if (isActive) {
      Spacer(modifier = Modifier.width(16.dp))
      FilledTonalIconButton(
        onClick = onPauseResume,
        modifier = Modifier.size(48.dp),
      ) {
        Icon(
          imageVector = if (isPaused) Icons.Default.PlayArrow else Icons.Default.Pause,
          contentDescription = if (isPaused) "Resume" else "Pause",
        )
      }
    }
  }
}

@Composable
private fun FullControls(
  state: VideoStreamController.StreamState,
  config: VideoStreamController.StreamConfig,
  onStartStop: () -> Unit,
  onPauseResume: () -> Unit,
  onSwitchCamera: () -> Unit,
  onSettingsClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val isActive = state == VideoStreamController.StreamState.Streaming ||
    state == VideoStreamController.StreamState.Paused
  val isPaused = state == VideoStreamController.StreamState.Paused

  Card(
    modifier = modifier
      .fillMaxWidth()
      .padding(16.dp),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.95f),
    ),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      // Status row
      Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Icon(
          imageVector = when (state) {
            VideoStreamController.StreamState.Streaming -> Icons.Default.Videocam
            VideoStreamController.StreamState.Paused -> Icons.Default.Pause
            else -> Icons.Default.VideocamOff
          },
          contentDescription = "Stream Status",
          tint = when (state) {
            VideoStreamController.StreamState.Streaming -> Color(0xFF4CAF50)
            VideoStreamController.StreamState.Error -> Color.Red
            else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
          },
        )
        
        Spacer(modifier = Modifier.width(8.dp))
        
        Text(
          text = when (state) {
            VideoStreamController.StreamState.Streaming -> "Streaming to Master"
            VideoStreamController.StreamState.Paused -> "Stream Paused"
            VideoStreamController.StreamState.Starting -> "Starting..."
            VideoStreamController.StreamState.Error -> "Stream Error"
            else -> "Stream Stopped"
          },
          fontWeight = FontWeight.Medium,
        )
        
        Spacer(modifier = Modifier.weight(1f))
        
        // Resolution badge
        Text(
          text = "${config.width}×${config.height}",
          fontSize = 11.sp,
          color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
      }

      Spacer(modifier = Modifier.height(16.dp))

      // Control buttons
      Row(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth(),
      ) {
        // Main start/stop button
        FilledTonalIconButton(
          onClick = onStartStop,
          modifier = Modifier.size(48.dp),
          colors = IconButtonDefaults.filledTonalIconButtonColors(
            containerColor = if (isActive) Color.Red.copy(alpha = 0.2f) else MaterialTheme.colorScheme.primaryContainer,
          ),
        ) {
          Icon(
            imageVector = if (isActive) Icons.Default.Stop else Icons.Default.Videocam,
            contentDescription = if (isActive) "Stop" else "Start",
            tint = if (isActive) Color.Red else MaterialTheme.colorScheme.onPrimaryContainer,
          )
        }

        // Pause/resume
        if (isActive) {
          FilledTonalIconButton(
            onClick = onPauseResume,
            modifier = Modifier.size(48.dp),
          ) {
            Icon(
              imageVector = if (isPaused) Icons.Default.PlayArrow else Icons.Default.Pause,
              contentDescription = if (isPaused) "Resume" else "Pause",
            )
          }
        }

        // Switch camera
        if (isActive) {
          FilledTonalIconButton(
            onClick = onSwitchCamera,
            modifier = Modifier.size(48.dp),
          ) {
            Icon(
              imageVector = Icons.Default.Cameraswitch,
              contentDescription = "Switch Camera",
            )
          }
        }

        Spacer(modifier = Modifier.weight(1f))

        // Settings
        IconButton(onClick = onSettingsClick) {
          Icon(
            imageVector = Icons.Default.Settings,
            contentDescription = "Settings",
          )
        }
      }
    }
  }
}

@Composable
private fun StreamSettingsDialog(
  config: VideoStreamController.StreamConfig,
  onDismiss: () -> Unit,
  onConfigChange: (VideoStreamController.StreamConfig) -> Unit,
) {
  var fps by remember { mutableStateOf(config.fps.toFloat()) }
  var quality by remember { mutableStateOf(config.quality.toFloat()) }

  Card(
    modifier = Modifier
      .fillMaxWidth()
      .padding(32.dp),
    elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
  ) {
    Column(modifier = Modifier.padding(20.dp)) {
      Text(
        text = "Stream Settings",
        fontWeight = FontWeight.Bold,
        fontSize = 18.sp,
      )

      Spacer(modifier = Modifier.height(20.dp))

      // FPS slider
      Text(
        text = "Frame Rate: ${fps.toInt()} fps",
        fontSize = 13.sp,
      )
      Slider(
        value = fps,
        onValueChange = { fps = it },
        valueRange = 5f..30f,
        steps = 4,
        onValueChangeFinished = {
          onConfigChange(config.copy(fps = fps.toInt()))
        },
      )

      Spacer(modifier = Modifier.height(12.dp))

      // Quality slider
      Text(
        text = "Quality: ${quality.toInt()}%",
        fontSize = 13.sp,
      )
      Slider(
        value = quality,
        onValueChange = { quality = it },
        valueRange = 20f..100f,
        steps = 7,
        onValueChangeFinished = {
          onConfigChange(config.copy(quality = quality.toInt()))
        },
      )

      Spacer(modifier = Modifier.height(16.dp))

      // Resolution options
      Text(
        text = "Resolution",
        fontSize = 13.sp,
      )
      Spacer(modifier = Modifier.height(8.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ResolutionChip(
          label = "480p",
          selected = config.width == 640,
          onClick = { onConfigChange(config.copy(width = 640, height = 480)) },
        )
        ResolutionChip(
          label = "720p",
          selected = config.width == 1280,
          onClick = { onConfigChange(config.copy(width = 1280, height = 720)) },
        )
        ResolutionChip(
          label = "1080p",
          selected = config.width == 1920,
          onClick = { onConfigChange(config.copy(width = 1920, height = 1080)) },
        )
      }

      Spacer(modifier = Modifier.height(20.dp))

      // Close button
      FilledTonalIconButton(
        onClick = onDismiss,
        modifier = Modifier.align(Alignment.End),
      ) {
        Text("Done")
      }
    }
  }
}

@Composable
private fun ResolutionChip(
  label: String,
  selected: Boolean,
  onClick: () -> Unit,
) {
  Box(
    modifier = Modifier
      .clip(RoundedCornerShape(8.dp))
      .background(
        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
        else MaterialTheme.colorScheme.surfaceVariant,
      )
      .border(
        width = if (selected) 2.dp else 0.dp,
        color = if (selected) MaterialTheme.colorScheme.primary else Color.Transparent,
        shape = RoundedCornerShape(8.dp),
      )
      .clickable { onClick() }
      .padding(horizontal = 16.dp, vertical = 8.dp),
  ) {
    Text(
      text = label,
      fontSize = 12.sp,
      color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
    )
  }
}

private fun formatBitrate(kbps: Long): String {
  return when {
    kbps >= 1000 -> "${kbps / 1000}.${(kbps % 1000) / 100}Mbps"
    else -> "${kbps}kbps"
  }
}
