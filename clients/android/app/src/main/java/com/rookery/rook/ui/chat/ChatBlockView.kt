// Mirrors clients/RookKit/Sources/RookKit/Design/ChatBlockViews.swift
//
// ponytail: chevron/disclosure/circle glyphs use plain Text characters ("›"/"⌄"/"○")
// instead of material-icons-extended — that library is a few thousand icons just for a
// handful of shapes. CheckCircle/Refresh/List come free from material-icons-core (already
// a transitive dep of material3) and are used where available. Swap the glyphs for real
// icons if material-icons-extended gets added for another reason later.
//
// AssistantText renders plain Text even once streaming is done, not styled Markdown — the
// Phase 2 plan's markdown-renderer dependency has no release compatible with this project's
// Kotlin 2.0.21 / compileSdk 35 toolchain (every maintained tag needs Kotlin 2.2+ /
// compileSdk 36+), so it was dropped rather than bumping the whole toolchain. Revisit if the
// toolchain moves.
//
// ponytail: tool-call titles truncate at the end (TextOverflow.Ellipsis), not the middle
// like Swift's `.truncationMode(.middle)` — Compose Text has no built-in middle-truncation.
package com.rookery.rook.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rookery.rook.model.ChatBlock
import com.rookery.rook.model.ChatBlockKind
import com.rookery.rook.model.PlanEntry
import com.rookery.rook.model.ToolBlockState
import com.rookery.rook.model.ToolBlockStatus

@Composable
fun ChatBlockView(block: ChatBlock, modifier: Modifier = Modifier) {
    when (val kind = block.kind) {
        is ChatBlockKind.User -> UserBlockView(kind.text, modifier)
        is ChatBlockKind.AssistantText -> AssistantTextBlockView(kind.text, kind.streaming, modifier)
        is ChatBlockKind.Thinking -> ThinkingBlockView(kind.text, kind.streaming, modifier)
        is ChatBlockKind.Tool -> ToolBlockView(kind.state, modifier)
        is ChatBlockKind.Error -> ErrorBlockView(kind.source, kind.message, modifier)
        is ChatBlockKind.System -> SystemBlockView(kind.text, modifier)
        is ChatBlockKind.Plan -> PlanBlockView(kind.entries, modifier)
    }
}

// Bubble corners match the web client: user 16/16/4/16, agent 16/16/16/4.
private fun bubbleShape(tailAtBottomEnd: Boolean): RoundedCornerShape = RoundedCornerShape(
    topStart = 16.dp,
    topEnd = 16.dp,
    bottomEnd = if (tailAtBottomEnd) 4.dp else 16.dp,
    bottomStart = if (tailAtBottomEnd) 16.dp else 4.dp
)

private const val COLLAPSED_LINE_LIMIT = 5

private fun estimatedLineCount(text: String): Int {
    val explicitLines = text.split("\n").size
    val wrappedLines = kotlin.math.ceil(text.length / 72.0).toInt()
    return maxOf(explicitLines, wrappedLines)
}

// Reusable "bubble pinned to one edge with a min 48dp gap on the other" row, factoring
// what Swift repeats per-block as `HStack { Spacer(minLength: 48); content }` (or reversed).
@Composable
private fun BubbleRow(alignEnd: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Row(modifier = modifier.fillMaxWidth()) {
        if (alignEnd) Spacer(Modifier.width(48.dp))
        Box(
            modifier = Modifier.weight(1f),
            contentAlignment = if (alignEnd) Alignment.CenterEnd else Alignment.CenterStart
        ) {
            content()
        }
        if (!alignEnd) Spacer(Modifier.width(48.dp))
    }
}

@Composable
private fun DisclosureHeader(
    title: String,
    expanded: Boolean,
    textColor: Color,
    trailingAligned: Boolean,
    onToggle: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (trailingAligned) Spacer(Modifier.weight(1f))
        Text(
            text = title,
            fontSize = 9.5.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = textColor.copy(alpha = 0.85f)
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = if (expanded) "⌄" else "›",
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            color = textColor.copy(alpha = 0.75f)
        )
        if (!trailingAligned) Spacer(Modifier.weight(1f))
    }
}

@Composable
fun StreamingIndicator() {
    val transition = rememberInfiniteTransition(label = "streaming")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.25f,
        animationSpec = infiniteRepeatable(
            animation = tween(600),
            repeatMode = RepeatMode.Reverse
        ),
        label = "streamingAlpha"
    )
    Box(
        modifier = Modifier
            .size(6.dp)
            .clip(CircleShape)
            .background(Color.White.copy(alpha = alpha))
    )
}

// Mirrors StatusLineDot (ChatBlockViews.swift) — used by ChatScreen's status row.
@Composable
fun StatusLineDot(tint: Color, pulsing: Boolean) {
    val transition = rememberInfiniteTransition(label = "statusDot")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(600),
            repeatMode = RepeatMode.Reverse
        ),
        label = "statusDotPhase"
    )
    val animatedAlpha = if (pulsing) 0.35f + phase * 0.65f else 0.85f
    val scale = if (pulsing) 0.9f + phase * 0.25f else 1f
    Box(
        modifier = Modifier
            .size(8.dp * scale)
            .clip(CircleShape)
            .background(tint.copy(alpha = animatedAlpha))
    )
}

@Composable
private fun UserBlockView(text: String, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    val collapsedByDefault = estimatedLineCount(text) > COLLAPSED_LINE_LIMIT

    BubbleRow(alignEnd = true, modifier = modifier) {
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier
                .clip(bubbleShape(tailAtBottomEnd = true))
                .background(PanelPalette.accent)
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            if (collapsedByDefault) {
                DisclosureHeader(
                    title = "MESSAGE",
                    expanded = expanded,
                    textColor = Color.White,
                    trailingAligned = true
                ) { expanded = !expanded }
            }
            SelectionContainer {
                Text(
                    text = text,
                    color = Color.White,
                    fontSize = 15.sp,
                    textAlign = TextAlign.End,
                    maxLines = if (collapsedByDefault && !expanded) COLLAPSED_LINE_LIMIT else Int.MAX_VALUE,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun AssistantTextBlockView(text: String, streaming: Boolean, modifier: Modifier = Modifier) {
    BubbleRow(alignEnd = false, modifier = modifier) {
        Column(
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier
                .clip(bubbleShape(tailAtBottomEnd = false))
                .background(PanelPalette.backgroundPrimary.copy(alpha = 0.75f))
                .border(1.dp, PanelPalette.border, bubbleShape(tailAtBottomEnd = false))
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            SelectionContainer {
                Text(text = text, color = PanelPalette.textNormal, fontSize = 15.sp)
            }
            if (streaming) StreamingIndicator()
        }
    }
}

@Composable
private fun ThinkingBlockView(text: String, streaming: Boolean, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    val collapsedByDefault = estimatedLineCount(text) > COLLAPSED_LINE_LIMIT
    val showHeader = collapsedByDefault || streaming
    val showFullText = streaming || expanded || !collapsedByDefault

    BubbleRow(alignEnd = false, modifier = modifier) {
        Column(
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier
                .clip(bubbleShape(tailAtBottomEnd = false))
                .background(PanelPalette.thinkingFill)
                .alpha(0.75f)
                .padding(horizontal = 12.dp, vertical = 7.dp)
        ) {
            if (showHeader) {
                DisclosureHeader(
                    title = if (streaming) "THINKING…" else "THINKING",
                    expanded = expanded,
                    textColor = Color.White,
                    trailingAligned = false
                ) { expanded = !expanded }
            }
            SelectionContainer {
                Text(
                    text = text,
                    color = Color.White,
                    fontSize = 12.sp,
                    fontStyle = FontStyle.Italic,
                    lineHeight = 14.sp,
                    maxLines = if (showFullText) Int.MAX_VALUE else COLLAPSED_LINE_LIMIT,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

private fun toolStatusTint(status: ToolBlockStatus): Color = when (status) {
    ToolBlockStatus.COMPLETED -> PanelPalette.success
    ToolBlockStatus.FAILED -> PanelPalette.danger
    ToolBlockStatus.CANCELLED -> PanelPalette.textMuted
    ToolBlockStatus.RUNNING, ToolBlockStatus.INPUT_STREAMING, ToolBlockStatus.READY -> PanelPalette.warning
    ToolBlockStatus.PENDING -> PanelPalette.textMuted
}

@Composable
private fun ToolBlockView(state: ToolBlockState, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, PanelPalette.border, RoundedCornerShape(8.dp))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(PanelPalette.hover)
                .clickable { expanded = !expanded }
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "TOOL",
                fontSize = 9.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = PanelPalette.textMuted
            )
            Spacer(Modifier.width(7.dp))
            Text(
                text = state.title,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
                color = PanelPalette.textNormal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
            if (!state.status.isTerminal && state.status != ToolBlockStatus.PENDING) {
                Spacer(Modifier.width(7.dp))
                CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp)
            }
            Spacer(Modifier.weight(1f))
            Text(
                text = state.status.label,
                fontSize = 9.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = toolStatusTint(state.status),
                modifier = Modifier
                    .border(1.dp, Color.White.copy(alpha = 0.16f), RoundedCornerShape(percent = 50))
                    .padding(horizontal = 7.dp, vertical = 2.dp)
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = if (expanded) "⌄" else "›",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = PanelPalette.textMuted
            )
        }

        if (expanded) {
            Column(modifier = Modifier.background(PanelPalette.backgroundPrimary)) {
                if (state.arguments.isNotEmpty()) {
                    ToolMonoSection(label = "ARGUMENTS", text = state.arguments, isError = false)
                }
                if (state.output.isNotEmpty()) {
                    ToolMonoSection(label = "RESULT", text = state.output, isError = state.status == ToolBlockStatus.FAILED)
                }
                if (state.arguments.isEmpty() && state.output.isEmpty()) {
                    Text(
                        text = "No input or output captured.",
                        fontSize = 11.sp,
                        color = PanelPalette.textMuted,
                        modifier = Modifier.padding(8.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolMonoSection(label: String, text: String, isError: Boolean) {
    val bodyTint = if (isError) PanelPalette.danger else PanelPalette.textNormal
    val labelTint = if (isError) PanelPalette.danger else PanelPalette.textMuted
    Column {
        Text(
            text = label,
            fontSize = 9.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = labelTint,
            modifier = Modifier
                .fillMaxWidth()
                .background(PanelPalette.hover)
                .padding(horizontal = 10.dp, vertical = 4.dp)
        )
        SelectionContainer {
            Text(
                text = text,
                fontSize = 10.5.sp,
                fontFamily = FontFamily.Monospace,
                color = bodyTint,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 110.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 6.dp)
            )
        }
    }
}

@Composable
private fun ErrorBlockView(source: String, message: String, modifier: Modifier = Modifier) {
    val label = when (source) {
        "run" -> "RUN FAILED"
        "connection" -> "CONNECTION ERROR"
        "protocol" -> "PROTOCOL ERROR"
        else -> "ERROR"
    }
    Column(
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelPalette.danger.copy(alpha = 0.14f))
            .border(1.dp, PanelPalette.danger.copy(alpha = 0.55f), RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Text(
            text = label,
            fontSize = 9.5.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
            color = PanelPalette.danger
        )
        SelectionContainer {
            Text(text = message, fontSize = 12.sp, color = PanelPalette.textNormal)
        }
    }
}

@Composable
private fun SystemBlockView(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        fontSize = 11.sp,
        color = PanelPalette.secondaryText,
        textAlign = TextAlign.Center,
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
    )
}

@Composable
private fun PlanBlockView(entries: List<PlanEntry>, modifier: Modifier = Modifier) {
    Column(
        verticalArrangement = Arrangement.spacedBy(5.dp),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color.Black.copy(alpha = 0.18f))
            .border(1.dp, PanelPalette.info.copy(alpha = 0.20f), RoundedCornerShape(8.dp))
            .padding(9.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.AutoMirrored.Filled.List, contentDescription = null, tint = PanelPalette.info, modifier = Modifier.size(12.dp))
            Text(text = "Plan", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = PanelPalette.secondaryText)
        }

        entries.forEach { entry ->
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                when (entry.status) {
                    "completed" -> Icon(
                        Icons.Filled.CheckCircle,
                        contentDescription = null,
                        tint = PanelPalette.success,
                        modifier = Modifier.size(12.dp)
                    )
                    "in_progress" -> Icon(
                        Icons.Filled.Refresh,
                        contentDescription = null,
                        tint = PanelPalette.info,
                        modifier = Modifier.size(12.dp)
                    )
                    else -> Text(text = "○", fontSize = 10.sp, color = PanelPalette.secondaryText)
                }
                Text(
                    text = entry.content,
                    fontSize = 12.sp,
                    color = if (entry.status == "completed") PanelPalette.secondaryText else PanelPalette.textNormal,
                    textDecoration = if (entry.status == "completed") TextDecoration.LineThrough else null
                )
            }
        }
    }
}
