import MarkdownView
import SwiftUI
#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// Renders one `ChatBlock` from the shared chat model. Reused by the macOS
/// menu-bar app and the iOS app; the screen-level chat view (composer, scroll,
/// model wiring) stays per-app.
public struct ChatBlockView: View {
    public var block: ChatBlock

    public init(block: ChatBlock) {
        self.block = block
    }

    public var body: some View {
        switch block.kind {
        case .user(let text):
            UserBlockView(text: text)
        case .assistantText(let text, let streaming):
            AssistantTextBlockView(text: text, streaming: streaming)
        case .thinking(let text, let streaming):
            ThinkingBlockView(text: text, streaming: streaming)
        case .tool(let state):
            ToolBlockView(state: state)
        case .error(let source, let message):
            ErrorBlockView(source: source, message: message)
        case .system(let text):
            SystemBlockView(text: text)
        case .plan(let entries):
            PlanBlockView(entries: entries)
        case .environment(let banner):
            EnvironmentBlockView(banner: banner)
        }
    }
}

/// Web `.cwa-status-line__dot` with the `cwa-pulse` keyframes. Public so the
/// per-app chat status line can reuse it.
public struct StatusLineDot: View {
    public var tint: Color
    public var pulsing: Bool
    @State private var animating = false

    public init(tint: Color, pulsing: Bool) {
        self.tint = tint
        self.pulsing = pulsing
    }

    public var body: some View {
        Circle()
            .fill(tint)
            .frame(width: 8, height: 8)
            .opacity(pulsing ? (animating ? 1 : 0.35) : 0.85)
            .scaleEffect(pulsing ? (animating ? 1.15 : 0.9) : 1)
            .animation(
                pulsing ? .easeInOut(duration: 0.6).repeatForever(autoreverses: true) : .default,
                value: animating
            )
            .onAppear {
                animating = true
            }
    }
}

/// Bubble corners match the web client: user 16/16/4/16, agent 16/16/16/4.
private func bubbleShape(tailAt corner: UnitPoint) -> UnevenRoundedRectangle {
    if corner == .bottomTrailing {
        return UnevenRoundedRectangle(
            topLeadingRadius: 16, bottomLeadingRadius: 16,
            bottomTrailingRadius: 4, topTrailingRadius: 16,
            style: .continuous
        )
    }
    return UnevenRoundedRectangle(
        topLeadingRadius: 16, bottomLeadingRadius: 4,
        bottomTrailingRadius: 16, topTrailingRadius: 16,
        style: .continuous
    )
}

private struct UserBlockView: View {
    private static let collapsedLineLimit = 5

    var text: String
    @State private var expanded = false

    private var isCollapsedByDefault: Bool {
        estimatedLineCount(for: text) > Self.collapsedLineLimit
    }

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                if isCollapsedByDefault {
                    disclosureHeader(
                        title: "MESSAGE",
                        expanded: expanded,
                        textColor: .white,
                        chevronColor: .white,
                        trailingAligned: true
                    ) {
                        withAnimation(.easeInOut(duration: 0.14)) {
                            expanded.toggle()
                        }
                    }
                }

                Text(text)
                    .font(.callout)
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(isCollapsedByDefault && !expanded ? Self.collapsedLineLimit : nil)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(bubbleShape(tailAt: .bottomTrailing).fill(PanelPalette.accent))
        }
    }
}

private struct AssistantTextBlockView: View {
    var text: String
    var streaming: Bool

    private var streamingPartition: StreamingMarkdownPartition {
        StreamingMarkdownPartitioner.partition(text)
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                if streaming {
                    VStack(alignment: .leading, spacing: 0) {
                        if !streamingPartition.stablePrefix.isEmpty {
                            assistantMarkdownView(streamingPartition.stablePrefix)
                        }
                        if !streamingPartition.unstableTail.isEmpty {
                            Text(streamingPartition.unstableTail)
                                .font(.callout)
                                .foregroundStyle(PanelPalette.textNormal)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    assistantMarkdownView(text)
                }
                if streaming {
                    StreamingIndicator()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                bubbleShape(tailAt: .bottomLeading)
                    .fill(PanelPalette.backgroundPrimary.opacity(0.75))
            )
            .overlay(
                bubbleShape(tailAt: .bottomLeading)
                    .strokeBorder(PanelPalette.border)
            )
            .overlay(alignment: .topTrailing) {
                if !streaming {
                    CopyMarkdownButton(markdown: text)
                        .padding(8)
                }
            }
            Spacer(minLength: 48)
        }
    }
}

private func assistantMarkdownView(_ markdown: String) -> some View {
    MarkdownText(markdown)
        .foregroundStyle(PanelPalette.textNormal)
        .tint(PanelPalette.accentHover, for: .link)
        .tint(PanelPalette.hover, for: .inlineCodeBlock)
        .font(assistantMarkdownSystemFont(size: 22, weight: .semibold), for: .h1)
        .font(assistantMarkdownSystemFont(size: 18, weight: .semibold), for: .h2)
        .font(assistantMarkdownSystemFont(size: 15, weight: .semibold), for: .h3)
        .font(assistantMarkdownSystemFont(size: 13, weight: .semibold), for: .h4)
        .font(assistantMarkdownSystemFont(size: 13, weight: .semibold), for: .h5)
        .font(assistantMarkdownSystemFont(size: 12, weight: .semibold), for: .h6)
        .font(assistantMarkdownSystemFont(size: 13), for: .body)
        .font(assistantMarkdownSystemFont(size: 13), for: .blockQuote)
        .font(assistantMarkdownMonospacedFont(size: 12), for: .codeBlock)
        .font(assistantMarkdownSystemFont(size: 13), for: .tableBody)
        .font(assistantMarkdownSystemFont(size: 13, weight: .semibold), for: .tableHeader)
        .frame(maxWidth: .infinity, alignment: .leading)
}

private func estimatedLineCount(for text: String) -> Int {
    let explicitLines = text.split(separator: "\n", omittingEmptySubsequences: false).count
    let wrappedLines = Int(ceil(Double(text.count) / 72.0))
    return max(explicitLines, wrappedLines)
}

private func disclosureHeader(
    title: String,
    expanded: Bool,
    textColor: Color,
    chevronColor: Color,
    trailingAligned: Bool,
    action: @escaping () -> Void
) -> some View {
    Button(action: action) {
        HStack(spacing: 6) {
            if trailingAligned {
                Spacer(minLength: 0)
            }

            Text(title)
                .font(.system(size: 9.5, weight: .semibold))
                .kerning(0.5)
                .foregroundStyle(textColor)
                .opacity(0.85)
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(chevronColor)
                .opacity(0.75)

            if !trailingAligned {
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointingHandOnHover()
}

/// Renders thinking text without textSelection during streaming to avoid
/// per-update layout churn on very large accumulated text bodies.
private struct ThinkingText: View {
    var text: String
    var lineLimit: Int?
    var textSelectable: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 11.5))
            .italic()
            .lineSpacing(2)
            .foregroundStyle(.white)
            .modifier(SelectableModifier(selectable: textSelectable))
            .lineLimit(lineLimit)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct SelectableModifier: ViewModifier {
    var selectable: Bool

    func body(content: Content) -> some View {
        if selectable {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}

private struct ThinkingBlockView: View {
    private static let collapsedLineLimit = 5

    var text: String
    var streaming: Bool
    @State private var expanded = false

    private var isCollapsedByDefault: Bool {
        estimatedLineCount(for: text) > Self.collapsedLineLimit
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                if isCollapsedByDefault || streaming {
                    disclosureHeader(
                        title: streaming ? "THINKING…" : "THINKING",
                        expanded: expanded,
                        textColor: .white,
                        chevronColor: .white,
                        trailingAligned: false
                    ) {
                        withAnimation(.easeInOut(duration: 0.14)) {
                            expanded.toggle()
                        }
                    }
                    .opacity(0.8)
                }

                if streaming || expanded || !isCollapsedByDefault {
                    ThinkingText(text: text, lineLimit: streaming || expanded ? nil : Self.collapsedLineLimit, textSelectable: !streaming)
                } else {
                    ThinkingText(text: text, lineLimit: Self.collapsedLineLimit, textSelectable: true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(bubbleShape(tailAt: .bottomLeading).fill(PanelPalette.thinkingFill))
            .opacity(0.75)
            Spacer(minLength: 48)
        }
    }
}

private struct ToolBlockView: View {
    var state: ToolBlockState
    @State private var expanded = false
    @State private var isHoveringCard = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.14)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Text("TOOL")
                        .font(.system(size: 9, weight: .semibold))
                        .kerning(0.5)
                        .foregroundStyle(PanelPalette.textMuted)
                    Text(state.title)
                        .font(.system(size: 11.5, design: .monospaced))
                        .fontWeight(.semibold)
                        .foregroundStyle(PanelPalette.textNormal)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !state.status.isTerminal && state.status != .pending {
                        ProgressView()
                            .scaleEffect(0.4)
                            .frame(width: 10, height: 10)
                    }
                    Spacer(minLength: 4)
                    Text(state.status.label)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(statusTint)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .overlay(
                            Capsule()
                                .strokeBorder(Color.white.opacity(0.16))
                        )
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(PanelPalette.textMuted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(PanelPalette.hover)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Show tool details")
            .pointingHandOnHover()

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    if !state.arguments.isEmpty {
                        monoSection(label: "ARGUMENTS", text: ToolPayloadFormatting.displayArguments(state.arguments), isError: false)
                    }
                    if !state.output.isEmpty {
                        monoSection(label: "RESULT", text: state.output, isError: state.status == .failed)
                    }
                    if state.arguments.isEmpty && state.output.isEmpty {
                        Text("No input or output captured.")
                            .font(.caption2)
                            .foregroundStyle(PanelPalette.textMuted)
                            .padding(8)
                    }
                }
                .background(PanelPalette.backgroundPrimary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(isHoveringCard ? PanelPalette.accent : PanelPalette.border)
        )
        .onHover { isHoveringCard = $0 }
    }

    private func monoSection(label: String, text: String, isError: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .kerning(0.5)
                .foregroundStyle(isError ? PanelPalette.danger : PanelPalette.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(PanelPalette.hover)
            ScrollView(.vertical) {
                Text(text)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(isError ? PanelPalette.danger : PanelPalette.textNormal)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
            .frame(maxHeight: 110)
        }
    }

    private var statusTint: Color {
        switch state.status {
        case .completed:
            return PanelPalette.success
        case .failed:
            return PanelPalette.danger
        case .cancelled:
            return PanelPalette.textMuted
        case .running, .inputStreaming, .ready:
            return PanelPalette.warning
        case .pending:
            return PanelPalette.textMuted
        }
    }
}

private struct ErrorBlockView: View {
    var source: String
    var message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(sourceLabel)
                .font(.system(size: 9.5, weight: .bold))
                .kerning(0.5)
                .foregroundStyle(PanelPalette.danger)
            Text(message)
                .font(.caption)
                .foregroundStyle(PanelPalette.textNormal)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(PanelPalette.danger.opacity(0.14))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(PanelPalette.danger.opacity(0.55))
        )
    }

    private var sourceLabel: String {
        switch source {
        case "run":
            return "RUN FAILED"
        case "connection":
            return "CONNECTION ERROR"
        case "protocol":
            return "PROTOCOL ERROR"
        default:
            return "ERROR"
        }
    }
}

private struct SystemBlockView: View {
    var text: String

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(PanelPalette.secondaryText)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
    }
}

/// Friendly "entered a business" banner: the display name (📍) plus a row of
/// favicons for the entered business and nearby ones. Falls back to generic text
/// when no name is known.
private struct EnvironmentBlockView: View {
    var banner: EnvironmentBanner

    var body: some View {
        VStack(spacing: 4) {
            Text(banner.displayName.map { "📍 \($0)" } ?? "Using nearby business context")
                .font(.caption2)
                .foregroundStyle(PanelPalette.secondaryText)
            if !banner.websites.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(banner.websites.prefix(6)), id: \.self) { website in
                        FaviconView(website: website)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 2)
    }
}

#if os(macOS)
private typealias PlatformImage = NSImage
#else
private typealias PlatformImage = UIImage
#endif

private extension Image {
    init?(platformImage: PlatformImage?) {
        guard let platformImage else { return nil }
        #if os(macOS)
        self = Image(nsImage: platformImage)
        #else
        self = Image(uiImage: platformImage)
        #endif
    }
}

/// Loads a site favicon by trying a sequence of common icon URLs and using the
/// first that decodes. `AsyncImage` can't chain fallbacks, so we drive it manually.
@MainActor
private final class FaviconLoader: ObservableObject {
    @Published var image: Image?
    @Published var failed = false
    private var started = false

    func load(website: String) {
        guard !started else { return }
        started = true
        guard let host = FaviconLoader.host(of: website) else { failed = true; return }
        let candidates = [
            "https://\(host)/apple-touch-icon.png",
            "https://\(host)/apple-touch-icon-precomposed.png",
            "https://\(host)/favicon.ico",
            "https://\(host)/favicon.png",
            "https://\(host)/favicon-32x32.png",
        ].compactMap(URL.init(string:))
        Task { await attempt(candidates, index: 0) }
    }

    private func attempt(_ urls: [URL], index: Int) async {
        guard index < urls.count else { failed = true; return }
        do {
            let (data, response) = try await URLSession.shared.data(from: urls[index])
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                return await attempt(urls, index: index + 1)
            }
            if let platform = PlatformImage(data: data), let img = Image(platformImage: platform) {
                image = img
                return
            }
        } catch {
            // fall through to next candidate
        }
        await attempt(urls, index: index + 1)
    }

    private static func host(of website: String) -> String? {
        let trimmed = website.contains("://") ? website : "https://\(website)"
        return URLComponents(string: trimmed)?.host
    }
}

private struct FaviconView: View {
    let website: String
    @StateObject private var loader = FaviconLoader()

    var body: some View {
        Group {
            if let image = loader.image {
                image.resizable().scaledToFit()
            } else {
                Image(systemName: "globe")
                    .font(.system(size: 12))
                    .foregroundStyle(PanelPalette.secondaryText)
            }
        }
        .frame(width: 18, height: 18)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .opacity(loader.image == nil && loader.failed ? 0.5 : 1)
        .onAppear { loader.load(website: website) }
    }
}

private struct PlanBlockView: View {
    var entries: [PlanEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "list.bullet.rectangle")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PanelPalette.info)
                Text("Plan")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(PanelPalette.secondaryText)
            }

            ForEach(entries) { entry in
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: planIcon(entry.status))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(planTint(entry.status))
                        .padding(.top, 1)
                    Text(entry.content)
                        .font(.caption)
                        .foregroundStyle(entry.status == "completed" ? .secondary : .primary)
                        .strikethrough(entry.status == "completed", color: .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.black.opacity(0.18))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(PanelPalette.info.opacity(0.20))
        )
    }

    private func planIcon(_ status: String) -> String {
        switch status {
        case "completed":
            return "checkmark.circle.fill"
        case "in_progress":
            return "arrow.triangle.2.circlepath"
        default:
            return "circle"
        }
    }

    private func planTint(_ status: String) -> Color {
        switch status {
        case "completed":
            return PanelPalette.success
        case "in_progress":
            return PanelPalette.info
        default:
            return PanelPalette.secondaryText
        }
    }
}

private struct CopyMarkdownButton: View {
    var markdown: String
    @State private var isHovering = false

    var body: some View {
        Button {
            copyTextToClipboard(markdown)
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(isHovering ? PanelPalette.textNormal : PanelPalette.textMuted)
                .padding(6)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(PanelPalette.backgroundSecondary.opacity(isHovering ? 0.95 : 0.7))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(PanelPalette.border.opacity(isHovering ? 1 : 0.65))
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy markdown")
        .help("Copy markdown")
        .onHover { isHovering = $0 }
    }
}

private func assistantMarkdownSystemFont(size: CGFloat, weight: Font.Weight = .regular) -> any CustomCTFontConvertible {
    #if os(macOS)
    return NSFont.systemFont(ofSize: size, weight: nsFontWeight(weight))
    #else
    return UIFont.systemFont(ofSize: size, weight: uiFontWeight(weight))
    #endif
}

private func assistantMarkdownMonospacedFont(size: CGFloat) -> any CustomCTFontConvertible {
    #if os(macOS)
    return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    #else
    return UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    #endif
}

#if os(macOS)
private func nsFontWeight(_ weight: Font.Weight) -> NSFont.Weight {
    switch weight {
    case .ultraLight: return .ultraLight
    case .thin: return .thin
    case .light: return .light
    case .regular: return .regular
    case .medium: return .medium
    case .semibold: return .semibold
    case .bold: return .bold
    case .heavy: return .heavy
    case .black: return .black
    default: return .regular
    }
}
#else
private func uiFontWeight(_ weight: Font.Weight) -> UIFont.Weight {
    switch weight {
    case .ultraLight: return .ultraLight
    case .thin: return .thin
    case .light: return .light
    case .regular: return .regular
    case .medium: return .medium
    case .semibold: return .semibold
    case .bold: return .bold
    case .heavy: return .heavy
    case .black: return .black
    default: return .regular
    }
}
#endif

private struct StreamingIndicator: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(Color.white.opacity(0.9))
            .frame(width: 6, height: 6)
            .opacity(pulsing ? 0.25 : 1)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: pulsing)
            .onAppear {
                pulsing = true
            }
    }
}
