// Mirrors clients/iphone/Sources/Views/AgentPickerScreen.swift
//
// ponytail: RookHeader/PlaceCaption (location banner) and the Settings/Places sheets are
// dropped — location and settings/places screens are out of scope until their own phases
// (goal.md build order: protocol → chat → location→skills → ...). The offline banner's
// text also drops Swift's "tap the gear to change the address" clause since there's no
// Settings screen yet to reference.
package com.rookery.rook.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rookery.rook.RookViewModel
import com.rookery.rook.ServerState
import com.rookery.rook.buildAgentTree
import com.rookery.rook.model.AgentDefinition
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.ui.chat.PanelPalette

@Composable
fun AgentPickerScreen(viewModel: RookViewModel) {
    val serverState by viewModel.serverState.collectAsState()
    val agents by viewModel.agents.collectAsState()
    val agentsError by viewModel.agentsError.collectAsState()
    val currentSession by viewModel.currentSession.collectAsState()
    val chatVisible by viewModel.chatVisible.collectAsState()
    val isRunning by viewModel.isRunning.collectAsState()
    val startingSession by viewModel.startingSession.collectAsState()
    val agentTree = remember(agents) { buildAgentTree(agents) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PanelPalette.backgroundPrimary)
    ) {
        Text(
            text = "Rook",
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = PanelPalette.textNormal,
            modifier = Modifier.padding(16.dp)
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (serverState == ServerState.OFFLINE) {
                item {
                    MessageBanner(
                        tint = PanelPalette.danger,
                        text = "Server unreachable at ${viewModel.baseUrlString}. Run `npm run dev` on the host."
                    )
                }
            }

            if (currentSession != null && !chatVisible) {
                item {
                    ResumeRow(session = currentSession!!, isRunning = isRunning, onClick = viewModel::openChat)
                }
            }

            item {
                Text(
                    text = "CHAT WITH",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.6.sp,
                    color = PanelPalette.textMuted,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
            }

            if (agentTree.isEmpty()) {
                item {
                    Text(
                        text = if (serverState == ServerState.ONLINE) "No agents registered" else "Waiting for the server…",
                        fontSize = 15.sp,
                        color = PanelPalette.textMuted
                    )
                }
            } else {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(PanelPalette.backgroundSecondary)
                            .border(1.dp, PanelPalette.border, RoundedCornerShape(12.dp))
                            .padding(vertical = 4.dp)
                    ) {
                        agentTree.forEachIndexed { index, entry ->
                            val (agent, depth) = entry
                            AgentRow(
                                agent = agent,
                                depth = depth,
                                enabled = !startingSession,
                                onClick = { viewModel.openAgentSessions(agent.id) }
                            )
                            if (index < agentTree.size - 1) {
                                HorizontalDivider(
                                    color = PanelPalette.border,
                                    modifier = Modifier.padding(start = 16.dp)
                                )
                            }
                        }
                    }
                }
            }

            if (agentsError.isNotEmpty()) {
                item { MessageBanner(tint = PanelPalette.warning, text = agentsError) }
            }
        }
    }
}

@Composable
private fun ResumeRow(session: AgentSessionSummary, isRunning: Boolean, onClick: () -> Unit) {
    val resumeLine = if (session.name == "default") session.agent else "${session.agent} · ${session.name}"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelPalette.accent.copy(alpha = 0.14f))
            .border(1.dp, PanelPalette.accent.copy(alpha = 0.4f), RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp)
    ) {
        Box(
            modifier = Modifier.size(32.dp).clip(CircleShape).background(PanelPalette.accent),
            contentAlignment = Alignment.Center
        ) {
            Text("▶", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text("Resume chat", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal)
            Text(
                text = resumeLine,
                fontSize = 12.sp,
                color = PanelPalette.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (isRunning) {
            Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(PanelPalette.warning))
        }
        Text("›", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = PanelPalette.textMuted)
    }
}

@Composable
private fun AgentRow(agent: AgentDefinition, depth: Int, enabled: Boolean, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(start = 12.dp + (depth * 16).dp, end = 12.dp, top = 10.dp, bottom = 10.dp)
    ) {
        Box(
            modifier = Modifier.size(24.dp).clip(CircleShape).background(PanelPalette.info.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center
        ) {
            Text(if (depth > 0) "◆" else "✦", fontSize = 11.sp, color = PanelPalette.info)
        }
        Text(
            text = agent.id,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            color = PanelPalette.textNormal,
            modifier = Modifier.weight(1f)
        )
        Text("›", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = PanelPalette.textMuted)
    }
}

// Mirrors PanelMessageView(systemImage:tint:text:) (PanelComponents.swift) — not ported as
// a shared composable since AgentPickerScreen is its only caller today; inline here and
// promote to ui/chat/PanelComponents.kt if a second screen needs it.
@Composable
private fun MessageBanner(tint: Color, text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(tint.copy(alpha = 0.12f))
            .padding(12.dp)
    ) {
        Text("!", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Text(text, fontSize = 12.sp, color = PanelPalette.textMuted)
    }
}
