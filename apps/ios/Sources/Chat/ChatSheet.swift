import MoltbotChatUI
import MoltbotKit
import SwiftUI

/// Chat sheet with horizontal swipe navigation between sessions
struct ChatSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var viewModels: [String: MoltbotChatViewModel] = [:]
    @State private var sessions: [MoltbotChatSessionEntry] = []
    @State private var currentSessionIndex: Int = 0
    @State private var isLoadingSessions = true
    @State private var dragOffset: CGFloat = 0
    
    private let gateway: GatewayNodeSession
    private let initialSessionKey: String
    private let userAccent: Color?
    private let transport: IOSGatewayChatTransport

    init(gateway: GatewayNodeSession, sessionKey: String, userAccent: Color? = nil) {
        self.gateway = gateway
        self.initialSessionKey = sessionKey
        self.userAccent = userAccent
        self.transport = IOSGatewayChatTransport(gateway: gateway)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                // Dark background
                Color.black.ignoresSafeArea()
                
                if isLoadingSessions {
                    ProgressView()
                        .tint(.white)
                } else if sessions.isEmpty {
                    // Fallback to single session view
                    singleSessionView(sessionKey: initialSessionKey)
                } else {
                    swipeableSessionsView
                }
            }
            .navigationTitle(currentSessionTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    sessionIndicator
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundStyle(.white)
                    }
                    .accessibilityLabel("Close")
                }
            }
            .toolbarBackground(.black.opacity(0.9), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .task {
            await loadSessions()
        }
    }
    
    // MARK: - Views
    
    @ViewBuilder
    private var swipeableSessionsView: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                ForEach(Array(sessions.enumerated()), id: \.element.key) { index, session in
                    sessionView(for: session.key)
                        .frame(width: geometry.size.width)
                }
            }
            .offset(x: -CGFloat(currentSessionIndex) * geometry.size.width + dragOffset)
            .animation(.interactiveSpring(response: 0.35, dampingFraction: 0.86), value: currentSessionIndex)
            .gesture(
                DragGesture()
                    .onChanged { value in
                        // Only allow horizontal swiping
                        let translation = value.translation.width
                        
                        // Apply resistance at edges
                        if currentSessionIndex == 0 && translation > 0 {
                            dragOffset = translation * 0.3
                        } else if currentSessionIndex == sessions.count - 1 && translation < 0 {
                            dragOffset = translation * 0.3
                        } else {
                            dragOffset = translation
                        }
                    }
                    .onEnded { value in
                        let threshold: CGFloat = geometry.size.width * 0.25
                        let velocity = value.predictedEndTranslation.width - value.translation.width
                        
                        withAnimation(.interactiveSpring(response: 0.35, dampingFraction: 0.86)) {
                            if value.translation.width < -threshold || velocity < -500 {
                                // Swipe left → next session
                                if currentSessionIndex < sessions.count - 1 {
                                    currentSessionIndex += 1
                                    hapticFeedback()
                                }
                            } else if value.translation.width > threshold || velocity > 500 {
                                // Swipe right → previous session
                                if currentSessionIndex > 0 {
                                    currentSessionIndex -= 1
                                    hapticFeedback()
                                }
                            }
                            dragOffset = 0
                        }
                    }
            )
        }
    }
    
    @ViewBuilder
    private func sessionView(for sessionKey: String) -> some View {
        if let viewModel = viewModels[sessionKey] {
            MoltbotChatView(
                viewModel: viewModel,
                showsSessionSwitcher: false, // We handle session switching via swipe
                userAccent: userAccent)
        } else {
            ProgressView()
                .tint(.white)
                .onAppear {
                    createViewModel(for: sessionKey)
                }
        }
    }
    
    @ViewBuilder
    private func singleSessionView(sessionKey: String) -> some View {
        let viewModel = getOrCreateViewModel(for: sessionKey)
        MoltbotChatView(
            viewModel: viewModel,
            showsSessionSwitcher: true,
            userAccent: userAccent)
    }
    
    @ViewBuilder
    private var sessionIndicator: some View {
        if sessions.count > 1 {
            HStack(spacing: 6) {
                ForEach(0..<min(sessions.count, 7), id: \.self) { index in
                    Circle()
                        .fill(index == currentSessionIndex ? Color.yellow : Color.white.opacity(0.3))
                        .frame(width: index == currentSessionIndex ? 8 : 6, 
                               height: index == currentSessionIndex ? 8 : 6)
                        .animation(.spring(response: 0.25), value: currentSessionIndex)
                }
                
                if sessions.count > 7 {
                    Text("+\(sessions.count - 7)")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(.ultraThinMaterial.opacity(0.5))
            )
        }
    }
    
    // MARK: - Computed Properties
    
    private var currentSessionTitle: String {
        guard !sessions.isEmpty, currentSessionIndex < sessions.count else {
            return extractFriendlyName(initialSessionKey)
        }
        let session = sessions[currentSessionIndex]
        return session.displayName ?? extractFriendlyName(session.key)
    }
    
    // MARK: - Methods
    
    private func loadSessions() async {
        isLoadingSessions = true
        defer { isLoadingSessions = false }
        
        do {
            let response = try await transport.listSessions(limit: 50)
            
            // Sort by most recent first
            let sorted = response.sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            
            // Take recent sessions (last 24 hours or top 20)
            let now = Date().timeIntervalSince1970 * 1000
            let dayAgo = now - (24 * 60 * 60 * 1000)
            
            let recentSessions = sorted.filter { session in
                guard let updatedAt = session.updatedAt else { return false }
                return updatedAt >= dayAgo
            }.prefix(20)
            
            await MainActor.run {
                sessions = Array(recentSessions)
                
                // Find initial session index
                if let index = sessions.firstIndex(where: { $0.key == initialSessionKey }) {
                    currentSessionIndex = index
                } else if !sessions.isEmpty {
                    // Add initial session if not in list
                    sessions.insert(
                        MoltbotChatSessionEntry(
                            key: initialSessionKey,
                            kind: nil,
                            displayName: nil,
                            surface: nil,
                            subject: nil,
                            room: nil,
                            space: nil,
                            updatedAt: now,
                            sessionId: nil,
                            systemSent: nil,
                            abortedLastRun: nil,
                            thinkingLevel: nil,
                            verboseLevel: nil,
                            inputTokens: nil,
                            outputTokens: nil,
                            totalTokens: nil,
                            model: nil,
                            contextTokens: nil
                        ),
                        at: 0
                    )
                    currentSessionIndex = 0
                }
                
                // Pre-create viewModel for current session
                createViewModel(for: initialSessionKey)
            }
        } catch {
            // Fallback to single session mode
            await MainActor.run {
                sessions = []
                createViewModel(for: initialSessionKey)
            }
        }
    }
    
    private func createViewModel(for sessionKey: String) {
        guard viewModels[sessionKey] == nil else { return }
        let vm = MoltbotChatViewModel(sessionKey: sessionKey, transport: transport)
        viewModels[sessionKey] = vm
    }
    
    private func getOrCreateViewModel(for sessionKey: String) -> MoltbotChatViewModel {
        if let existing = viewModels[sessionKey] {
            return existing
        }
        let vm = MoltbotChatViewModel(sessionKey: sessionKey, transport: transport)
        viewModels[sessionKey] = vm
        return vm
    }
    
    private func extractFriendlyName(_ key: String) -> String {
        let parts = key.split(separator: ":")
        if let last = parts.last {
            let lastStr = String(last)
            if lastStr.hasPrefix("webchat-") {
                return "Chat \(lastStr.dropFirst(8).prefix(6))"
            }
            if lastStr == "main" {
                return "🜂 Main"
            }
            return lastStr.capitalized
        }
        return key
    }
    
    private func hapticFeedback() {
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.impactOccurred()
    }
}

// MARK: - Preview

#Preview {
    // Preview requires mock gateway
    Text("ChatSheet Preview")
}
