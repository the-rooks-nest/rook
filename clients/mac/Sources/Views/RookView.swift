import Foundation
import RookKit
import SwiftUI

struct RookView: View {
    @ObservedObject var model: RookMacModel
    @State private var measuredContentHeight: CGFloat = 420
    @State private var hostingWindow: NSWindow?
    @State private var hasAppliedInitialSizing = false

    private let homePanelWidth: CGFloat = 372
    private let detailPanelWidth: CGFloat = 460
    private let mainWindowAutosaveName = "RookMainWindow"

    var body: some View {
        displayedContent
            .padding(12)
            .frame(
                minWidth: panelWidth,
                idealWidth: panelWidth,
                maxWidth: .infinity,
                minHeight: panelHeight,
                idealHeight: panelHeight,
                maxHeight: .infinity,
                alignment: .topLeading
            )
            .background(PanelBackground())
            .background(measurementContent)
        .background(WindowAccessor { window in
            if hostingWindow !== window {
                hostingWindow = window
                hasAppliedInitialSizing = false
                applyWindowSizing(window)
            }
        })
        .environment(\.colorScheme, .dark)
        .onAppear {
            model.refreshNow()
            applyWindowSizing(hostingWindow)
        }
        .onPreferenceChange(PanelContentHeightKey.self) { height in
            let rounded = ceil(height)
            guard abs(rounded - measuredContentHeight) > 1 else { return }
            measuredContentHeight = rounded
            applyWindowSizing(hostingWindow)
        }
        .onChange(of: model.panelMode) { _, _ in
            applyWindowSizing(hostingWindow)
        }
    }

    @ViewBuilder
    private var displayedContent: some View {
        if model.panelMode == .chat {
            baseContent
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            baseContent
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var measurementContent: some View {
        measurementBaseContent
            .fixedSize(horizontal: false, vertical: true)
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .preference(key: PanelContentHeightKey.self, value: proxy.size.height + 24)
                }
            )
            .hidden()
            .allowsHitTesting(false)
    }

    private var baseContent: some View {
        ZStack(alignment: .topLeading) {
            switch model.panelMode {
            case .home:
                HomeContent(model: model)
            case .sessions(let agentId):
                SessionsDetail(model: model, agentId: agentId)
            case .chat:
                ChatDetail(model: model, elasticThreadCard: true, measurementMode: false)
            case .environmentOffer:
                EnvironmentOfferDetail(model: model)
            case .capabilities:
                CapabilitiesDetail(model: model)
            }
        }
    }

    private var measurementBaseContent: some View {
        ZStack(alignment: .topLeading) {
            switch model.panelMode {
            case .home:
                HomeContent(model: model)
            case .sessions(let agentId):
                SessionsDetail(model: model, agentId: agentId)
            case .chat:
                ChatDetail(model: model, elasticThreadCard: false, measurementMode: true)
            case .environmentOffer:
                EnvironmentOfferDetail(model: model)
            case .capabilities:
                CapabilitiesDetail(model: model)
            }
        }
    }

    // Panel size is applied WITHOUT animation. Animating the hosting view's
    // content size (here, the 372↔460 width on mode switches) makes AppKit
    // resize the window mid–constraint-pass and trap inside
    // NSHostingView.updateWindowContentSizeExtremaIfNecessary — crashing the
    // app, including on launch when hosted in the companion NSPanel.
    private var panelWidth: CGFloat {
        model.panelMode == .home ? homePanelWidth : detailPanelWidth
    }

    private var panelHeight: CGFloat {
        max(420, measuredContentHeight)
    }

    private func applyWindowSizing(_ window: NSWindow?) {
        guard let window else { return }

        let targetContentSize = NSSize(width: panelWidth, height: panelHeight)
        window.contentMinSize = targetContentSize
        window.contentMaxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)

        let currentContentRect = window.contentRect(forFrameRect: window.frame)
        let hasSavedFrame = UserDefaults.standard.string(forKey: "NSWindow Frame \(mainWindowAutosaveName)") != nil
        let desiredContentSize: NSSize
        if hasAppliedInitialSizing || hasSavedFrame {
            desiredContentSize = NSSize(
                width: max(currentContentRect.width, targetContentSize.width),
                height: max(currentContentRect.height, targetContentSize.height)
            )
        } else {
            desiredContentSize = targetContentSize
        }
        hasAppliedInitialSizing = true

        guard abs(desiredContentSize.width - currentContentRect.width) > 1 || abs(desiredContentSize.height - currentContentRect.height) > 1 else {
            return
        }

        let desiredFrame = window.frameRect(forContentRect: NSRect(origin: .zero, size: desiredContentSize))
        var nextFrame = window.frame
        nextFrame.origin.y += nextFrame.height - desiredFrame.height
        nextFrame.size = desiredFrame.size
        window.setFrame(nextFrame, display: true)
    }
}

private struct PanelContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 420

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct WindowAccessor: NSViewRepresentable {
    var onResolve: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            onResolve(view.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            onResolve(nsView.window)
        }
    }
}

struct DetailHeader: View {
    var title: String
    var systemImage: String
    var trailing: String
    var onBack: () -> Void

    var body: some View {
        PanelCard {
            HStack(spacing: 9) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.primary)
                        .frame(width: 28, height: 28)
                        .background(
                            Circle()
                                .fill(Color.white.opacity(0.10))
                        )
                }
                .buttonStyle(.plain)
                .help("Back")
                .pointingHandOnHover()

                Label(title, systemImage: systemImage)
                    .font(.headline)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 0)

                if !trailing.isEmpty {
                    Text(trailing)
                        .font(.caption)
                        .foregroundStyle(PanelPalette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
    }
}

// MARK: - Home

private struct HomeContent: View {
    @ObservedObject var model: RookMacModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            identityRow
            if model.foregroundAppName != nil {
                foregroundCaption
            }
            if model.pendingOffer != nil {
                pendingOfferCard
            }
            if model.currentSession != nil {
                resumeRow
            }
            if model.serverState == .online {
                agentsCard
            } else {
                serverOfflineCard
            }
            capabilitiesStrip
            footerActions
        }
    }

    // MARK: - Identity (slim, one line)

    private var identityRow: some View {
        HStack(spacing: 10) {
            Image("RookMark")
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .frame(width: 15, height: 15)
            Text("Rook")
                .font(.headline)
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Text(serverStateLabel)
                    .font(.caption)
                    .foregroundStyle(PanelPalette.textMuted)
                StatusDot(tint: model.serverStatusTint)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }

    private var serverStateLabel: String {
        switch model.serverState {
        case .online: return model.isRunning ? "working" : "online"
        case .starting: return "starting…"
        case .offline: return "offline"
        case .unknown: return "checking…"
        }
    }

    private var foregroundCaption: some View {
        let hasEnvironment = model.foregroundEnvironmentId != nil
        return HStack(spacing: 6) {
            Image(systemName: "macwindow")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(hasEnvironment ? PanelPalette.accentHover : PanelPalette.textMuted)
            Text("In \(model.foregroundAppName ?? "app")")
                .font(.caption2)
                .fontWeight(.medium)
                .foregroundStyle(PanelPalette.textNormal)
                .lineLimit(1)
                .truncationMode(.tail)
            Circle()
                .fill(hasEnvironment ? PanelPalette.success : PanelPalette.textMuted.opacity(0.6))
                .frame(width: 5, height: 5)
            Text(hasEnvironment ? "environment active" : "tracking off")
                .font(.caption2)
                .foregroundStyle(hasEnvironment ? PanelPalette.success : PanelPalette.textMuted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    // MARK: - Resume (primary affordance)

    private var resumeRow: some View {
        Button {
            model.openChat()
        } label: {
            HStack(spacing: 11) {
                Image(systemName: "play.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(PanelPalette.accent))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Resume chat")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(PanelPalette.textNormal)
                    Text(currentChatLine)
                        .font(.caption)
                        .foregroundStyle(PanelPalette.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                if model.isRunning {
                    StatusDot(tint: PanelPalette.warning)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(PanelPalette.accent.opacity(0.14))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(PanelPalette.accent.opacity(0.4))
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("Resume the current chat")
        .pointingHandOnHover()
    }

    // MARK: - Capabilities strip (entry to settings)

    private var capabilitiesStrip: some View {
        Button {
            model.openCapabilities()
        } label: {
            HStack(spacing: 12) {
                capGlyph("mic.fill", on: model.voiceModeEnabled, attention: model.voiceModeEnabled && !model.voiceAuthorized)
                capGlyph("cursorarrow.rays", on: model.computerControlEnabled, attention: model.computerControlEnabled && !model.screenRecordingTrusted)
                capGlyph("antenna.radiowaves.left.and.right", on: model.bridgePort > 0, attention: !model.accessibilityTrusted)
                Text("Capabilities")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(PanelPalette.textNormal)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(PanelPalette.backgroundSecondary.opacity(0.6))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(PanelPalette.border)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("Voice, Computer Control, and Context Bridge settings")
        .pointingHandOnHover()
    }

    private func capGlyph(_ systemImage: String, on: Bool, attention: Bool) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(on ? PanelPalette.accent : PanelPalette.textMuted.opacity(0.6))
            .frame(width: 26, height: 26)
            .background(
                Circle().fill(on ? PanelPalette.accent.opacity(0.16) : Color.white.opacity(0.04))
            )
            .overlay(alignment: .topTrailing) {
                if attention {
                    Circle()
                        .fill(PanelPalette.warning)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().strokeBorder(PanelPalette.backgroundPrimary, lineWidth: 1.5))
                        .offset(x: 1, y: -1)
                }
            }
    }

    private var pendingOfferCard: some View {
        Button {
            model.reviewPendingOffer()
        } label: {
            PanelCard {
                HStack(spacing: 9) {
                    Image(systemName: "puzzlepiece.extension.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PanelPalette.warning)
                        .frame(width: 24, height: 24)
                        .background(
                            Circle()
                                .fill(PanelPalette.warning.opacity(0.18))
                        )
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.pendingOfferCount > 1 ? "Bundles available" : "Bundle available")
                            .font(.subheadline)
                            .fontWeight(.semibold)
                        HStack(spacing: 6) {
                            Text(model.pendingOffer?.bundleId ?? model.pendingOffer?.environmentId ?? "")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if model.pendingOfferCount > 1 {
                                Text("+\(model.pendingOfferCount - 1) more")
                                    .font(.caption2)
                                    .foregroundStyle(PanelPalette.warning)
                            }
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("Review environment offer")
        .pointingHandOnHover()
    }

    private var currentChatLine: String {
        guard let session = model.currentSession else {
            return ""
        }
        let name = session.name == "default" ? "" : " · \(session.name)"
        return "\(session.agent)\(name)"
    }

    private var agentsCard: some View {
        PanelCard {
            Text("CHAT WITH")
                .font(.system(size: 10, weight: .semibold))
                .kerning(0.6)
                .foregroundStyle(PanelPalette.textMuted)

            if !model.agentsError.isEmpty {
                PanelMessageView(
                    systemImage: "exclamationmark.triangle.fill",
                    tint: PanelPalette.warning,
                    text: model.agentsError
                )
            }

            if model.agents.isEmpty && model.agentsError.isEmpty {
                Text("No agents registered")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .center)
            } else {
                VStack(spacing: 0) {
                    let tree = model.agentTree
                    ForEach(Array(tree.enumerated()), id: \.element.agent.id) { index, entry in
                        Button {
                            model.openAgentSessions(entry.agent.id)
                        } label: {
                            AgentRow(agent: entry.agent, depth: entry.depth)
                        }
                        .buttonStyle(.plain)
                        .help("Chat with \(entry.agent.id)")
                        .pointingHandOnHover()

                        if index < tree.count - 1 {
                            Divider()
                                .opacity(0.45)
                        }
                    }
                }
            }
        }
    }

    private var serverOfflineCard: some View {
        PanelCard {
            VStack(alignment: .leading, spacing: 8) {
                PanelMessageView(
                    systemImage: "bolt.slash.fill",
                    tint: PanelPalette.danger,
                    text: "Rook isn't reachable at \(model.api.baseURL.absoluteString). Start it here or run `npm run dev` in the rookery repo."
                )

                HStack(spacing: 8) {
                    CompactActionButton(
                        title: model.serverState == .starting ? "Starting…" : "Start Server",
                        systemImage: "power",
                        tint: PanelPalette.success,
                        prominence: .filled,
                        helpText: "Launch `npm run dev` for the rookery repo"
                    ) {
                        model.startServer()
                    }
                    .disabled(model.serverState == .starting)

                    CompactActionButton(
                        title: "Retry",
                        systemImage: "arrow.clockwise",
                        tint: PanelPalette.secondaryText,
                        prominence: .subtle,
                        helpText: "Check the server again"
                    ) {
                        model.refreshNow()
                    }
                }
            }
        }
    }

    private var footerActions: some View {
        HStack(spacing: 8) {
            FooterIconButton(title: "Open Web App", systemImage: "safari") {
                model.openWebApp()
            }
            FooterIconButton(title: "Open Server Log", systemImage: "doc.text.magnifyingglass") {
                model.openServerLog()
            }
            if model.managedServerRunning {
                FooterIconButton(title: "Stop Managed Server", systemImage: "stop.circle") {
                    model.stopServer()
                }
            }
            FooterIconButton(title: "Refresh", systemImage: "arrow.clockwise") {
                model.refreshNow()
            }
            Spacer(minLength: 0)
            FooterIconButton(title: "Quit", systemImage: "xmark.circle") {
                model.quitApp()
            }
        }
    }
}

private struct AgentRow: View {
    var agent: AgentDefinition
    var depth: Int

    var body: some View {
        HStack(spacing: 9) {
            if depth > 0 {
                Image(systemName: "arrow.turn.down.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.leading, CGFloat(depth) * 14)
            }

            Image(systemName: depth > 0 ? "person.crop.square" : "sparkle")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(PanelPalette.info)
                .frame(width: 22, height: 22)
                .background(
                    Circle()
                        .fill(PanelPalette.info.opacity(0.14))
                )

            Text(agent.id)
                .font(.callout)
                .fontWeight(.medium)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .hoverRowBackground()
    }
}

// MARK: - Sessions

private struct SessionsDetail: View {
    @ObservedObject var model: RookMacModel
    var agentId: String
    @State private var newSessionName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DetailHeader(
                title: agentId,
                systemImage: "cpu",
                trailing: sessionsCountLabel
            ) {
                model.goHome()
            }

            newChatCard
            sessionsCard
        }
    }

    private var sessionsCountLabel: String {
        model.sessions.isEmpty ? "" : "\(model.sessions.count) sessions"
    }

    private var newChatCard: some View {
        PanelCard {
            Label("New Chat", systemImage: "plus.bubble")
                .font(.subheadline)
                .fontWeight(.semibold)

            HStack(spacing: 8) {
                TextField("Session name (optional)", text: $newSessionName)
                    .textFieldStyle(.plain)
                    .font(.callout)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(PanelPalette.backgroundPrimary.opacity(0.75))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(PanelPalette.border)
                    )
                    .onSubmit {
                        startNew()
                    }

                Button {
                    startNew()
                } label: {
                    Image(systemName: model.startingSession ? "hourglass" : "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(
                            Circle()
                                .fill(PanelPalette.accent)
                        )
                }
                .buttonStyle(.plain)
                .help("Start a new chat")
                .disabled(model.startingSession)
                .pointingHandOnHover()
            }
        }
    }

    private func startNew() {
        guard !model.startingSession else {
            return
        }
        model.startNewSession(agentId: agentId, name: newSessionName)
    }

    private var sessionsCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Previous Sessions", systemImage: "clock.arrow.circlepath")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                if model.sessionsLoading {
                    ProgressView()
                        .scaleEffect(0.5)
                }
            }

            if !model.sessionsError.isEmpty {
                PanelMessageView(
                    systemImage: "exclamationmark.triangle.fill",
                    tint: PanelPalette.warning,
                    text: model.sessionsError
                )
            }

            if model.sessions.isEmpty && !model.sessionsLoading {
                Text("No sessions yet — start a new chat above.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
            } else {
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(model.sessions.enumerated()), id: \.element.id) { index, session in
                            Button {
                                model.resumeSession(session)
                            } label: {
                                SessionRow(session: session)
                            }
                            .buttonStyle(.plain)
                            .help("Resume this session")
                            .disabled(model.startingSession)
                            .pointingHandOnHover()

                            if index < model.sessions.count - 1 {
                                Divider()
                                    .opacity(0.45)
                            }
                        }
                    }
                }
                .scrollIndicators(.visible)
                .frame(height: sessionListHeight)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
    }

    private var sessionListHeight: CGFloat {
        let visibleRows = min(CGFloat(model.sessions.count), 7)
        let rowHeight: CGFloat = 54
        return max(visibleRows * rowHeight, rowHeight)
    }
}

private struct SessionRow: View {
    var session: AgentSessionSummary

    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            Image(systemName: session.running ? "bolt.fill" : "moon.zzz")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(session.running ? PanelPalette.success : PanelPalette.secondaryText)
                .frame(width: 22, height: 22)
                .background(
                    Circle()
                        .fill((session.running ? PanelPalette.success : PanelPalette.secondaryText).opacity(0.14))
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(session.name)
                    .font(.callout)
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text(session.createdAtLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            Text(statusLabel)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(.white.opacity(0.96))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    Capsule()
                        .fill((session.running ? PanelPalette.success : PanelPalette.secondaryText).opacity(0.25))
                )
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .hoverRowBackground()
    }

    private var statusLabel: String {
        if session.running {
            return session.connectedClients > 0 ? "\(session.connectedClients) connected" : "Running"
        }
        return "Stopped"
    }
}
