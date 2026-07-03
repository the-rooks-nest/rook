// Mirrors clients/iphone/Sources/Views/RootView.swift
//
// ponytail: PanelBackground, the EnvironmentOffer sheet, and the Places sheet are dropped —
// environment offers and Places are later phases (location→skills phase per goal.md).
package com.rookery.rook

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.rookery.rook.ui.AgentPickerScreen
import com.rookery.rook.ui.ChatScreen
import com.rookery.rook.ui.SessionsScreen
import com.rookery.rook.ui.chat.PanelPalette

@Composable
fun RookApp(viewModel: RookViewModel) {
    LaunchedEffect(Unit) { viewModel.start() }

    val selectedAgentId by viewModel.selectedAgentId.collectAsState()
    val currentSession by viewModel.currentSession.collectAsState()
    val chatVisible by viewModel.chatVisible.collectAsState()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(PanelPalette.backgroundPrimary)
    ) {
        when {
            currentSession != null && chatVisible -> ChatScreen(viewModel)
            selectedAgentId != null -> SessionsScreen(viewModel)
            else -> AgentPickerScreen(viewModel)
        }
    }
}
