// Mirrors clients/iphone/Sources/Views/ChatScreen.swift
//
// ponytail: mic/voice controls (toggleVoiceListening, voiceListening, voicePartial,
// stopSpeaking, voiceSpeaking) and PlaceCaption are dropped — voice and location are later
// phases per goal.md's build order (protocol → chat → location→skills → voice → ...). The
// empty-state RookMark image is replaced with a plain glyph since there's no Android asset
// for it yet.
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rookery.rook.RookViewModel
import com.rookery.rook.ui.chat.ChatBlockView
import com.rookery.rook.ui.chat.PanelPalette
import com.rookery.rook.ui.chat.StatusLineDot

@Composable
fun ChatScreen(viewModel: RookViewModel) {
    val currentSession by viewModel.currentSession.collectAsState()
    val blocks by viewModel.blocks.collectAsState()
    val queuedMessages by viewModel.queuedMessages.collectAsState()
    val isRunning by viewModel.isRunning.collectAsState()
    val statusLine by viewModel.statusLine.collectAsState()
    val socketConnected by viewModel.socketConnected.collectAsState()
    val reconnecting by viewModel.reconnecting.collectAsState()
    val contextUsage by viewModel.contextUsage.collectAsState()
    var draft by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PanelPalette.backgroundPrimary)
    ) {
        ChatHeader(
            agentName = currentSession?.agent ?: "Rook",
            sessionName = currentSession?.name?.takeIf { it != "default" },
            contextUsage = contextUsage,
            onBack = viewModel::leaveChat
        )
        HorizontalDivider(color = PanelPalette.border)

        ChatThread(blocks = blocks, modifier = Modifier.weight(1f))

        StatusRow(
            isRunning = isRunning,
            reconnecting = reconnecting,
            socketConnected = socketConnected,
            statusLine = statusLine,
            onStop = viewModel::stopAgent
        )
        QueuedBar(messages = queuedMessages, onRemove = viewModel::removeQueuedMessage)
        Composer(
            draft = draft,
            onDraftChange = { draft = it },
            placeholder = "Message ${currentSession?.agent ?: "agent"}…",
            isRunning = isRunning,
            onSubmit = {
                val text = draft
                draft = ""
                viewModel.send(text)
            }
        )
    }
}

@Composable
private fun ChatHeader(agentName: String, sessionName: String?, contextUsage: Pair<Int, Int>?, onBack: () -> Unit) {
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
        Column(modifier = Modifier.weight(1f)) {
            Text(agentName, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.textNormal, maxLines = 1)
            if (sessionName != null) {
                Text(sessionName, fontSize = 12.sp, color = PanelPalette.textMuted)
            }
        }
        if (contextUsage != null && contextUsage.second > 0) {
            Text(
                text = "ctx ${compactCount(contextUsage.first)}/${compactCount(contextUsage.second)}",
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = PanelPalette.textMuted
            )
        }
    }
}

private fun compactCount(value: Int): String = when {
    value >= 1_000_000 -> "%.1fM".format(value / 1_000_000.0)
    value >= 1_000 -> "%.1fk".format(value / 1_000.0)
    else -> value.toString()
}

@Composable
private fun ChatThread(blocks: List<com.rookery.rook.model.ChatBlock>, modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()
    LaunchedEffect(blocks.size) {
        if (blocks.isNotEmpty()) listState.animateScrollToItem(blocks.size - 1)
    }

    if (blocks.isEmpty()) {
        Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("✦", fontSize = 28.sp, color = PanelPalette.textMuted)
                Text(
                    text = "Say something to your agent",
                    fontSize = 15.sp,
                    color = PanelPalette.textMuted,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    } else {
        LazyColumn(
            state = listState,
            modifier = modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)
        ) {
            itemsIndexed(blocks, key = { _, block -> block.id }) { index, block ->
                ChatBlockView(block = block, modifier = Modifier.padding(bottom = if (index < blocks.size - 1) 10.dp else 0.dp))
            }
        }
    }
}

@Composable
private fun StatusRow(isRunning: Boolean, reconnecting: Boolean, socketConnected: Boolean, statusLine: String, onStop: () -> Unit) {
    val tint = when {
        reconnecting || !socketConnected -> PanelPalette.danger
        isRunning -> PanelPalette.warning
        else -> PanelPalette.success
    }
    val text = when {
        reconnecting -> "Reconnecting…"
        !socketConnected -> "Disconnected"
        isRunning -> statusLine.ifEmpty { "Working…" }
        else -> "Ready"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    ) {
        StatusLineDot(tint = tint, pulsing = isRunning || reconnecting)
        Text(text, fontSize = 12.sp, color = tint, maxLines = 1, modifier = Modifier.weight(1f))
        if (isRunning) {
            Text(
                text = "Stop",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = Color.White,
                modifier = Modifier
                    .clip(RoundedCornerShape(percent = 50))
                    .background(PanelPalette.danger)
                    .clickable(onClick = onStop)
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            )
        }
    }
}

@Composable
private fun QueuedBar(messages: List<String>, onRemove: (Int) -> Unit) {
    if (messages.isEmpty()) return
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = PaddingValues(horizontal = 12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 2.dp)
    ) {
        itemsIndexed(messages) { index, message ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .clip(RoundedCornerShape(percent = 50))
                    .background(PanelPalette.backgroundPrimary.copy(alpha = 0.8f))
                    .border(1.dp, PanelPalette.border, RoundedCornerShape(percent = 50))
                    .padding(start = 9.dp, end = 6.dp, top = 5.dp, bottom = 5.dp)
            ) {
                Text("⏱", fontSize = 10.sp, color = PanelPalette.textMuted)
                Text(message, fontSize = 12.sp, color = PanelPalette.textNormal, maxLines = 1)
                Text(
                    text = "✕",
                    fontSize = 11.sp,
                    color = PanelPalette.textMuted,
                    modifier = Modifier.clickable { onRemove(index) }
                )
            }
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    isRunning: Boolean,
    onSubmit: () -> Unit
) {
    val canSend = draft.isNotBlank()
    Row(
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 38.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(PanelPalette.backgroundPrimary.copy(alpha = 0.8f))
                .border(1.dp, PanelPalette.border, RoundedCornerShape(18.dp))
                .padding(horizontal = 12.dp, vertical = 9.dp)
        ) {
            BasicTextField(
                value = draft,
                onValueChange = onDraftChange,
                textStyle = TextStyle(color = PanelPalette.textNormal, fontSize = 15.sp),
                cursorBrush = SolidColor(PanelPalette.accent),
                decorationBox = { inner ->
                    if (draft.isEmpty()) {
                        Text(placeholder, color = PanelPalette.textMuted, fontSize = 15.sp)
                    }
                    inner()
                }
            )
        }
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(PanelPalette.accent)
                .alpha(if (canSend) 1f else 0.5f)
                .clickable(enabled = canSend, onClick = onSubmit),
            contentAlignment = Alignment.Center
        ) {
            Text(if (isRunning) "⇩" else "↑", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }
    }
}
