// Mirrors PanelPalette (clients/RookKit/Sources/RookKit/Design/PanelComponents.swift)
//
// ponytail: only PanelPalette is ported here — the rest of the Swift file (PanelBackground,
// PanelCard, StatusGlyph/StatusDot, CompactActionButton, FooterIconButton, PanelMessageView,
// hover/cursor modifiers, inlineMarkdown) is macOS menu-bar chrome or hover-only concerns that
// chat block rendering doesn't need. Add an equivalent if a later screen (AgentPicker/Sessions)
// needs one of these.
package com.rookery.rook.ui.chat

import androidx.compose.ui.graphics.Color

object PanelPalette {
    val accent = Color(red = 0.486f, green = 0.227f, blue = 0.929f) // #7c3aed
    val accentHover = Color(red = 0.545f, green = 0.361f, blue = 0.965f) // #8b5cf6
    val backgroundPrimary = Color(red = 0.098f, green = 0.078f, blue = 0.122f) // #19141f
    val backgroundSecondary = Color(red = 0.137f, green = 0.110f, blue = 0.176f) // #231c2d
    val border = Color(red = 0.239f, green = 0.192f, blue = 0.302f) // #3d314d
    val hover = Color(red = 0.184f, green = 0.149f, blue = 0.231f) // #2f263b
    val textNormal = Color(red = 0.929f, green = 0.914f, blue = 0.961f) // #ede9f5
    val textMuted = Color(red = 0.710f, green = 0.663f, blue = 0.788f) // #b5a9c9

    val success = Color(red = 0.624f, green = 0.941f, blue = 0.706f) // #9ff0b4
    val warning = Color(red = 0.973f, green = 0.831f, blue = 0.467f) // #f8d477
    val danger = Color(red = 1.0f, green = 0.612f, blue = 0.639f) // #ff9ca3
    val info = accent
    val secondaryText = textMuted

    // color-mix(in srgb, accent 35%, background-primary) — thinking bubble.
    val thinkingFill = Color(red = 0.234f, green = 0.131f, blue = 0.404f)
}
