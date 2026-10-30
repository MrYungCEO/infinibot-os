import MoltbotKit
import SwiftUI

/// Business tab with Kingly Vault integration
/// Provides member management, analytics, and CRM statistics
struct BusinessTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var selectedSection: BusinessSection = .overview
    @State private var isConnected: Bool = false
    
    enum BusinessSection: String, CaseIterable {
        case overview = "Overview"
        case members = "Members"
        case analytics = "Analytics"
        case courses = "Courses"
        
        var icon: String {
            switch self {
            case .overview: return "chart.bar.fill"
            case .members: return "person.3.fill"
            case .analytics: return "chart.line.uptrend.xyaxis"
            case .courses: return "book.fill"
            }
        }
    }
    
    var body: some View {
        NavigationStack {
            ZStack {
                // Dark gradient background
                LinearGradient(
                    colors: [Color.black, Color(red: 0.08, green: 0.08, blue: 0.12)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
                
                if isConnected {
                    connectedContent
                } else {
                    disconnectedView
                }
            }
            .navigationTitle("Business")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    connectionStatusBadge
                }
            }
        }
        .onAppear {
            updateConnectionStatus()
        }
        .onChange(of: appModel.gatewayServerName) { _, _ in
            updateConnectionStatus()
        }
    }
    
    // MARK: - Views
    
    @ViewBuilder
    private var connectedContent: some View {
        VStack(spacing: 0) {
            // Section picker
            sectionPicker
                .padding(.horizontal)
                .padding(.top, 8)
            
            // Content based on selected section
            TabView(selection: $selectedSection) {
                VaultOverviewView()
                    .tag(BusinessSection.overview)
                
                VaultMembersView()
                    .tag(BusinessSection.members)
                
                VaultAnalyticsView()
                    .tag(BusinessSection.analytics)
                
                VaultCoursesView()
                    .tag(BusinessSection.courses)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
        }
    }
    
    @ViewBuilder
    private var sectionPicker: some View {
        HStack(spacing: 4) {
            ForEach(BusinessSection.allCases, id: \.self) { section in
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        selectedSection = section
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: section.icon)
                            .font(.system(size: 12, weight: .semibold))
                        Text(section.rawValue)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(selectedSection == section ? .black : .white.opacity(0.7))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        Capsule()
                            .fill(selectedSection == section ? Color.yellow : Color.white.opacity(0.1))
                    )
                }
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.ultraThinMaterial.opacity(0.3))
        )
    }
    
    @ViewBuilder
    private var disconnectedView: some View {
        VStack(spacing: 24) {
            ZStack {
                Circle()
                    .fill(Color.orange.opacity(0.15))
                    .frame(width: 80, height: 80)
                
                Image(systemName: "wifi.slash")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(.orange)
            }
            
            VStack(spacing: 8) {
                Text("Gateway Disconnected")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                
                Text("Connect to your Moltbot gateway to access Kingly Vault business features.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }
        }
        .padding()
    }
    
    @ViewBuilder
    private var connectionStatusBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(isConnected ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            
            Text(isConnected ? "Connected" : "Offline")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule()
                .fill(.ultraThinMaterial.opacity(0.5))
        )
    }
    
    // MARK: - Methods
    
    private func updateConnectionStatus() {
        isConnected = appModel.gatewayServerName != nil
    }
}

// MARK: - Overview View

struct VaultOverviewView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var stats: VaultStats?
    @State private var isLoading = true
    @State private var errorMessage: String?
    
    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if isLoading {
                    ProgressView()
                        .tint(.yellow)
                        .padding(.top, 60)
                } else if let error = errorMessage {
                    errorCard(message: error)
                } else if let stats = stats {
                    statsGrid(stats: stats)
                } else {
                    emptyState
                }
            }
            .padding()
        }
        .refreshable {
            await loadStats()
        }
        .task {
            await loadStats()
        }
    }
    
    @ViewBuilder
    private func statsGrid(stats: VaultStats) -> some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible())
        ], spacing: 16) {
            StatCard(
                title: "Total Members",
                value: "\(stats.totalMembers)",
                icon: "person.3.fill",
                color: .blue
            )
            
            StatCard(
                title: "Active (30d)",
                value: "\(stats.activeMembers)",
                icon: "person.fill.checkmark",
                color: .green
            )
            
            StatCard(
                title: "Premium",
                value: "\(stats.premiumMembers)",
                icon: "star.fill",
                color: .yellow
            )
            
            StatCard(
                title: "Courses",
                value: "\(stats.totalCourses)",
                icon: "book.fill",
                color: .purple
            )
        }
        
        // Quick stats row
        HStack(spacing: 16) {
            QuickStatPill(
                label: "VIP",
                value: "\(stats.vipMembers)",
                color: .orange
            )
            
            QuickStatPill(
                label: "Lifetime",
                value: "\(stats.lifetimeMembers)",
                color: .cyan
            )
            
            QuickStatPill(
                label: "New (7d)",
                value: "\(stats.newMembersWeek)",
                color: .mint
            )
        }
        .padding(.top, 8)
    }
    
    @ViewBuilder
    private func errorCard(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundStyle(.orange)
            
            Text("Failed to load stats")
                .font(.headline)
                .foregroundStyle(.white)
            
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            
            Button("Retry") {
                Task { await loadStats() }
            }
            .buttonStyle(.bordered)
            .tint(.yellow)
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
    }
    
    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "chart.bar.fill")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            
            Text("No data available")
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 60)
    }
    
    private func loadStats() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            let response = try await appModel.gatewaySession.request(
                method: "vault.get_stats",
                paramsJSON: "{}",
                timeoutSeconds: 15
            )
            
            let decoded = try JSONDecoder().decode(VaultStatsResponse.self, from: response)
            await MainActor.run {
                stats = decoded.stats
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Courses View

struct VaultCoursesView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var courses: [VaultCourse] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if isLoading {
                    ProgressView()
                        .tint(.yellow)
                        .padding(.top, 60)
                } else if let error = errorMessage {
                    errorView(message: error)
                } else if courses.isEmpty {
                    emptyState
                } else {
                    ForEach(courses, id: \.id) { course in
                        CourseCard(course: course)
                    }
                }
            }
            .padding()
        }
        .refreshable {
            await loadCourses()
        }
        .task {
            await loadCourses()
        }
    }
    
    @ViewBuilder
    private func errorView(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundStyle(.orange)
            
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            
            Button("Retry") {
                Task { await loadCourses() }
            }
            .buttonStyle(.bordered)
            .tint(.yellow)
        }
        .padding()
    }
    
    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "book.fill")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            
            Text("No courses yet")
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 60)
    }
    
    private func loadCourses() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            let response = try await appModel.gatewaySession.request(
                method: "vault.list_courses",
                paramsJSON: "{}",
                timeoutSeconds: 15
            )
            
            let decoded = try JSONDecoder().decode(VaultCoursesResponse.self, from: response)
            await MainActor.run {
                courses = decoded.courses
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Supporting Views

struct StatCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(color)
                Spacer()
            }
            
            Text(value)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.05))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(color.opacity(0.2), lineWidth: 1)
                )
        )
    }
}

struct QuickStatPill: View {
    let label: String
    let value: String
    let color: Color
    
    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(color)
            
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(color.opacity(0.1))
        )
    }
}

struct CourseCard: View {
    let course: VaultCourse
    
    var body: some View {
        HStack(spacing: 16) {
            // Course icon
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.purple.opacity(0.2))
                    .frame(width: 56, height: 56)
                
                Image(systemName: "book.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.purple)
            }
            
            // Course info
            VStack(alignment: .leading, spacing: 4) {
                Text(course.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                
                Text("\(course.enrolledCount) enrolled")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                
                // Progress indicator
                HStack(spacing: 6) {
                    Text(course.status.capitalized)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(course.status == "published" ? .green : .orange)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(
                            Capsule()
                                .fill((course.status == "published" ? Color.green : Color.orange).opacity(0.15))
                        )
                    
                    if let tier = course.requiredTier {
                        Text(tier.uppercased())
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.yellow)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(
                                Capsule()
                                    .fill(Color.yellow.opacity(0.15))
                            )
                    }
                }
            }
            
            Spacer()
            
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
    }
}

// MARK: - Data Models

struct VaultStats: Codable {
    let totalMembers: Int
    let activeMembers: Int
    let premiumMembers: Int
    let vipMembers: Int
    let lifetimeMembers: Int
    let newMembersWeek: Int
    let totalCourses: Int
    
    enum CodingKeys: String, CodingKey {
        case totalMembers = "total_members"
        case activeMembers = "active_members"
        case premiumMembers = "premium_members"
        case vipMembers = "vip_members"
        case lifetimeMembers = "lifetime_members"
        case newMembersWeek = "new_members_week"
        case totalCourses = "total_courses"
    }
}

struct VaultStatsResponse: Codable {
    let stats: VaultStats
}

struct VaultCourse: Codable {
    let id: String
    let title: String
    let status: String
    let enrolledCount: Int
    let requiredTier: String?
    
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case status
        case enrolledCount = "enrolled_count"
        case requiredTier = "required_tier"
    }
}

struct VaultCoursesResponse: Codable {
    let courses: [VaultCourse]
}

// MARK: - Preview

#Preview {
    BusinessTab()
}
