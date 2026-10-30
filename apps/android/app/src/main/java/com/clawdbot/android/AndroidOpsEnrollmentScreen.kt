package com.clawdbot.android

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.NetworkInterface
import java.util.Collections

private val jsonType = "application/json; charset=utf-8".toMediaType()

private data class EnrollmentUiState(
  val loading: Boolean = true,
  val title: String = "Registering phone...",
  val detail: String = "Connecting this phone to Android Social Ops.",
  val adbSerial: String? = null,
  val tailscaleIp: String? = null,
  val registered: Boolean = false,
)

@Composable
fun AndroidOpsEnrollmentScreen(dashboardUrl: String) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val dashboardPageUrl = remember(dashboardUrl) { normalizedDashboardPageUrl(dashboardUrl) }
  var state by remember { mutableStateOf(EnrollmentUiState()) }

  fun runEnrollment() {
    state = state.copy(loading = true, title = "Registering phone...")
    scope.launch {
      state =
        try {
          enrollWithDashboard(context, dashboardUrl)
        } catch (e: Exception) {
          EnrollmentUiState(
            loading = false,
            title = "Registration failed",
            detail = e.message ?: "Unknown enrollment error.",
          )
        }
    }
  }

  LaunchedEffect(dashboardUrl) { runEnrollment() }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(
          Brush.verticalGradient(
            colors = listOf(Color(0xFF050403), Color(0xFF171006), Color(0xFF050403)),
          ),
        )
        .verticalScroll(rememberScrollState())
        .padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Text(
      text = "Android Social Ops",
      color = Color(0xFFFFE2A0),
      style = MaterialTheme.typography.headlineMedium,
      fontWeight = FontWeight.Black,
    )
    Text(
      text = "Companion setup for this phone",
      color = Color(0xFFB7AC96),
      style = MaterialTheme.typography.bodyLarge,
    )

    Card(
      colors = CardDefaults.cardColors(containerColor = Color(0xFF17120B)),
      shape = RoundedCornerShape(22.dp),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = state.title, color = Color.White, fontWeight = FontWeight.Bold)
        Text(text = state.detail, color = Color(0xFFD3C3A1))
        if (state.adbSerial != null) Text(text = "ADB target: ${state.adbSerial}", color = Color(0xFFFFE2A0))
        if (state.tailscaleIp != null) Text(text = "Tailnet IP: ${state.tailscaleIp}", color = Color(0xFFFFE2A0))
      }
    }

    Card(
      colors = CardDefaults.cardColors(containerColor = Color(0xFF100D08)),
      shape = RoundedCornerShape(22.dp),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "What the APK completed", color = Color.White, fontWeight = FontWeight.Bold)
        Text(text = "1. Found phone model and Android version.", color = Color(0xFFD3C3A1))
        Text(text = "2. Detected the Tailscale 100.x IP when available.", color = Color(0xFFD3C3A1))
        Text(text = "3. Registered this phone with the dashboard.", color = Color(0xFFD3C3A1))
      }
    }

    Card(
      colors = CardDefaults.cardColors(containerColor = Color(0xFF100D08)),
      shape = RoundedCornerShape(22.dp),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Android-controlled steps", color = Color.White, fontWeight = FontWeight.Bold)
        Text(text = "Install/sign in to Tailscale, then enable Developer Options and wireless or USB debugging. Android requires a human to approve those security prompts.", color = Color(0xFFD3C3A1))
      }
    }

    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
      Button(onClick = { runEnrollment() }, enabled = !state.loading, modifier = Modifier.weight(1f)) {
        Text("Retry")
      }
      OutlinedButton(onClick = { openUrl(context, dashboardPageUrl) }, modifier = Modifier.weight(1f)) {
        Text("Dashboard")
      }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
      OutlinedButton(onClick = { openTailscale(context) }, modifier = Modifier.weight(1f)) {
        Text("Tailscale")
      }
      OutlinedButton(onClick = { openDeveloperOptions(context) }, modifier = Modifier.weight(1f)) {
        Text("ADB Settings")
      }
    }
    Spacer(modifier = Modifier.height(12.dp))
  }
}

private suspend fun enrollWithDashboard(context: Context, dashboardUrl: String): EnrollmentUiState =
  withContext(Dispatchers.IO) {
    val serverBaseUrl = normalizedServerBaseUrl(dashboardUrl)
    val tailnetIp = findTailnetIp()
    val androidId =
      Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
    if (androidId.isBlank()) throw IllegalStateException("This phone did not report an ANDROID_ID.")
    val enrollToken = BuildConfig.ANDROID_OPS_ENROLL_TOKEN.trim()
    val model = listOf(Build.MANUFACTURER, Build.MODEL).joinToString(" ").trim()
    val body =
      JSONObject()
        .put("actor", "android-ops-apk")
        .put("label", model.ifBlank { "Android Phone" })
        .put("model", model.ifBlank { "unknown" })
        .put("manufacturer", Build.MANUFACTURER)
        .put("androidVersion", Build.VERSION.RELEASE ?: "unknown")
        .put("sdkInt", Build.VERSION.SDK_INT)
        .put("androidId", androidId)
        .put("tailscaleIp", tailnetIp ?: "")
        .put("appVersion", appVersion(context))
        .put("enrollToken", enrollToken)

    val endpoint = serverBaseUrl + "/api/companion/enroll"
    val request =
      Request.Builder()
        .url(endpoint)
        .header("X-Android-Ops-Enroll-Token", enrollToken)
        .post(body.toString().toRequestBody(jsonType))
        .build()

    OkHttpClient.Builder().build().newCall(request).execute().use { response ->
      val raw = response.body.string()
      if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}: $raw")
      val parsed = JSONObject(raw)
      if (!parsed.optBoolean("ok")) {
        throw IllegalStateException(parsed.optString("reason", "Dashboard rejected enrollment."))
      }
      EnrollmentUiState(
        loading = false,
        title = "Phone registered",
        detail = parsed.optString("note", "This phone is connected to Android Social Ops."),
        adbSerial = parsed.optString("adbSerial").ifBlank { null },
        tailscaleIp = parsed.optString("tailscaleIp").ifBlank { null },
        registered = true,
      )
    }
  }

private fun normalizedServerBaseUrl(input: String): String {
  return input.trim().trimEnd('/').removeSuffix("/android-ops")
}

private fun normalizedDashboardPageUrl(input: String): String {
  val base = normalizedServerBaseUrl(input)
  return "$base/android-ops"
}

private fun findTailnetIp(): String? {
  val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
  for (networkInterface in interfaces) {
    val addresses = Collections.list(networkInterface.inetAddresses)
    for (address in addresses) {
      val ip = address.hostAddress ?: continue
      if (!address.isLoopbackAddress && ip.startsWith("100.") && !ip.contains(":")) return ip
    }
  }
  return null
}

private fun appVersion(context: Context): String {
  val packageManager = context.packageManager
  val info =
    if (Build.VERSION.SDK_INT >= 33) {
      packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      packageManager.getPackageInfo(context.packageName, 0)
    }
  return info.versionName ?: "unknown"
}

private fun openUrl(context: Context, url: String) {
  context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

private fun openTailscale(context: Context) {
  val launch = context.packageManager.getLaunchIntentForPackage("com.tailscale.ipn")
  if (launch != null) {
    context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    return
  }
  openUrl(context, "https://play.google.com/store/apps/details?id=com.tailscale.ipn")
}

private fun openDeveloperOptions(context: Context) {
  val intent =
    Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  context.startActivity(intent)
}
