// Mirrors clients/iphone/Sources/Views/SessionsScreen.swift
package com.rookery.rook.ui

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rookery.rook.RookViewModel
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.ui.chat.PanelPalette

@Composable
fun SessionsScreen(viewModel: RookViewModel) {
    val agentId by viewModel.selectedAgentId.collectAsState()
    val id = agentId ?: return
    val sessions by viewModel.sessions.collectAsState()
    val sessionsLoading by viewModel.sessionsLoading.collectAsState()
    val sessionsError by viewModel.sessionsError.collectAsState()
    val startingSession by viewModel.startingSession.collectAsState()
    var newSessionName by remember(id) { mutableStateOf("") }

    fun startNew() {
        if (startingSession) return
        viewModel.startNewSession(id, newSessionName)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PanelPalette.backgroundPrimary)
    ) {
        SessionsHeader(agentId = id, sessions = sessions, sessionsLoading = sessionsLoading, onBack = viewModel::closeAgentSessions)

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            PanelCardColumn {
                Text(
                    text = "New chat",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = PanelPalette.textNormal
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    NewChatNameField(
                        value = newSessionName,
                        onValueChange = { newSessionName = it },
                        onSubmit = ::startNew,
                        modifier = Modifier.weight(1f)
                    )
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(CircleShape)
                            .background(PanelPalette.accent)
                            .clickable(enabled = !startingSession) { startNew() },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = if (startingSession) "…" else "↑",
                            color = Color.White,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }

            PanelCardColumn {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = "Previous sessions",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = PanelPalette.textNormal,
                        modifier = Modifier.weight(1f)
                    )
                    if (sessionsLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = PanelPalette.textMuted)
                    }
                }

                if (sessionsError.isNotEmpty()) {
                    Text(sessionsError, fontSize = 12.sp, color = PanelPalette.warning)
                }

                if (sessions.isEmpty() && !sessionsLoading) {
                    Text(
                        text = "No sessions yet — start a new chat above.",
                        fontSize = 14.sp,
                        color = PanelPalette.textMuted,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 24.dp)
                    )
                } else {
                    sessions.forEachIndexed { index, session ->
                        SessionRow(
                            session = session,
                            enabled = !startingSession,
                            onClick = { viewModel.resumeSession(session) }
                        )
                        if (index < sessions.size - 1) {
                            HorizontalDivider(color = PanelPalette.border)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionsHeader(agentId: String, sessions: List<AgentSessionSummary>, sessionsLoading: Boolean, onBack: () -> Unit) {
    val subtitle = when {
        sessionsLoading && sessions.isEmpty() -> "Loading sessions…"
        sessions.isEmpty() -> "New conversation"
        else -> "${sessions.size} past session${if (sessions.size == 1) "" else "s"}"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp)
    ) {
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(CircleShape)
                .background(Color.White.copy(alpha = 0.08f))
                .clickable(onClick = onBack),
            contentAlignment = Alignment.Center
        ) {
            Text("‹", color = PanelPalette.textNormal, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Box(
            modifier = Modifier.size(28.dp).clip(CircleShape).background(PanelPalette.info.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center
        ) {
            Text("✦", fontSize = 12.sp, color = PanelPalette.info)
        }
        Column {
            Text(agentId, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal, maxLines = 1)
            Text(subtitle, fontSize = 12.sp, color = PanelPalette.textMuted)
        }
    }
}

@Composable
private fun NewChatNameField(value: String, onValueChange: (String) -> Unit, onSubmit: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(PanelPalette.backgroundPrimary.copy(alpha = 0.8f))
            .border(1.dp, PanelPalette.border, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp)
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = TextStyle(color = PanelPalette.textNormal, fontSize = 15.sp),
            cursorBrush = SolidColor(PanelPalette.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { onSubmit() }),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text("Name (optional)", color = PanelPalette.textMuted, fontSize = 15.sp)
                }
                inner()
            }
        )
    }
}

@Composable
private fun SessionRow(session: AgentSessionSummary, enabled: Boolean, onClick: () -> Unit) {
    val tint = if (session.running) PanelPalette.success else PanelPalette.textMuted
    val statusLabel = if (session.running) {
        if (session.connectedClients > 0) "${session.connectedClients} live" else "Running"
    } else {
        "Stopped"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 9.dp)
    ) {
        Box(
            modifier = Modifier.size(30.dp).clip(CircleShape).background(tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center
        ) {
            Text(if (session.running) "⚡" else "☾", fontSize = 12.sp, color = tint)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(session.name, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = PanelPalette.textNormal, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (session.createdAtLabel.isNotEmpty()) {
                Text(session.createdAtLabel, fontSize = 12.sp, color = PanelPalette.textMuted, maxLines = 1)
            }
        }
        Text(
            text = statusLabel,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color.White.copy(alpha = 0.95f),
            modifier = Modifier
                .clip(RoundedCornerShape(percent = 50))
                .background(tint.copy(alpha = 0.25f))
                .padding(horizontal = 8.dp, vertical = 3.dp)
        )
        Text("›", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = PanelPalette.textMuted)
    }
}

// Mirrors PanelCard (PanelComponents.swift) — not ported as a shared composable since
// SessionsScreen is its only caller today; promote alongside MessageBanner
// (ui/AgentPickerScreen.kt) if a third screen needs card chrome.
@Composable
private fun PanelCardColumn(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelPalette.backgroundSecondary)
            .border(1.dp, PanelPalette.border, RoundedCornerShape(12.dp))
            .padding(14.dp),
        content = content
    )
}
