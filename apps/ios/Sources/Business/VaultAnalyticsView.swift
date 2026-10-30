import MoltbotKit
import SwiftUI

/// Analytics dashboard for Kingly Vault
/// Displays engagement metrics, trends, and course performance
struct VaultAnalyticsView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var analytics: VaultAnalytics?
    @State private var engagementReport: EngagementReport?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var selectedPeriod: AnalyticsPeriod = .week
    
    enum AnalyticsPeriod: String, CaseIterable {
        case day = "24h"
        case week = "7d"
        case month = "30d"
        case all = "All"
        
        var apiValue: String {
            switch self {
            case .day: return "day"
            case .week: return "week"
            case .month: return "month"
            case .all: return "all"
            }
        }
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // Period selector
                periodSelector
                    .padding(.horizontal)
                
                if isLoading {
                    loadingView
                } else if let error = errorMessage {
                    errorView(message: error)
                } else {
                    analyticsContent
                }
            }
            .padding(.vertical)
        }
        .refreshable {
            await loadAnalytics()
        }
        .task {
            await loadAnalytics()
        }
        .onChange(of: selectedPeriod) { _, _ in
            Task { await loadAnalytics() }
        }
    }
    
    // MARK: - Views
    
    @ViewBuilder
    private var periodSelector: some View {
        HStack(spacing: 4) {
            ForEach(AnalyticsPeriod.allCases, id: \.self) { period in
                Button {
                    withAnimation(.spring(response: 0.25)) {
                        selectedPeriod = period
                    }
                } label: {
                    Text(period.rawValue)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(selectedPeriod == period ? .black : .white.opacity(0.6))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(
                            Capsule()
                                .fill(selectedPeriod == period ? Color.yellow : Color.white.opacity(0.08))
                        )
                }
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
    }
    
    @ViewBuilder
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(.yellow)
            
            Text("Loading analytics...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
    
    @ViewBuilder
    private func errorView(message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            
            Text("Failed to load analytics")
                .font(.headline)
                .foregroundStyle(.white)
            
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            
            Button("Retry") {
                Task { await loadAnalytics() }
            }
            .buttonStyle(.borderedProminent)
            .tint(.yellow)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }
    
    @ViewBuilder
    private var analyticsContent: some View {
        VStack(spacing: 24) {
            // Key metrics
            if let analytics = analytics {
                keyMetricsSection(analytics: analytics)
            }
            
            // Engagement report
            if let report = engagementReport {
                engagementSection(report: report)
            }
            
            // Growth trends
            if let analytics = analytics {
                growthSection(analytics: analytics)
            }
            
            // Activity breakdown
            if let report = engagementReport {
                activityBreakdownSection(report: report)
            }
        }
        .padding(.horizontal)
    }
    
    @ViewBuilder
    private func keyMetricsSection(analytics: VaultAnalytics) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Key Metrics", icon: "chart.bar.fill")
            
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                MetricCard(
                    title: "Active Users",
                    value: "\(analytics.activeUsers)",
                    change: analytics.activeUsersChange,
                    icon: "person.fill",
                    color: .green
                )
                
                MetricCard(
                    title: "Messages",
                    value: formatNumber(analytics.totalMessages),
                    change: analytics.messagesChange,
                    icon: "bubble.left.fill",
                    color: .blue
                )
                
                MetricCard(
                    title: "Course Views",
                    value: formatNumber(analytics.courseViews),
                    change: analytics.courseViewsChange,
                    icon: "book.fill",
                    color: .purple
                )
                
                MetricCard(
                    title: "Completions",
                    value: "\(analytics.courseCompletions)",
                    change: analytics.completionsChange,
                    icon: "checkmark.circle.fill",
                    color: .mint
                )
            }
        }
    }
    
    @ViewBuilder
    private func engagementSection(report: EngagementReport) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Engagement", icon: "heart.fill")
            
            VStack(spacing: 16) {
                // Engagement score
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Engagement Score")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                        
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text("\(report.engagementScore)")
                                .font(.system(size: 36, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                            
                            Text("/ 100")
                                .font(.system(size: 16, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                    
                    Spacer()
                    
                    // Score ring
                    ZStack {
                        Circle()
                            .stroke(Color.white.opacity(0.1), lineWidth: 8)
                            .frame(width: 60, height: 60)
                        
                        Circle()
                            .trim(from: 0, to: CGFloat(report.engagementScore) / 100)
                            .stroke(
                                scoreGradient(score: report.engagementScore),
                                style: StrokeStyle(lineWidth: 8, lineCap: .round)
                            )
                            .frame(width: 60, height: 60)
                            .rotationEffect(.degrees(-90))
                        
                        Text(scoreEmoji(score: report.engagementScore))
                            .font(.system(size: 20))
                    }
                }
                
                Divider()
                    .background(Color.white.opacity(0.1))
                
                // Engagement breakdown
                HStack(spacing: 20) {
                    EngagementStat(label: "Daily Active", value: "\(report.dailyActive)", color: .green)
                    EngagementStat(label: "Weekly Active", value: "\(report.weeklyActive)", color: .blue)
                    EngagementStat(label: "Retention", value: "\(report.retentionRate)%", color: .orange)
                }
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
        }
    }
    
    @ViewBuilder
    private func growthSection(analytics: VaultAnalytics) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Growth", icon: "arrow.up.right")
            
            VStack(spacing: 12) {
                GrowthRow(
                    label: "New Members",
                    value: "+\(analytics.newMembers)",
                    trend: analytics.newMembersTrend,
                    color: .green
                )
                
                GrowthRow(
                    label: "Churned",
                    value: "-\(analytics.churnedMembers)",
                    trend: analytics.churnTrend,
                    color: .red,
                    invertTrend: true
                )
                
                GrowthRow(
                    label: "Upgrades",
                    value: "+\(analytics.upgrades)",
                    trend: analytics.upgradesTrend,
                    color: .yellow
                )
                
                Divider()
                    .background(Color.white.opacity(0.1))
                
                HStack {
                    Text("Net Growth")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                    
                    Spacer()
                    
                    let net = analytics.newMembers - analytics.churnedMembers
                    Text(net >= 0 ? "+\(net)" : "\(net)")
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundStyle(net >= 0 ? .green : .red)
                }
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
        }
    }
    
    @ViewBuilder
    private func activityBreakdownSection(report: EngagementReport) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Activity Breakdown", icon: "chart.pie.fill")
            
            VStack(spacing: 12) {
                ForEach(report.activityBreakdown, id: \.category) { item in
                    ActivityRow(item: item)
                }
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
        }
    }
    
    // MARK: - Helper Views
    
    private func scoreGradient(score: Int) -> LinearGradient {
        let color: Color = switch score {
        case 80...100: .green
        case 60..<80: .yellow
        case 40..<60: .orange
        default: .red
        }
        
        return LinearGradient(
            colors: [color.opacity(0.8), color],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
    
    private func scoreEmoji(score: Int) -> String {
        switch score {
        case 80...100: return "🔥"
        case 60..<80: return "👍"
        case 40..<60: return "😐"
        default: return "📉"
        }
    }
    
    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }
    
    // MARK: - Data Loading
    
    private func loadAnalytics() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            // Load analytics and engagement report in parallel
            async let analyticsTask = loadVaultAnalytics()
            async let engagementTask = loadEngagementReport()
            
            let (analyticsResult, engagementResult) = await (
                try analyticsTask,
                try engagementTask
            )
            
            await MainActor.run {
                analytics = analyticsResult
                engagementReport = engagementResult
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func loadVaultAnalytics() async throws -> VaultAnalytics {
        let params: [String: Any] = ["period": selectedPeriod.apiValue]
        let paramsJSON = try JSONSerialization.data(withJSONObject: params)
        let paramsString = String(data: paramsJSON, encoding: .utf8) ?? "{}"
        
        let response = try await appModel.gatewaySession.request(
            method: "vault.get_analytics",
            paramsJSON: paramsString,
            timeoutSeconds: 15
        )
        
        let decoded = try JSONDecoder().decode(VaultAnalyticsResponse.self, from: response)
        return decoded.analytics
    }
    
    private func loadEngagementReport() async throws -> EngagementReport {
        let params: [String: Any] = ["period": selectedPeriod.apiValue]
        let paramsJSON = try JSONSerialization.data(withJSONObject: params)
        let paramsString = String(data: paramsJSON, encoding: .utf8) ?? "{}"
        
        let response = try await appModel.gatewaySession.request(
            method: "vault.engagement_report",
            paramsJSON: paramsString,
            timeoutSeconds: 15
        )
        
        let decoded = try JSONDecoder().decode(EngagementReportResponse.self, from: response)
        return decoded.report
    }
}

// MARK: - Supporting Views

struct SectionTitle: View {
    let title: String
    let icon: String
    
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.yellow)
            
            Text(title.uppercased())
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.secondary)
                .tracking(0.5)
        }
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    let change: Double?
    let icon: String
    let color: Color
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(color)
                
                Spacer()
                
                if let change = change {
                    HStack(spacing: 2) {
                        Image(systemName: change >= 0 ? "arrow.up" : "arrow.down")
                            .font(.system(size: 8, weight: .bold))
                        Text(String(format: "%.1f%%", abs(change)))
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(change >= 0 ? .green : .red)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill((change >= 0 ? Color.green : Color.red).opacity(0.15))
                    )
                }
            }
            
            Text(value)
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.05))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(color.opacity(0.15), lineWidth: 1)
                )
        )
    }
}

struct EngagementStat: View {
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
        .frame(maxWidth: .infinity)
    }
}

struct GrowthRow: View {
    let label: String
    let value: String
    let trend: Double?
    let color: Color
    var invertTrend: Bool = false
    
    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            
            Spacer()
            
            Text(value)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(color)
            
            if let trend = trend {
                let isGood = invertTrend ? (trend <= 0) : (trend >= 0)
                HStack(spacing: 2) {
                    Image(systemName: trend >= 0 ? "arrow.up" : "arrow.down")
                        .font(.system(size: 8, weight: .bold))
                    Text(String(format: "%.0f%%", abs(trend)))
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(isGood ? .green : .red)
            }
        }
    }
}

struct ActivityRow: View {
    let item: ActivityBreakdownItem
    
    var body: some View {
        HStack(spacing: 12) {
            // Category icon
            ZStack {
                Circle()
                    .fill(categoryColor.opacity(0.2))
                    .frame(width: 32, height: 32)
                
                Image(systemName: categoryIcon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(categoryColor)
            }
            
            // Label and bar
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(item.category)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white)
                    
                    Spacer()
                    
                    Text("\(item.count)")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(categoryColor)
                    
                    Text("(\(item.percentage)%)")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                
                // Progress bar
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color.white.opacity(0.1))
                            .frame(height: 6)
                        
                        RoundedRectangle(cornerRadius: 3)
                            .fill(categoryColor)
                            .frame(width: geo.size.width * CGFloat(item.percentage) / 100, height: 6)
                    }
                }
                .frame(height: 6)
            }
        }
    }
    
    private var categoryColor: Color {
        switch item.category.lowercased() {
        case "messages": return .blue
        case "course_views", "courses": return .purple
        case "logins": return .green
        case "reactions": return .orange
        case "completions": return .mint
        default: return .gray
        }
    }
    
    private var categoryIcon: String {
        switch item.category.lowercased() {
        case "messages": return "bubble.left.fill"
        case "course_views", "courses": return "book.fill"
        case "logins": return "person.fill"
        case "reactions": return "heart.fill"
        case "completions": return "checkmark.circle.fill"
        default: return "circle.fill"
        }
    }
}

// MARK: - Data Models

struct VaultAnalytics: Codable {
    let activeUsers: Int
    let activeUsersChange: Double?
    let totalMessages: Int
    let messagesChange: Double?
    let courseViews: Int
    let courseViewsChange: Double?
    let courseCompletions: Int
    let completionsChange: Double?
    let newMembers: Int
    let newMembersTrend: Double?
    let churnedMembers: Int
    let churnTrend: Double?
    let upgrades: Int
    let upgradesTrend: Double?
    
    enum CodingKeys: String, CodingKey {
        case activeUsers = "active_users"
        case activeUsersChange = "active_users_change"
        case totalMessages = "total_messages"
        case messagesChange = "messages_change"
        case courseViews = "course_views"
        case courseViewsChange = "course_views_change"
        case courseCompletions = "course_completions"
        case completionsChange = "completions_change"
        case newMembers = "new_members"
        case newMembersTrend = "new_members_trend"
        case churnedMembers = "churned_members"
        case churnTrend = "churn_trend"
        case upgrades
        case upgradesTrend = "upgrades_trend"
    }
}

struct VaultAnalyticsResponse: Codable {
    let analytics: VaultAnalytics
}

struct EngagementReport: Codable {
    let engagementScore: Int
    let dailyActive: Int
    let weeklyActive: Int
    let retentionRate: Int
    let activityBreakdown: [ActivityBreakdownItem]
    
    enum CodingKeys: String, CodingKey {
        case engagementScore = "engagement_score"
        case dailyActive = "daily_active"
        case weeklyActive = "weekly_active"
        case retentionRate = "retention_rate"
        case activityBreakdown = "activity_breakdown"
    }
}

struct ActivityBreakdownItem: Codable {
    let category: String
    let count: Int
    let percentage: Int
}

struct EngagementReportResponse: Codable {
    let report: EngagementReport
}

// MARK: - Preview

#Preview {
    VaultAnalyticsView()
}
