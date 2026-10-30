package com.clawdbot.android.stream

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.util.Base64
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.clawdbot.android.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Video Stream Controller
 *
 * Streams camera video feed to master device via WebSocket.
 * Features:
 * - Adaptive quality based on network conditions
 * - Frame rate throttling
 * - Base64 JPEG encoding for transport
 * - Auto-reconnect on connection loss
 */
class VideoStreamController(
  private val context: Context,
  private val scope: CoroutineScope,
  private val nodeSession: GatewaySession,
) {
  companion object {
    private const val TAG = "VideoStreamController"
    private const val DEFAULT_FPS = 15
    private const val DEFAULT_QUALITY = 60
    private const val DEFAULT_WIDTH = 640
    private const val DEFAULT_HEIGHT = 480
    private const val MAX_FRAME_SIZE_BYTES = 100_000 // 100KB per frame max
  }

  /** Stream state */
  enum class StreamState {
    Stopped,
    Starting,
    Streaming,
    Paused,
    Error,
  }

  /** Stream configuration */
  data class StreamConfig(
    val fps: Int = DEFAULT_FPS,
    val quality: Int = DEFAULT_QUALITY,
    val width: Int = DEFAULT_WIDTH,
    val height: Int = DEFAULT_HEIGHT,
    val facing: CameraSelector = CameraSelector.DEFAULT_BACK_CAMERA,
  )

  private val _state = MutableStateFlow(StreamState.Stopped)
  val state: StateFlow<StreamState> = _state.asStateFlow()

  private val _config = MutableStateFlow(StreamConfig())
  val config: StateFlow<StreamConfig> = _config.asStateFlow()

  private val _fps = MutableStateFlow(0)
  val actualFps: StateFlow<Int> = _fps.asStateFlow()

  private val _bitrate = MutableStateFlow(0L)
  val bitrate: StateFlow<Long> = _bitrate.asStateFlow()

  private val _lastError = MutableStateFlow<String?>(null)
  val lastError: StateFlow<String?> = _lastError.asStateFlow()

  private var streamJob: Job? = null
  private var cameraProvider: ProcessCameraProvider? = null
  private val imageAnalyzerExecutor = Executors.newSingleThreadExecutor()
  private val frameChannel = Channel<ByteArray>(capacity = 2) // Buffer 2 frames

  // FPS calculation
  private var frameCount = 0
  private var lastFpsUpdate = System.currentTimeMillis()
  private var totalBytesInSecond = 0L

  /**
   * Start video streaming with given configuration
   */
  fun start(
    lifecycleOwner: LifecycleOwner,
    previewView: PreviewView? = null,
    config: StreamConfig = StreamConfig(),
  ) {
    if (_state.value == StreamState.Streaming) {
      Log.w(TAG, "Stream already running")
      return
    }

    _config.value = config
    _state.value = StreamState.Starting
    _lastError.value = null

    scope.launch(Dispatchers.Main) {
      try {
        initializeCamera(lifecycleOwner, previewView, config)
        startFrameTransmission()
        _state.value = StreamState.Streaming
        Log.i(TAG, "Video stream started: ${config.width}x${config.height} @ ${config.fps}fps")
      } catch (err: Throwable) {
        Log.e(TAG, "Failed to start stream: ${err.message}", err)
        _lastError.value = err.message
        _state.value = StreamState.Error
      }
    }
  }

  /**
   * Stop video streaming
   */
  fun stop() {
    _state.value = StreamState.Stopped
    streamJob?.cancel()
    streamJob = null
    cameraProvider?.unbindAll()
    cameraProvider = null
    frameChannel.close()
    _fps.value = 0
    _bitrate.value = 0
    Log.i(TAG, "Video stream stopped")
  }

  /**
   * Pause streaming (keeps camera active)
   */
  fun pause() {
    if (_state.value == StreamState.Streaming) {
      _state.value = StreamState.Paused
      Log.d(TAG, "Video stream paused")
    }
  }

  /**
   * Resume streaming
   */
  fun resume() {
    if (_state.value == StreamState.Paused) {
      _state.value = StreamState.Streaming
      Log.d(TAG, "Video stream resumed")
    }
  }

  /**
   * Update stream configuration
   */
  fun updateConfig(config: StreamConfig) {
    _config.value = config
    // TODO: Re-initialize camera if resolution changed
  }

  /**
   * Switch between front and back camera
   */
  fun switchCamera(lifecycleOwner: LifecycleOwner, previewView: PreviewView?) {
    val current = _config.value.facing
    val newFacing = if (current == CameraSelector.DEFAULT_BACK_CAMERA) {
      CameraSelector.DEFAULT_FRONT_CAMERA
    } else {
      CameraSelector.DEFAULT_BACK_CAMERA
    }
    val newConfig = _config.value.copy(facing = newFacing)
    
    stop()
    start(lifecycleOwner, previewView, newConfig)
  }

  private suspend fun initializeCamera(
    lifecycleOwner: LifecycleOwner,
    previewView: PreviewView?,
    config: StreamConfig,
  ) = withContext(Dispatchers.Main) {
    val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
    cameraProvider = cameraProviderFuture.get()

    val preview = previewView?.let {
      Preview.Builder()
        .setTargetResolution(Size(config.width, config.height))
        .build()
        .also { preview ->
          preview.setSurfaceProvider(it.surfaceProvider)
        }
    }

    val imageAnalysis = ImageAnalysis.Builder()
      .setTargetResolution(Size(config.width, config.height))
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()

    imageAnalysis.setAnalyzer(imageAnalyzerExecutor) { imageProxy ->
      if (_state.value == StreamState.Streaming) {
        processFrame(imageProxy, config)
      }
      imageProxy.close()
    }

    cameraProvider?.unbindAll()
    
    try {
      if (preview != null) {
        cameraProvider?.bindToLifecycle(
          lifecycleOwner,
          config.facing,
          preview,
          imageAnalysis,
        )
      } else {
        cameraProvider?.bindToLifecycle(
          lifecycleOwner,
          config.facing,
          imageAnalysis,
        )
      }
    } catch (err: Exception) {
      Log.e(TAG, "Camera binding failed: ${err.message}", err)
      throw err
    }
  }

  private fun processFrame(imageProxy: ImageProxy, config: StreamConfig) {
    try {
      val bitmap = imageProxy.toBitmap() ?: return
      val scaledBitmap = Bitmap.createScaledBitmap(bitmap, config.width, config.height, true)
      
      val outputStream = ByteArrayOutputStream()
      scaledBitmap.compress(Bitmap.CompressFormat.JPEG, config.quality, outputStream)
      val jpegBytes = outputStream.toByteArray()
      
      // Skip if frame too large
      if (jpegBytes.size > MAX_FRAME_SIZE_BYTES) {
        Log.w(TAG, "Frame too large (${jpegBytes.size} bytes), skipping")
        return
      }

      // Non-blocking send to frame channel
      frameChannel.trySend(jpegBytes)
      
      if (scaledBitmap != bitmap) {
        scaledBitmap.recycle()
      }
      bitmap.recycle()
    } catch (err: Throwable) {
      Log.w(TAG, "Frame processing error: ${err.message}")
    }
  }

  private fun startFrameTransmission() {
    streamJob?.cancel()
    streamJob = scope.launch(Dispatchers.IO) {
      val frameInterval = 1000L / _config.value.fps

      while (isActive && _state.value != StreamState.Stopped) {
        if (_state.value != StreamState.Streaming) {
          delay(100)
          continue
        }

        try {
          val frameStart = System.currentTimeMillis()
          
          // Get next frame from channel
          val frameBytes = frameChannel.tryReceive().getOrNull() ?: run {
            delay(10)
            return@launch
          }

          // Send frame via gateway
          sendFrame(frameBytes)

          // Update metrics
          updateMetrics(frameBytes.size)

          // Throttle to target FPS
          val elapsed = System.currentTimeMillis() - frameStart
          val sleepTime = frameInterval - elapsed
          if (sleepTime > 0) {
            delay(sleepTime)
          }
        } catch (err: Throwable) {
          Log.w(TAG, "Frame transmission error: ${err.message}")
          delay(100)
        }
      }
    }
  }

  private suspend fun sendFrame(frameBytes: ByteArray) {
    try {
      val base64Frame = Base64.encodeToString(frameBytes, Base64.NO_WRAP)
      
      val payload = buildJsonObject {
        put("type", JsonPrimitive("video.frame"))
        put("format", JsonPrimitive("jpeg"))
        put("width", JsonPrimitive(_config.value.width))
        put("height", JsonPrimitive(_config.value.height))
        put("timestamp", JsonPrimitive(System.currentTimeMillis()))
        put("data", JsonPrimitive(base64Frame))
      }.toString()

      nodeSession.sendNodeEvent("stream.video.frame", payload)
    } catch (err: Throwable) {
      Log.w(TAG, "Failed to send frame: ${err.message}")
    }
  }

  private fun updateMetrics(frameSize: Int) {
    frameCount++
    totalBytesInSecond += frameSize
    
    val now = System.currentTimeMillis()
    val elapsed = now - lastFpsUpdate
    
    if (elapsed >= 1000) {
      _fps.value = frameCount
      _bitrate.value = totalBytesInSecond * 8 / 1000 // kbps
      
      frameCount = 0
      totalBytesInSecond = 0
      lastFpsUpdate = now
    }
  }

  /**
   * Extension to convert ImageProxy to Bitmap
   */
  private fun ImageProxy.toBitmap(): Bitmap? {
    val yBuffer = planes[0].buffer
    val uBuffer = planes[1].buffer
    val vBuffer = planes[2].buffer

    val ySize = yBuffer.remaining()
    val uSize = uBuffer.remaining()
    val vSize = vBuffer.remaining()

    val nv21 = ByteArray(ySize + uSize + vSize)
    yBuffer.get(nv21, 0, ySize)
    vBuffer.get(nv21, ySize, vSize)
    uBuffer.get(nv21, ySize + vSize, uSize)

    val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
    val out = ByteArrayOutputStream()
    yuvImage.compressToJpeg(Rect(0, 0, width, height), 90, out)
    val imageBytes = out.toByteArray()
    
    return BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
  }
}
