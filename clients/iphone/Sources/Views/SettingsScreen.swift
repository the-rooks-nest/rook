import CoreLocation
import RookKit
import SwiftUI

/// One place to see and grant Rook's capabilities — the iOS counterpart of the
/// Mac app's Capabilities panel. Server address, voice (mic + speech), and
/// location (incl. the Always upgrade that background geofencing needs).
struct SettingsScreen: View {
    @ObservedObject var model: RookModel
    @Environment(\.dismiss) private var dismiss
    @State private var serverDraft = ""
    @State private var authTokenDraft = ""

    var body: some View {
        NavigationStack {
            ZStack {
                PanelBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        serverCard
                        voiceCard
                        locationCard
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(PanelPalette.accent)
                }
            }
        }
        .tint(PanelPalette.accent)
        .onAppear {
            serverDraft = model.baseURLString
            authTokenDraft = model.authTokenString
        }
    }

    // MARK: - Server

    private var serverCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Server", systemImage: "server.rack")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PanelPalette.textNormal)
                Spacer()
                Text(model.serverStatusLabel)
                    .font(.caption)
                    .foregroundStyle(PanelPalette.textMuted)
                StatusDot(tint: model.serverStatusTint)
            }

            TextField("http://127.0.0.1:3000", text: $serverDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .foregroundStyle(PanelPalette.textNormal)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(PanelPalette.backgroundPrimary.opacity(0.8))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(PanelPalette.border)
                )

            TextField("Bearer token (optional on localhost)", text: $authTokenDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.password)
                .foregroundStyle(PanelPalette.textNormal)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(PanelPalette.backgroundPrimary.opacity(0.8))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(PanelPalette.border)
                )

            Text("On a device, use a hostname or IP address your phone can reach. Add the bearer token if the server is configured to require one for non-local access.")
                .font(.caption2)
                .foregroundStyle(PanelPalette.textMuted)

            CompactActionButton(title: "Save & reconnect", systemImage: "arrow.clockwise", tint: PanelPalette.accent, prominence: .filled, helpText: "") {
                model.setServerConnection(baseURL: serverDraft, authToken: authTokenDraft)
            }
            .disabled(
                serverDraft.trimmingCharacters(in: .whitespacesAndNewlines) == model.baseURLString &&
                authTokenDraft.trimmingCharacters(in: .whitespacesAndNewlines) == model.authTokenString
            )
        }
    }

    // MARK: - Voice

    private var voiceCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Voice", systemImage: "mic.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PanelPalette.textNormal)
                Spacer()
                statusChip(
                    text: model.voiceAuthorized ? "Granted" : "Not granted",
                    tint: model.voiceAuthorized ? PanelPalette.success : PanelPalette.warning
                )
            }

            Text(model.voiceAuthorized
                 ? "Tap the mic in a chat to talk; replies are read aloud. Voice: \(model.voiceName)."
                 : "Grant Microphone + Speech Recognition to talk to your agent hands-free.")
                .font(.caption)
                .foregroundStyle(PanelPalette.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            if !model.voiceAuthorized {
                CompactActionButton(title: "Grant voice access", systemImage: "mic", tint: PanelPalette.accent, prominence: .filled, helpText: "") {
                    model.requestVoicePermission()
                }
            }
        }
    }

    // MARK: - Location

    private var locationCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                Label("Location", systemImage: "location.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PanelPalette.textNormal)
                Spacer()
                statusChip(text: locationStatusText, tint: locationStatusTint)
            }

            Text("Rook loads a place's skills when you arrive. Background arrivals (app closed) need \u{201C}Always\u{201D}.")
                .font(.caption)
                .foregroundStyle(PanelPalette.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            switch model.locationProvider.authorizationStatus {
            case .notDetermined, .denied, .restricted:
                CompactActionButton(title: "Enable location", systemImage: "location", tint: PanelPalette.accent, prominence: .filled, helpText: "") {
                    model.enableLocation()
                }
            case .authorizedWhenInUse:
                CompactActionButton(title: "Upgrade to Always (background)", systemImage: "location.circle", tint: PanelPalette.warning, prominence: .filled, helpText: "") {
                    model.locationProvider.requestAuthorization()
                }
            default:
                EmptyView()
            }

            if model.locationProvider.authorizationStatus == .denied {
                Text("Location is denied — enable it in iOS Settings → Rook → Location.")
                    .font(.caption2)
                    .foregroundStyle(PanelPalette.warning)
            }

            if model.locationProvider.authorizationStatus == .authorizedAlways,
               model.locationProvider.motionAvailable,
               !model.locationProvider.motionRequested {
                CompactActionButton(title: "Enhance driving detection", systemImage: "car", tint: PanelPalette.accent, prominence: .subtle, helpText: "") {
                    model.locationProvider.requestMotion()
                }
                Text("Uses motion so Rook can skip places you only drive past.")
                    .font(.caption2)
                    .foregroundStyle(PanelPalette.textMuted)
            }

            Text("Define places with the map-pin button on the agent list.")
                .font(.caption2)
                .foregroundStyle(PanelPalette.textMuted)
        }
    }

    private var locationStatusText: String {
        switch model.locationProvider.authorizationStatus {
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "While Using"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not set"
        @unknown default: return "Unknown"
        }
    }

    private var locationStatusTint: Color {
        switch model.locationProvider.authorizationStatus {
        case .authorizedAlways: return PanelPalette.success
        case .authorizedWhenInUse: return PanelPalette.warning
        case .denied, .restricted: return PanelPalette.danger
        default: return PanelPalette.textMuted
        }
    }

    private func statusChip(text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.16)))
    }
}
