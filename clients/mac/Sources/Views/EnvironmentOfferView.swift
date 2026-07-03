import Foundation
import RookKit
import SwiftUI

/// Simple bundle-level approval UI: shows the offered bundle and the names of
/// the skills / MCP servers / apps it contains, then posts one of the four
/// decisions for that specific bundle hash.
struct EnvironmentOfferDetail: View {
    @ObservedObject var model: RookMacModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DetailHeader(
                title: "Bundle Offer",
                systemImage: "shippingbox",
                trailing: model.pendingOffer?.bundleId ?? ""
            ) {
                model.dismissOfferView()
            }

            if let offer = model.pendingOffer {
                sourceCard(offer)
                bundleSummaryCard(offer)
                decisionsCard
            } else {
                PanelCard {
                    Text("No pending bundle offer.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 80, alignment: .center)
                }
            }
        }
    }

    private func sourceCard(_ offer: EnvironmentOffer) -> some View {
        PanelCard {
            HStack(alignment: .top, spacing: 10) {
                StatusGlyph(systemImage: "shippingbox.fill", tint: PanelPalette.warning, size: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(offer.sourceName ?? offer.environmentId)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    Text("wants to load bundle \(offer.bundleId) into this agent session")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(offer.environmentId)
                        .font(.caption2.monospaced())
                        .foregroundStyle(PanelPalette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let url = offer.canonicalSourceUrl, !url.isEmpty {
                        Text(url)
                            .font(.caption2)
                            .foregroundStyle(PanelPalette.secondaryText)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
        }
    }

    private func bundleSummaryCard(_ offer: EnvironmentOffer) -> some View {
        PanelCard {
            VStack(alignment: .leading, spacing: 10) {
                Label(offer.bundleId, systemImage: "shippingbox")
                    .font(.subheadline)
                    .fontWeight(.semibold)

                capabilitySection(title: "Skills", systemImage: "wand.and.stars", items: offer.skills)
                capabilitySection(title: "MCP Servers", systemImage: "server.rack", items: offer.mcpServers)
                capabilitySection(title: "Apps", systemImage: "app.connected.to.app.below.fill", items: offer.apps)
            }
        }
    }

    private func capabilitySection(title: String, systemImage: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(PanelPalette.secondaryText)
            if items.isEmpty {
                Text("None")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items, id: \.self) { item in
                        HStack(spacing: 6) {
                            Circle()
                                .fill(Color.white.opacity(0.45))
                                .frame(width: 4, height: 4)
                            Text(item)
                                .font(.caption.monospaced())
                                .foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
    }

    private var decisionsCard: some View {
        PanelCard {
            HStack(spacing: 8) {
                CompactActionButton(title: "Allow this visit", systemImage: "checkmark", tint: PanelPalette.success, prominence: .filled, helpText: "Allow this bundle for this visit only") {
                    model.decideEnvironment("accept")
                }
                CompactActionButton(title: "Always allow", systemImage: "checkmark.seal", tint: PanelPalette.info, prominence: .filled, helpText: "Always allow this exact bundle") {
                    model.decideEnvironment("approve")
                }
            }
            HStack(spacing: 8) {
                CompactActionButton(title: "Not now", systemImage: "xmark", tint: PanelPalette.secondaryText, prominence: .subtle, helpText: "Skip this bundle for now") {
                    model.decideEnvironment("ignore")
                }
                CompactActionButton(title: "Never", systemImage: "nosign", tint: PanelPalette.danger, prominence: .subtle, helpText: "Never allow this exact bundle") {
                    model.decideEnvironment("reject")
                }
            }
        }
    }
}
