import Foundation
import SwiftUI

struct AgentStationMenuView: View {
    @ObservedObject var model: AgentStationModel
    private let homePanelWidth: CGFloat = 372
    private let detailPanelWidth: CGFloat = 460

    var body: some View {
        ZStack(alignment: .topLeading) {
            switch model.panelMode {
            case .home:
                HomeContent(model: model)
                    .transition(detailTransition(edge: .leading))
            case .sessions(let agentId):
                SessionsDetail(model: model, agentId: agentId)
                    .transition(detailTransition(edge: .trailing))
            case .chat:
                ChatDetail(model: model)
                    .transition(detailTransition(edge: .trailing))
            case .environmentOffer:
                EnvironmentOfferDetail(model: model)
                    .transition(detailTransition(edge: .trailing))
            }
        }
        .padding(12)
        .frame(width: panelWidth, alignment: .topLeading)
        .background(PanelBackground())
        .environment(\.colorScheme, .dark)
        .animation(.easeInOut(duration: 0.18), value: model.panelMode)
        .onAppear {
            model.refreshNow()
        }
    }

    private var panelWidth: CGFloat {
        model.panelMode == .home ? homePanelWidth : detailPanelWidth
    }

    private func detailTransition(edge: Edge) -> AnyTransition {
        .move(edge: edge).combined(with: .opacity)
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
    @ObservedObject var model: AgentStationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if model.pendingOffer != nil {
                pendingOfferCard
            }
            if model.foregroundEnvironmentId != nil {
                foregroundEnvironmentCard
            }
            awarenessCard
            voiceCard
            computerControlCard
            if model.currentSession != nil {
                currentChatCard
            }
            if model.serverState == .online {
                agentsCard
            } else {
                serverOfflineCard
            }
            footerActions
        }
    }

    private var header: some View {
        Group {
            if model.currentSession != nil {
                Button {
                    model.openChat()
                } label: {
                    headerCard(showChevron: true)
                }
                .buttonStyle(.plain)
                .help("Open current chat")
                .pointingHandOnHover()
            } else {
                headerCard(showChevron: false)
            }
        }
    }

    private func headerCard(showChevron: Bool) -> some View {
        PanelCard {
            HStack(alignment: .top, spacing: 14) {
                VStack(spacing: 7) {
                    StatusGlyph(systemImage: "bird", tint: PanelPalette.accent, size: 34)

                    Text(statusBadge)
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(
                            Capsule()
                                .fill(model.serverStatusTint.opacity(0.34))
                        )
                        .foregroundColor(.white.opacity(0.96))
                }
                .frame(width: 70)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text("Agent Station")
                            .font(.headline)
                        StatusDot(tint: model.serverStatusTint)
                    }

                    Text(model.serverPrimaryLine)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Text(model.serverSecondaryLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
                .layoutPriority(1)

                Spacer(minLength: 0)

                if showChevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 5)
                }
            }
        }
    }

    private var statusBadge: String {
        switch model.serverState {
        case .online:
            return model.isRunning ? "Working" : "Online"
        case .starting:
            return "Starting"
        case .offline:
            return "Offline"
        case .unknown:
            return "…"
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
                        Text("Environment available")
                            .font(.subheadline)
                            .fontWeight(.semibold)
                        Text(model.pendingOffer?.environmentId ?? "")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
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

    private var foregroundEnvironmentCard: some View {
        PanelCard {
            HStack(spacing: 9) {
                Image(systemName: "macwindow.on.rectangle")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PanelPalette.accentHover)
                    .frame(width: 24, height: 24)
                    .background(
                        Circle()
                            .fill(PanelPalette.accent.opacity(0.18))
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(model.foregroundAppName ?? "App") environment")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    Text(model.foregroundEnvironmentId ?? "")
                        .font(.caption.monospaced())
                        .foregroundStyle(PanelPalette.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                StatusDot(tint: PanelPalette.success)
            }

            if let title = model.foregroundWindowTitle, !title.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "text.window")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(PanelPalette.textMuted)
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(PanelPalette.textNormal)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
    }

    private var awarenessCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Context Bridge", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                Text(model.bridgePort > 0 ? ":\(String(model.bridgePort))" : "off")
                    .font(.caption.monospaced())
                    .foregroundStyle(PanelPalette.textMuted)
                StatusDot(tint: model.bridgePort > 0 ? PanelPalette.success : PanelPalette.danger)
            }

            HStack(spacing: 8) {
                Image(systemName: model.accessibilityTrusted ? "checkmark.shield.fill" : "exclamationmark.shield")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(model.accessibilityTrusted ? PanelPalette.success : PanelPalette.warning)
                Text(model.accessibilityTrusted
                     ? "Accessibility granted — window titles visible"
                     : "Grant Accessibility to read window titles")
                    .font(.caption)
                    .foregroundStyle(PanelPalette.textMuted)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if !model.accessibilityTrusted {
                    Button {
                        model.requestAccessibility()
                    } label: {
                        Text("Grant")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Capsule().fill(PanelPalette.accent))
                    }
                    .buttonStyle(.plain)
                    .help("Open System Settings → Privacy → Accessibility")
                    .pointingHandOnHover()
                }
            }
        }
    }

    private var voiceCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Voice", systemImage: "mic.fill")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { model.voiceModeEnabled },
                    set: { model.setVoiceMode($0) }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(PanelPalette.accent)
            }

            if model.voiceModeEnabled {
                HStack(spacing: 8) {
                    Button {
                        model.toggleVoiceListening()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: model.voiceListening ? "waveform.circle.fill" : "mic.circle")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(model.voiceListening ? PanelPalette.danger : PanelPalette.accent)
                                .symbolEffect(.pulse, isActive: model.voiceListening)
                            Text(voiceStatusText)
                                .font(.caption)
                                .foregroundStyle(model.voiceListening ? PanelPalette.textNormal : PanelPalette.textMuted)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(model.voiceListening ? PanelPalette.danger.opacity(0.14) : PanelPalette.backgroundPrimary.opacity(0.5))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(model.voiceListening ? PanelPalette.danger.opacity(0.5) : PanelPalette.border)
                        )
                    }
                    .buttonStyle(.plain)
                    .help("Press to talk (or ⌃⌥Space anywhere)")
                    .pointingHandOnHover()

                    if model.voiceSpeaking {
                        Button {
                            model.stopSpeaking()
                        } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(PanelPalette.danger))
                        }
                        .buttonStyle(.plain)
                        .help("Stop speaking")
                        .pointingHandOnHover()
                    }
                }

                Text(model.voiceAuthorized
                     ? "Press to talk or ⌃⌥Space from any app. Voice: \(model.voiceName). Talking interrupts playback."
                     : "Voice needs Microphone + Speech Recognition permission.")
                    .font(.caption2)
                    .foregroundStyle(PanelPalette.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Talk to your agent hands-free — speak and hear replies aloud.")
                    .font(.caption)
                    .foregroundStyle(PanelPalette.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var voiceStatusText: String {
        if model.voiceListening {
            return model.voicePartial.isEmpty ? "Listening…" : model.voicePartial
        }
        if model.voiceSpeaking {
            return "Speaking…"
        }
        return "Press to talk"
    }

    private var computerControlCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Computer Control", systemImage: "cursorarrow.rays")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { model.computerControlEnabled },
                    set: { model.setComputerControlEnabled($0) }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(PanelPalette.accent)
            }

            Text(model.computerControlEnabled
                 ? "The agent can move the mouse, click, and type in the frontmost app."
                 : "Off — the agent can read context but cannot drive the mouse/keyboard.")
                .font(.caption)
                .foregroundStyle(model.computerControlEnabled ? PanelPalette.warning : PanelPalette.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Image(systemName: model.screenRecordingTrusted ? "checkmark.shield.fill" : "exclamationmark.shield")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(model.screenRecordingTrusted ? PanelPalette.success : PanelPalette.warning)
                Text(model.screenRecordingTrusted
                     ? "Screen Recording granted — screenshots available"
                     : "Screen Recording needed for screenshot (vision) grounding")
                    .font(.caption)
                    .foregroundStyle(PanelPalette.textMuted)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if !model.screenRecordingTrusted {
                    Button {
                        model.requestScreenRecording()
                    } label: {
                        Text("Grant")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Capsule().fill(PanelPalette.accent))
                    }
                    .buttonStyle(.plain)
                    .help("Open System Settings → Privacy → Screen Recording")
                    .pointingHandOnHover()
                }
            }
        }
    }

    private var currentChatCard: some View {
        Button {
            model.openChat()
        } label: {
            PanelCard {
                HStack(spacing: 8) {
                    Label("Current Chat", systemImage: "bubble.left.and.bubble.right")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    Spacer()
                    Text(currentChatLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("Open current chat")
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
            HStack(spacing: 8) {
                Label("Agents", systemImage: "cpu")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                Text("\(model.agents.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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
                    text: "Agent Station isn't reachable at \(model.api.baseURL.absoluteString). Start it here or run `npm run dev` in the rookery repo."
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
    @ObservedObject var model: AgentStationModel
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
