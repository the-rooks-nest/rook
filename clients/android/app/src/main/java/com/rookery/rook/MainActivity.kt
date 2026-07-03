package com.rookery.rook

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rookery.rook.ui.theme.RookTheme

// Mirrors clients/iphone/Sources/Views/RootView.swift (navigation host, wired up by RookApp.kt)
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            RookTheme {
                val viewModel: RookViewModel = viewModel()
                RookApp(viewModel)
            }
        }
    }
}
