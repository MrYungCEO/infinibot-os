import SwiftUI
import Observation

/// Mobile-optimized session sidebar that slides in from the left
/// Matches the web UI masonry grid session management
@MainActor
public struct ChatSessionsSidebar: View {
    @Bindable var viewModel: MoltbotChatViewModel
    @Binding var isPresented: Bool
    @State private var searchText = ""
    @State private var renamingSessionKey: String?
    @State private var renameText = ""
    @State private var showNewSessionSheet = false
    
    public init(viewModel: MoltbotChatViewModel, isPresented: Binding<Bool>) {
        self._viewModel = Bindable(viewModel)
        self._isPresented = isPresented
    }
    
    public var body: some View {
        ZStack(alignment: .leading) {
            // Dimmed background
            if isPresented {
                Color.black.opacity(0.4)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            isPresented = false
                        }
                    }
            }
            
            // Sidebar panel
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    sidebarHeader
                    searchBar
                    sessionsList
                    newSessionButton
                }
                .frame(width: min(UIScreen.main.bounds.width * 0.8, 320))
                .background(Color(uiColor: .systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 0))
                .shadow(color: .black.opacity(0.2), radius: 20, x: 10)
                .offset(x: isPresented ? 0 : -340)
                
                Spacer()
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: isPresented)
        .onAppear {
            viewModel.refreshSessions(limit: 200)
        }
        .sheet(isPresented: $showNewSessionSheet) {
            NewSessionSheet(viewModel: viewModel, isPresented: $showNewSessionSheet)
        }
    }
    
    private var sidebarHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Sessions")
                    .font(.title2.weight(.bold))
                Text("\(filteredSessions.count) sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            
            Spacer()
            
            Button {
                viewModel.refreshSessions(limit: 200)
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 16, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    isPresented = false
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(uiColor: .secondarySystemBackground))
    }
    
    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            
            TextField("Search sessions...", text: $searchText)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
            
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(uiColor: .tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
    
    private var filteredSessions: [MoltbotChatSessionEntry] {
        let sessions = viewModel.sessions
        if searchText.isEmpty {
            return sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        }
        let query = searchText.lowercased()
        return sessions.filter { session in
            let name = (session.displayName ?? session.key).lowercased()
            return name.contains(query)
        }.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }
    
    private var sessionsList: some View {
        ScrollView {
            LazyVStack(spacing: 4) {
                // Active sessions section
                if !activeSessions.isEmpty {
                    sessionSection(title: "Active", sessions: activeSessions, icon: "circle.fill", tint: .green)
                }
                
                // Recent sessions section
                if !recentSessions.isEmpty {
                    sessionSection(title: "Recent", sessions: recentSessions, icon: "clock", tint: .secondary)
                }
                
                // Older sessions section
                if !olderSessions.isEmpty {
                    sessionSection(title: "Older", sessions: olderSessions, icon: "archivebox", tint: .secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }
    
    private var activeSessions: [MoltbotChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let thirtyMinutesAgo = now - (30 * 60 * 1000)
        return filteredSessions.filter { ($0.updatedAt ?? 0) >= thirtyMinutesAgo }
    }
    
    private var recentSessions: [MoltbotChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let thirtyMinutesAgo = now - (30 * 60 * 1000)
        let oneDayAgo = now - (24 * 60 * 60 * 1000)
        return filteredSessions.filter { session in
            guard let ts = session.updatedAt else { return false }
            return ts < thirtyMinutesAgo && ts >= oneDayAgo
        }
    }
    
    private var olderSessions: [MoltbotChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let oneDayAgo = now - (24 * 60 * 60 * 1000)
        return filteredSessions.filter { ($0.updatedAt ?? 0) < oneDayAgo }
    }
    
    @ViewBuilder
    private func sessionSection(title: String, sessions: [MoltbotChatSessionEntry], icon: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(tint)
                Text(title.uppercased())
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.5)
                Text("(\(sessions.count))")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.top, 12)
            
            ForEach(sessions) { session in
                sessionRow(session)
            }
        }
    }
    
    @ViewBuilder
    private func sessionRow(_ session: MoltbotChatSessionEntry) -> some View {
        let isCurrentSession = session.key == viewModel.sessionKey
        let isRenaming = renamingSessionKey == session.key
        
        HStack(spacing: 12) {
            // Session icon
            ZStack {
                Circle()
                    .fill(isCurrentSession ? Color.accentColor.opacity(0.15) : Color(uiColor: .tertiarySystemBackground))
                    .frame(width: 36, height: 36)
                
                Text(sessionIcon(for: session))
                    .font(.system(size: 14))
            }
            
            VStack(alignment: .leading, spacing: 3) {
                if isRenaming {
                    TextField("Session name", text: $renameText)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14, weight: .semibold))
                        .onSubmit {
                            submitRename(for: session)
                        }
                } else {
                    Text(session.displayName ?? extractFriendlyName(session.key))
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                }
                
                HStack(spacing: 6) {
                    if let tokens = session.totalTokens, tokens > 0 {
                        Text(formatTokens(tokens))
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundStyle(.orange)
                    }
                    
                    if let updatedAt = session.updatedAt, updatedAt > 0 {
                        Text(formatRelativeTime(updatedAt))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            
            Spacer()
            
            if isCurrentSession {
                Text("ACTIVE")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.green)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.green.opacity(0.15))
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(isCurrentSession ? Color.accentColor.opacity(0.08) : Color(uiColor: .secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isCurrentSession ? Color.accentColor.opacity(0.3) : Color.clear, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            selectSession(session)
        }
        .contextMenu {
            Button {
                startRenaming(session)
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            
            Button {
                copySessionKey(session)
            } label: {
                Label("Copy Session Key", systemImage: "doc.on.doc")
            }
            
            Divider()
            
            Button(role: .destructive) {
                // TODO: Implement session deletion
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
    
    private var newSessionButton: some View {
        Button {
            showNewSessionSheet = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 18))
                Text("New Session")
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
    }
    
    // MARK: - Helpers
    
    private func sessionIcon(for session: MoltbotChatSessionEntry) -> String {
        let key = session.key.lowercased()
        if key.contains("coder") { return "💻" }
        if key.contains("opus") { return "🧠" }
        if key.contains("fast") { return "⚡" }
        if key.contains("webchat") { return "💬" }
        if key.contains("telegram") { return "✈️" }
        if key.contains("whatsapp") { return "📱" }
        if key.contains("discord") { return "🎮" }
        return "🜂"
    }
    
    private func extractFriendlyName(_ key: String) -> String {
        let parts = key.split(separator: ":")
        if let last = parts.last {
            let lastStr = String(last)
            if lastStr.hasPrefix("webchat-") {
                return "Chat \(lastStr.dropFirst(8).prefix(6))"
            }
            return lastStr
        }
        return key
    }
    
    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }
    
    private func formatRelativeTime(_ timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
    
    private func selectSession(_ session: MoltbotChatSessionEntry) {
        viewModel.switchSession(to: session.key)
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            isPresented = false
        }
    }
    
    private func startRenaming(_ session: MoltbotChatSessionEntry) {
        renameText = session.displayName ?? extractFriendlyName(session.key)
        renamingSessionKey = session.key
    }
    
    private func submitRename(for session: MoltbotChatSessionEntry) {
        guard !renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            renamingSessionKey = nil
            return
        }
        
        Task {
            await viewModel.renameSession(sessionKey: session.key, newName: renameText)
            renamingSessionKey = nil
        }
    }
    
    private func copySessionKey(_ session: MoltbotChatSessionEntry) {
        UIPasteboard.general.string = session.key
    }
}

// MARK: - New Session Sheet

@MainActor
private struct NewSessionSheet: View {
    @Bindable var viewModel: MoltbotChatViewModel
    @Binding var isPresented: Bool
    @State private var sessionName = ""
    @State private var selectedAgent = "main"
    
    private let agents = [
        ("main", "🜂 Infini", "General assistant"),
        ("coder", "💻 Coder", "Code-focused tasks"),
        ("opus", "🧠 Deep Thinker", "Complex reasoning"),
        ("fast", "⚡ Quick", "Fast responses"),
    ]
    
    var body: some View {
        NavigationStack {
            Form {
                Section("Session Details") {
                    TextField("Session Name (optional)", text: $sessionName)
                    
                    Picker("Agent", selection: $selectedAgent) {
                        ForEach(agents, id: \.0) { agent in
                            HStack {
                                Text(agent.1)
                                Text(agent.2)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .tag(agent.0)
                        }
                    }
                }
                
                Section {
                    Button {
                        createSession()
                    } label: {
                        HStack {
                            Spacer()
                            Text("Create Session")
                                .font(.headline)
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        isPresented = false
                    }
                }
            }
        }
    }
    
    private func createSession() {
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let sessionKey = "agent:\(selectedAgent):mobile-\(timestamp)"
        viewModel.switchSession(to: sessionKey)
        isPresented = false
    }
}
