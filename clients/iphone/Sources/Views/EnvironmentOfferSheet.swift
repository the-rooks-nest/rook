import RookKit
import SwiftUI

/// Bundle-level approval sheet for iPhone: shows the offered bundle and the
/// names of the skills / MCP servers / apps it contains.
struct EnvironmentOfferSheet: View {
    @ObservedObject var model: RookModel

    var body: some View {
        NavigationStack {
            ZStack {
                PanelBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        sourceCard
                        if let offer = model.pendingOffer {
                            bundleCard(offer)
                        }
                        decisionButtons
                    }
                    .padding(16)
                }
            }
            .navigationTitle("New bundle")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { model.decideEnvironment("ignore") }
                        .foregroundStyle(PanelPalette.textMuted)
                }
            }
        }
        .tint(PanelPalette.accent)
    }

    private var sourceCard: some View {
        PanelCard {
            HStack(spacing: 10) {
                Image(systemName: "shippingbox.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PanelPalette.accentHover)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(PanelPalette.accent.opacity(0.18)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.pendingOffer?.sourceName ?? model.pendingOffer?.environmentId ?? "")
                        .font(.headline)
                        .foregroundStyle(PanelPalette.textNormal)
                    Text("wants to load bundle \(model.pendingOffer?.bundleId ?? "") into this session")
                        .font(.caption)
                        .foregroundStyle(PanelPalette.textMuted)
                    if let environmentId = model.pendingOffer?.environmentId {
                        Text(environmentId)
                            .font(.caption2.monospaced())
                            .foregroundStyle(PanelPalette.textMuted)
                    }
                }
            }
        }
    }

    private func bundleCard(_ offer: EnvironmentOffer) -> some View {
        PanelCard {
            VStack(alignment: .leading, spacing: 10) {
                Text(offer.bundleId)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PanelPalette.textNormal)
                capabilitySection("Skills", systemImage: "wand.and.stars", items: offer.skills)
                capabilitySection("MCP Servers", systemImage: "server.rack", items: offer.mcpServers)
                capabilitySection("Apps", systemImage: "app.connected.to.app.below.fill", items: offer.apps)
            }
        }
    }

    private func capabilitySection(_ title: String, systemImage: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(PanelPalette.textMuted)
            if items.isEmpty {
                Text("None")
                    .font(.caption)
                    .foregroundStyle(PanelPalette.textMuted)
            } else {
                ForEach(items, id: \.self) { item in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(PanelPalette.textMuted.opacity(0.8))
                            .frame(width: 4, height: 4)
                        Text(item)
                            .font(.caption.monospaced())
                            .foregroundStyle(PanelPalette.textNormal)
                    }
                }
            }
        }
    }

    private var decisionButtons: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                CompactActionButton(title: "Allow this visit", systemImage: "checkmark", tint: PanelPalette.success, prominence: .filled, helpText: "") {
                    model.decideEnvironment("accept")
                }
                CompactActionButton(title: "Always allow", systemImage: "checkmark.seal", tint: PanelPalette.info, prominence: .filled, helpText: "") {
                    model.decideEnvironment("approve")
                }
            }
            HStack(spacing: 8) {
                CompactActionButton(title: "Not now", systemImage: "xmark", tint: PanelPalette.secondaryText, prominence: .subtle, helpText: "") {
                    model.decideEnvironment("ignore")
                }
                CompactActionButton(title: "Never", systemImage: "nosign", tint: PanelPalette.danger, prominence: .subtle, helpText: "") {
                    model.decideEnvironment("reject")
                }
            }
        }
    }
}
