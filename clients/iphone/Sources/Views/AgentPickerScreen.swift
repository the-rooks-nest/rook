import RookKit
import SwiftUI

struct AgentPickerScreen: View {
    @ObservedObject var model: RookModel
    @State private var showingSettings = false
    @State private var showingPlaces = false

    var body: some View {
        VStack(spacing: 0) {
            RookHeader(model: model, trailing: AnyView(
                HStack(spacing: 14) {
                    Button {
                        showingPlaces = true
                    } label: {
                        Image(systemName: "mappin.and.ellipse")
                            .foregroundStyle(PanelPalette.textMuted)
                    }
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(PanelPalette.textMuted)
                    }
                }
            ))

            PlaceCaption(model: model)

            if model.serverState == .offline || model.serverState == .unauthorized {
                offlineCard
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if model.currentSession != nil && !model.chatVisible {
                        resumeRow
                    }

                    Text("CHAT WITH")
                        .font(.system(size: 11, weight: .semibold))
                        .kerning(0.6)
                        .foregroundStyle(PanelPalette.textMuted)
                        .padding(.horizontal, 4)

                    if model.agents.isEmpty {
                        Text(model.serverState == .online ? "No agents registered" : "Waiting for the server…")
                            .font(.callout)
                            .foregroundStyle(PanelPalette.textMuted)
                            .frame(maxWidth: .infinity, minHeight: 80)
                    } else {
                        PanelCard {
                            ForEach(Array(model.agentTree.enumerated()), id: \.element.agent.id) { index, entry in
                                Button {
                                    model.openAgentSessions(entry.agent.id)
                                } label: {
                                    AgentRow(agent: entry.agent, depth: entry.depth)
                                }
                                .buttonStyle(.plain)
                                .disabled(model.startingSession)

                                if index < model.agentTree.count - 1 {
                                    Divider().overlay(PanelPalette.border).opacity(0.5)
                                }
                            }
                        }
                    }

                    if !model.agentsError.isEmpty {
                        PanelMessageView(systemImage: "exclamationmark.triangle.fill", tint: PanelPalette.warning, text: model.agentsError)
                    }
                }
                .padding(16)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsScreen(model: model)
        }
        .sheet(isPresented: $showingPlaces) {
            PlacesScreen(model: model)
        }
    }

    private var resumeRow: some View {
        Button {
            model.openChat()
        } label: {
            HStack(spacing: 11) {
                Image(systemName: "play.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(PanelPalette.accent))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Resume chat")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PanelPalette.textNormal)
                    Text(resumeLine)
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
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(PanelPalette.textMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(PanelPalette.accent.opacity(0.14))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(PanelPalette.accent.opacity(0.4))
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var resumeLine: String {
        guard let session = model.currentSession else {
            return ""
        }
        let name = session.name == "default" ? "" : " · \(session.name)"
        return "\(session.agent)\(name)"
    }

    private var offlineCard: some View {
        PanelMessageView(
            systemImage: model.serverState == .unauthorized ? "lock.slash.fill" : "bolt.slash.fill",
            tint: PanelPalette.danger,
            text: model.serverState == .unauthorized
                ? "Server requires authorization at \(model.baseURLString). Check the bearer token in Settings."
                : offlineText
        )
        .padding(16)
    }

    private var offlineText: String {
        if model.serverDiagnostic.isEmpty {
            return "Server unreachable at \(model.baseURLString). Run `npm run dev` on the Mac; tap the gear to change the address."
        }
        return "Server unreachable at \(model.baseURLString). \(model.serverDiagnostic)"
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
                    .foregroundStyle(PanelPalette.textMuted)
                    .padding(.leading, CGFloat(depth) * 14)
            }
            Image(systemName: depth > 0 ? "person.crop.square" : "sparkle")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(PanelPalette.info)
                .frame(width: 24, height: 24)
                .background(Circle().fill(PanelPalette.info.opacity(0.14)))
            Text(agent.id)
                .font(.body)
                .fontWeight(.medium)
                .foregroundStyle(PanelPalette.textNormal)
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(PanelPalette.textMuted)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}
