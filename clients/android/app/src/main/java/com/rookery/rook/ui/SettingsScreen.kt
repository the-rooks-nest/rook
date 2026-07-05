// Mirrors clients/iphone/Sources/Views/SettingsScreen.swift — Server + Location cards.
// ponytail: the Voice card is dropped (voice is a later phase). Android adds a "prominent
// disclosure" dialog before requesting ACCESS_BACKGROUND_LOCATION (Play Store policy) — this
// has no iOS equivalent.
package com.rookery.rook.ui

import android.content.Context
import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rookery.rook.RookViewModel
import com.rookery.rook.ServerState
import com.rookery.rook.location.LocationAuthStatus
import com.rookery.rook.location.RecordingInfo
import androidx.compose.ui.text.font.FontFamily
import com.rookery.rook.ui.chat.PanelButton
import com.rookery.rook.ui.chat.PanelCard
import com.rookery.rook.ui.chat.PanelPalette
import com.rookery.rook.ui.chat.StatusDot
import kotlinx.coroutines.flow.MutableStateFlow

@Composable
fun SettingsScreen(viewModel: RookViewModel) {
    val serverState by viewModel.serverState.collectAsState()
    val serverError by viewModel.serverError.collectAsState()
    val authStatus by remember {
        viewModel.locationAuthStatus ?: MutableStateFlow(LocationAuthStatus.DENIED)
    }.collectAsState()

    val recording by remember { viewModel.recording ?: MutableStateFlow<RecordingInfo?>(null) }.collectAsState()

    var serverDraft by remember { mutableStateOf(viewModel.baseUrlString) }
    var tokenDraft by remember { mutableStateOf(viewModel.currentAuthToken) }
    var showDisclosure by remember { mutableStateOf(false) }

    val fineLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        viewModel.refreshAuthorizationStatus()
        if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        ) {
            viewModel.enableLocation()
        }
    }
    val backgroundLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { viewModel.refreshAuthorizationStatus() }
    // Pre-10 needs WRITE_EXTERNAL_STORAGE to write to public Downloads; 10+ uses MediaStore.
    val writeLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) viewModel.startRecording() }

    SheetScaffold(title = "Settings", onClose = { viewModel.setShowSettings(false) }) {
        // MARK: Server
        PanelCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Server", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal)
                Spacer(Modifier.weight(1f))
                Text(serverStatusLabel(serverState), fontSize = 11.sp, color = PanelPalette.textMuted)
                Spacer(Modifier.width(6.dp))
                StatusDot(serverStatusTint(serverState))
            }
            OutlinedTextField(
                value = serverDraft,
                onValueChange = { serverDraft = it },
                label = { Text("http://10.0.2.2:3000") },
                singleLine = true,
                colors = darkFieldColors(),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = tokenDraft,
                onValueChange = { tokenDraft = it },
                label = { Text("Bearer token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                colors = darkFieldColors(),
                modifier = Modifier.fillMaxWidth()
            )
            if (serverError.isNotEmpty()) {
                Text(serverError, fontSize = 11.sp, color = PanelPalette.danger)
            }
            Text(
                "On a device, use a hostname or IP your phone can reach. If the server needs a bearer token, every request must send it.",
                fontSize = 11.sp,
                color = PanelPalette.textMuted
            )
            PanelButton(
                text = "Save & reconnect",
                onClick = { viewModel.setServerConnection(serverDraft, tokenDraft) },
                modifier = Modifier.fillMaxWidth(),
                enabled = serverDraft.trim() != viewModel.baseUrlString || tokenDraft.trim() != viewModel.currentAuthToken
            )
        }

        // MARK: Location
        PanelCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Location", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal)
                Spacer(Modifier.weight(1f))
                Text(locationStatusLabel(authStatus), fontSize = 11.sp, color = locationStatusTint(authStatus))
            }
            Text(
                "Rook loads a place's skills when you arrive. Background arrivals (app closed) need the “allow all the time” permission.",
                fontSize = 11.sp,
                color = PanelPalette.textMuted
            )
            when (authStatus) {
                LocationAuthStatus.DENIED -> PanelButton(
                    text = "Enable location",
                    onClick = { fineLauncher.launch(foregroundPermissions()) },
                    modifier = Modifier.fillMaxWidth()
                )
                LocationAuthStatus.FOREGROUND -> PanelButton(
                    text = "Allow all the time (background)",
                    onClick = { showDisclosure = true },
                    modifier = Modifier.fillMaxWidth(),
                    tint = PanelPalette.warning
                )
                LocationAuthStatus.BACKGROUND -> {
                    Text("Detecting places in the background.", fontSize = 11.sp, color = PanelPalette.success)
                    PanelButton(
                        text = "Turn off",
                        onClick = { viewModel.disableLocation() },
                        modifier = Modifier.fillMaxWidth(),
                        tint = PanelPalette.danger,
                        filled = false
                    )
                }
            }
            Text("Define places with the map-pin button on the agent list.", fontSize = 11.sp, color = PanelPalette.textMuted)
        }


        // MARK: Background Usage
        BackgroundUsageCard()
        // MARK: Record (accel + GPS capture for tuning the movement classifier)
        PanelCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Record motion test", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal)
                Spacer(Modifier.weight(1f))
                if (recording != null) StatusDot(PanelPalette.danger)
            }
            Text(
                "Continuously logs accelerometer + GPS to a CSV in Downloads/Rook — a new file each " +
                    "time — real sensor data for tuning movement detection.",
                fontSize = 11.sp,
                color = PanelPalette.textMuted
            )
            val active = recording
            if (active == null) {
                PanelButton(
                    text = "Start recording",
                    onClick = {
                        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                            writeLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        } else {
                            viewModel.startRecording()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = authStatus != LocationAuthStatus.DENIED
                )
                if (authStatus == LocationAuthStatus.DENIED) {
                    Text("Enable location first.", fontSize = 11.sp, color = PanelPalette.warning)
                }
            } else {
                Text(
                    active.filePath,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    color = PanelPalette.textMuted
                )
                PanelButton(
                    text = "Stop recording",
                    onClick = { viewModel.stopRecording() },
                    modifier = Modifier.fillMaxWidth(),
                    tint = PanelPalette.danger,
                    filled = false
                )
            }
        }

    }

    if (showDisclosure) {
        BackgroundLocationDisclosureDialog(
            onConfirm = {
                showDisclosure = false
                backgroundLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            },
            onDismiss = { showDisclosure = false }
        )
    }
}

// Play Store prominent-disclosure — must be shown before the system background prompt.
@Composable
private fun BackgroundLocationDisclosureDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Background location") },
        text = {
            Text(
                "Rook collects location in the background — even when the app is closed — to detect when " +
                    "you arrive at a saved place and load that place's skills. Location is sent only to your " +
                    "own Rook server. Choose “Allow all the time” on the next screen to enable this."
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Continue") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Not now") } }
    )
}

private fun foregroundPermissions(): Array<String> {
    val base = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        (base + Manifest.permission.POST_NOTIFICATIONS).toTypedArray()
    } else {
        base.toTypedArray()
    }
}

@Composable
private fun darkFieldColors() = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
    focusedTextColor = PanelPalette.textNormal,
    unfocusedTextColor = PanelPalette.textNormal,
    focusedBorderColor = PanelPalette.accent,
    unfocusedBorderColor = PanelPalette.border,
    focusedLabelColor = PanelPalette.textMuted,
    unfocusedLabelColor = PanelPalette.textMuted,
    cursorColor = PanelPalette.accent
)

private fun serverStatusLabel(state: ServerState): String = when (state) {
    ServerState.ONLINE -> "Online"
    ServerState.OFFLINE -> "Offline"
    ServerState.UNAUTHORIZED -> "Unauthorized"
    ServerState.UNKNOWN -> "…"
}

private fun serverStatusTint(state: ServerState): Color = when (state) {
    ServerState.ONLINE -> PanelPalette.success
    ServerState.OFFLINE -> PanelPalette.danger
    ServerState.UNAUTHORIZED -> PanelPalette.warning
    ServerState.UNKNOWN -> PanelPalette.textMuted
}

private fun locationStatusLabel(status: LocationAuthStatus): String = when (status) {
    LocationAuthStatus.BACKGROUND -> "Always"
    LocationAuthStatus.FOREGROUND -> "While Using"
    LocationAuthStatus.DENIED -> "Not set"
}

private fun locationStatusTint(status: LocationAuthStatus): Color = when (status) {
    LocationAuthStatus.BACKGROUND -> PanelPalette.success
    LocationAuthStatus.FOREGROUND -> PanelPalette.warning
    LocationAuthStatus.DENIED -> PanelPalette.textMuted
}

@Composable
private fun BackgroundUsageCard() {
    val context = LocalContext.current
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val isExempt = pm.isIgnoringBatteryOptimizations(context.packageName)

    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Background Usage", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal)
            Spacer(Modifier.weight(1f))
            Text(
                if (isExempt) "Enabled" else "Restricted",
                fontSize = 11.sp,
                color = if (isExempt) PanelPalette.success else PanelPalette.warning
            )
        }
        Text(
            if (isExempt) "Rook can run in the background — the server connection stays alive."
            else "Android may suspend Rook in the background. Allow background activity to keep the server connection alive.",
            fontSize = 11.sp,
            color = PanelPalette.textMuted
        )
        PanelButton(
            text = if (isExempt) "App settings" else "Allow background activity",
            onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                context.startActivity(intent)
            },
            modifier = Modifier.fillMaxWidth(),
            tint = if (isExempt) PanelPalette.accent else PanelPalette.warning
        )
    }
}
