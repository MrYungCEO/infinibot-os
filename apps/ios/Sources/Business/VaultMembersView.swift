import MoltbotKit
import SwiftUI

/// Member management view for Kingly Vault
/// Supports searching, listing, and viewing member profiles
struct VaultMembersView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var members: [VaultMember] = []
    @State private var isLoading = false
    @State private var searchText = ""
    @State private var errorMessage: String?
    @State private var selectedMember: VaultMember?
    @State private var filterTier: MemberTier?
    @State private var sortOrder: MemberSortOrder = .recent
    
    enum MemberTier: String, CaseIterable {
        case all = "All"
        case free = "Free"
        case basic = "Basic"
        case premium = "Premium"
        case vip = "VIP"
        case lifetime = "Lifetime"
        
        var apiValue: String? {
            self == .all ? nil : rawValue.lowercased()
        }
    }
    
    enum MemberSortOrder: String, CaseIterable {
        case recent = "Recent"
        case name = "Name"
        case tier = "Tier"
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Search and filter bar
            searchFilterBar
                .padding(.horizontal)
                .padding(.vertical, 12)
            
            // Members list
            if isLoading && members.isEmpty {
                Spacer()
                ProgressView()
                    .tint(.yellow)
                Spacer()
            } else if let error = errorMessage, members.isEmpty {
                errorView(message: error)
            } else if filteredMembers.isEmpty {
                emptyState
            } else {
                membersList
            }
        }
        .sheet(item: $selectedMember) { member in
            MemberDetailSheet(member: member)
        }
        .task {
            await loadMembers()
        }
    }
    
    // MARK: - Views
    
    @ViewBuilder
    private var searchFilterBar: some View {
        VStack(spacing: 12) {
            // Search field
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                
                TextField("Search members...", text: $searchText)
                    .textFieldStyle(.plain)
                    .foregroundStyle(.white)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .onSubmit {
                        Task { await searchMembers() }
                    }
                
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        Task { await loadMembers() }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                
                Button {
                    Task { await searchMembers() }
                } label: {
                    Image(systemName: "arrow.right.circle.fill")
                        .foregroundStyle(.yellow)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(0.08))
            )
            
            // Filter chips
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    // Tier filter
                    ForEach(MemberTier.allCases, id: \.self) { tier in
                        FilterChip(
                            label: tier.rawValue,
                            isSelected: filterTier == tier || (filterTier == nil && tier == .all),
                            color: tierColor(tier)
                        ) {
                            withAnimation(.spring(response: 0.25)) {
                                filterTier = tier == .all ? nil : tier
                            }
                        }
                    }
                    
                    Divider()
                        .frame(height: 20)
                        .padding(.horizontal, 4)
                    
                    // Sort options
                    Menu {
                        ForEach(MemberSortOrder.allCases, id: \.self) { order in
                            Button {
                                sortOrder = order
                            } label: {
                                HStack {
                                    Text(order.rawValue)
                                    if sortOrder == order {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.up.arrow.down")
                            Text(sortOrder.rawValue)
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            Capsule()
                                .fill(Color.white.opacity(0.1))
                        )
                    }
                }
            }
        }
    }
    
    @ViewBuilder
    private var membersList: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(filteredMembers, id: \.id) { member in
                    MemberRow(member: member)
                        .onTapGesture {
                            selectedMember = member
                        }
                }
                
                if isLoading {
                    ProgressView()
                        .tint(.yellow)
                        .padding()
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 20)
        }
        .refreshable {
            await loadMembers()
        }
    }
    
    @ViewBuilder
    private func errorView(message: String) -> some View {
        Spacer()
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            
            Text("Failed to load members")
                .font(.headline)
                .foregroundStyle(.white)
            
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            
            Button("Retry") {
                Task { await loadMembers() }
            }
            .buttonStyle(.borderedProminent)
            .tint(.yellow)
        }
        Spacer()
    }
    
    @ViewBuilder
    private var emptyState: some View {
        Spacer()
        VStack(spacing: 16) {
            Image(systemName: searchText.isEmpty ? "person.3.fill" : "magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            
            Text(searchText.isEmpty ? "No members yet" : "No results")
                .font(.headline)
                .foregroundStyle(.secondary)
            
            if !searchText.isEmpty {
                Text("Try a different search term")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        Spacer()
    }
    
    // MARK: - Computed Properties
    
    private var filteredMembers: [VaultMember] {
        var result = members
        
        // Apply tier filter
        if let tier = filterTier, let apiValue = tier.apiValue {
            result = result.filter { $0.tier.lowercased() == apiValue }
        }
        
        // Apply sort
        switch sortOrder {
        case .recent:
            result.sort { ($0.joinedAt ?? "") > ($1.joinedAt ?? "") }
        case .name:
            result.sort { ($0.displayName ?? $0.discordUsername ?? "") < ($1.displayName ?? $1.discordUsername ?? "") }
        case .tier:
            let tierOrder = ["lifetime": 0, "vip": 1, "premium": 2, "basic": 3, "free": 4]
            result.sort { (tierOrder[$0.tier.lowercased()] ?? 5) < (tierOrder[$1.tier.lowercased()] ?? 5) }
        }
        
        return result
    }
    
    // MARK: - Methods
    
    private func tierColor(_ tier: MemberTier) -> Color {
        switch tier {
        case .all: return .white
        case .free: return .gray
        case .basic: return .blue
        case .premium: return .yellow
        case .vip: return .orange
        case .lifetime: return .cyan
        }
    }
    
    private func loadMembers() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            let params: [String: Any] = ["limit": 100]
            let paramsJSON = try JSONSerialization.data(withJSONObject: params)
            let paramsString = String(data: paramsJSON, encoding: .utf8) ?? "{}"
            
            let response = try await appModel.gatewaySession.request(
                method: "vault.list_members",
                paramsJSON: paramsString,
                timeoutSeconds: 15
            )
            
            let decoded = try JSONDecoder().decode(VaultMembersResponse.self, from: response)
            await MainActor.run {
                members = decoded.members
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func searchMembers() async {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            await loadMembers()
            return
        }
        
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            let params: [String: Any] = ["query": searchText, "limit": 50]
            let paramsJSON = try JSONSerialization.data(withJSONObject: params)
            let paramsString = String(data: paramsJSON, encoding: .utf8) ?? "{}"
            
            let response = try await appModel.gatewaySession.request(
                method: "vault.search_members",
                paramsJSON: paramsString,
                timeoutSeconds: 15
            )
            
            let decoded = try JSONDecoder().decode(VaultMembersResponse.self, from: response)
            await MainActor.run {
                members = decoded.members
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Supporting Views

struct FilterChip: View {
    let label: String
    let isSelected: Bool
    let color: Color
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(isSelected ? .black : color.opacity(0.8))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule()
                        .fill(isSelected ? color : color.opacity(0.15))
                )
        }
    }
}

struct MemberRow: View {
    let member: VaultMember
    
    var body: some View {
        HStack(spacing: 14) {
            // Avatar
            ZStack {
                Circle()
                    .fill(tierGradient)
                    .frame(width: 48, height: 48)
                
                Text(initials)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
            }
            
            // Info
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(member.displayName ?? member.discordUsername ?? "Unknown")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    
                    // Tier badge
                    Text(member.tier.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(tierColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill(tierColor.opacity(0.15))
                        )
                }
                
                HStack(spacing: 12) {
                    if let email = member.email {
                        Label(email, systemImage: "envelope.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    
                    if let joined = member.joinedAt {
                        Text(formatDate(joined))
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            
            Spacer()
            
            // Status indicator
            if member.status == "active" {
                Circle()
                    .fill(Color.green)
                    .frame(width: 8, height: 8)
            }
            
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
    }
    
    private var initials: String {
        let name = member.displayName ?? member.discordUsername ?? "?"
        let parts = name.split(separator: " ")
        if parts.count >= 2 {
            return "\(parts[0].prefix(1))\(parts[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }
    
    private var tierColor: Color {
        switch member.tier.lowercased() {
        case "lifetime": return .cyan
        case "vip": return .orange
        case "premium": return .yellow
        case "basic": return .blue
        default: return .gray
        }
    }
    
    private var tierGradient: LinearGradient {
        LinearGradient(
            colors: [tierColor.opacity(0.6), tierColor.opacity(0.3)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
    
    private func formatDate(_ isoDate: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if let date = formatter.date(from: isoDate) {
            let relative = RelativeDateTimeFormatter()
            relative.unitsStyle = .abbreviated
            return relative.localizedString(for: date, relativeTo: Date())
        }
        return isoDate.prefix(10).description
    }
}

// MARK: - Member Detail Sheet

struct MemberDetailSheet: View {
    let member: VaultMember
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    memberHeader
                    
                    // Stats
                    statsSection
                    
                    // Info sections
                    infoSection
                    
                    // Tags
                    if let tags = member.tags, !tags.isEmpty {
                        tagsSection(tags: tags)
                    }
                    
                    // Notes
                    if let notes = member.notes, !notes.isEmpty {
                        notesSection(notes: notes)
                    }
                }
                .padding()
            }
            .background(Color.black)
            .navigationTitle("Member Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundStyle(.white)
                    }
                }
            }
            .toolbarBackground(.black.opacity(0.9), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
    
    @ViewBuilder
    private var memberHeader: some View {
        VStack(spacing: 16) {
            // Large avatar
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [tierColor.opacity(0.6), tierColor.opacity(0.3)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 80, height: 80)
                
                Text(initials)
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.white)
            }
            
            VStack(spacing: 8) {
                Text(member.displayName ?? member.discordUsername ?? "Unknown")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                
                // Tier badge
                HStack(spacing: 8) {
                    Text(member.tier.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(tierColor)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(tierColor.opacity(0.15))
                        )
                    
                    if member.status == "active" {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(Color.green)
                                .frame(width: 6, height: 6)
                            Text("Active")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.green)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(Color.green.opacity(0.15))
                        )
                    }
                }
            }
        }
    }
    
    @ViewBuilder
    private var statsSection: some View {
        HStack(spacing: 0) {
            StatItem(label: "Courses", value: "\(member.coursesEnrolled ?? 0)")
            Divider().frame(height: 40)
            StatItem(label: "Progress", value: "\(member.averageProgress ?? 0)%")
            Divider().frame(height: 40)
            StatItem(label: "Warnings", value: "\(member.warningCount ?? 0)")
        }
        .padding(.vertical, 16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
    }
    
    @ViewBuilder
    private var infoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Information")
            
            VStack(spacing: 8) {
                if let email = member.email {
                    InfoRow(icon: "envelope.fill", label: "Email", value: email)
                }
                
                if let discordId = member.discordId {
                    InfoRow(icon: "person.fill", label: "Discord ID", value: discordId)
                }
                
                if let joined = member.joinedAt {
                    InfoRow(icon: "calendar", label: "Joined", value: formatFullDate(joined))
                }
                
                if let lastActive = member.lastActiveAt {
                    InfoRow(icon: "clock.fill", label: "Last Active", value: formatFullDate(lastActive))
                }
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
        }
    }
    
    @ViewBuilder
    private func tagsSection(tags: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Tags")
            
            FlowLayout(spacing: 8) {
                ForEach(tags, id: \.self) { tag in
                    Text(tag)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            Capsule()
                                .fill(Color.blue.opacity(0.3))
                        )
                }
            }
        }
    }
    
    @ViewBuilder
    private func notesSection(notes: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Notes")
            
            Text(notes)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
        }
    }
    
    // MARK: - Helpers
    
    private var initials: String {
        let name = member.displayName ?? member.discordUsername ?? "?"
        let parts = name.split(separator: " ")
        if parts.count >= 2 {
            return "\(parts[0].prefix(1))\(parts[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }
    
    private var tierColor: Color {
        switch member.tier.lowercased() {
        case "lifetime": return .cyan
        case "vip": return .orange
        case "premium": return .yellow
        case "basic": return .blue
        default: return .gray
        }
    }
    
    private func formatFullDate(_ isoDate: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if let date = formatter.date(from: isoDate) {
            let display = DateFormatter()
            display.dateStyle = .medium
            display.timeStyle = .short
            return display.string(from: date)
        }
        return isoDate
    }
}

// MARK: - Helper Views

struct StatItem: View {
    let label: String
    let value: String
    
    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

struct SectionHeader: View {
    let title: String
    
    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(.secondary)
            .tracking(0.5)
    }
}

struct InfoRow: View {
    let icon: String
    let label: String
    let value: String
    
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(.yellow)
                .frame(width: 20)
            
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            
            Spacer()
            
            Text(value)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var lineHeight: CGFloat = 0
        
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            
            if currentX + size.width > maxWidth {
                currentX = 0
                currentY += lineHeight + spacing
                lineHeight = 0
            }
            
            currentX += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        
        return CGSize(width: maxWidth, height: currentY + lineHeight)
    }
    
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var currentX: CGFloat = bounds.minX
        var currentY: CGFloat = bounds.minY
        var lineHeight: CGFloat = 0
        
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            
            if currentX + size.width > bounds.maxX {
                currentX = bounds.minX
                currentY += lineHeight + spacing
                lineHeight = 0
            }
            
            subview.place(at: CGPoint(x: currentX, y: currentY), proposal: .unspecified)
            currentX += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

// MARK: - Data Models

struct VaultMember: Codable, Identifiable {
    let id: String
    let discordId: String?
    let discordUsername: String?
    let displayName: String?
    let email: String?
    let tier: String
    let status: String
    let joinedAt: String?
    let lastActiveAt: String?
    let coursesEnrolled: Int?
    let averageProgress: Int?
    let warningCount: Int?
    let tags: [String]?
    let notes: String?
    
    enum CodingKeys: String, CodingKey {
        case id
        case discordId = "discord_id"
        case discordUsername = "discord_username"
        case displayName = "display_name"
        case email
        case tier
        case status
        case joinedAt = "joined_at"
        case lastActiveAt = "last_active_at"
        case coursesEnrolled = "courses_enrolled"
        case averageProgress = "average_progress"
        case warningCount = "warning_count"
        case tags
        case notes
    }
}

struct VaultMembersResponse: Codable {
    let members: [VaultMember]
}

// MARK: - Preview

#Preview {
    VaultMembersView()
}
