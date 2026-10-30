import SwiftUI

/// Focus tab - Priority board with up to 5 high-priority items
/// Connects to gateway focus.* methods for sync across devices
struct FocusTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var focusItems: [FocusItem] = []
    @State private var availableTasks: [KanbanTask] = []
    @State private var availableProjects: [KanbanProject] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showingSourceSheet = false
    @State private var sourceFilter: SourceFilter = .all
    @State private var searchText = ""
    @State private var isConnected = false
    
    enum SourceFilter: String, CaseIterable {
        case all = "All"
        case tasks = "Tasks"
        case projects = "Projects"
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
                    focusContent
                } else {
                    disconnectedView
                }
            }
            .navigationTitle("Focus")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        if !focusItems.isEmpty {
                            Button {
                                Task { await clearAllFocus() }
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundStyle(.red.opacity(0.8))
                            }
                        }
                        
                        Button {
                            Task { await loadFocusData() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .foregroundStyle(.yellow)
                        }
                    }
                }
                
                ToolbarItem(placement: .topBarLeading) {
                    focusCountBadge
                }
            }
            .sheet(isPresented: $showingSourceSheet) {
                sourceSheet
            }
        }
        .onAppear {
            updateConnectionStatus()
        }
        .onChange(of: appModel.gatewayServerName) { _, _ in
            updateConnectionStatus()
            if appModel.gatewayServerName != nil {
                Task { await loadFocusData() }
            }
        }
        .task {
            if isConnected {
                await loadFocusData()
            }
        }
    }
    
    // MARK: - Focus Content
    
    @ViewBuilder
    private var focusContent: some View {
        VStack(spacing: 0) {
            if isLoading {
                loadingView
            } else if let error = errorMessage {
                errorView(message: error)
            } else {
                focusList
            }
        }
    }
    
    @ViewBuilder
    private var focusList: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Focus items (max 5)
                ForEach(Array(focusItems.enumerated()), id: \.element.id) { index, item in
                    FocusItemCard(
                        item: item,
                        priority: index + 1,
                        onRemove: { Task { await removeFromFocus(itemId: item.id) } },
                        onMoveUp: index > 0 ? { Task { await moveItem(itemId: item.id, direction: .up) } } : nil,
                        onMoveDown: index < focusItems.count - 1 ? { Task { await moveItem(itemId: item.id, direction: .down) } } : nil
                    )
                }
                
                // Empty slots
                ForEach(focusItems.count..<5, id: \.self) { index in
                    EmptyFocusSlot(slotNumber: index + 1) {
                        showingSourceSheet = true
                    }
                }
            }
            .padding()
        }
        .refreshable {
            await loadFocusData()
        }
    }
    
    @ViewBuilder
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(.yellow)
                .scaleEffect(1.2)
            
            Text("Loading focus items...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxHeight: .infinity)
    }
    
    @ViewBuilder
    private func errorView(message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            
            Text("Failed to load focus")
                .font(.headline)
                .foregroundStyle(.white)
            
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            
            Button("Retry") {
                Task { await loadFocusData() }
            }
            .buttonStyle(.bordered)
            .tint(.yellow)
        }
        .frame(maxHeight: .infinity)
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
                
                Text("Connect to your Moltbot gateway to access your Focus board.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }
        }
        .padding()
    }
    
    @ViewBuilder
    private var focusCountBadge: some View {
        HStack(spacing: 6) {
            Image(systemName: "target")
                .foregroundStyle(.yellow)
            
            Text("\(focusItems.count)/5")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule()
                .fill(Color.yellow.opacity(0.15))
        )
    }
    
    // MARK: - Source Sheet
    
    @ViewBuilder
    private var sourceSheet: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                
                VStack(spacing: 0) {
                    // Filter picker
                    Picker("Filter", selection: $sourceFilter) {
                        ForEach(SourceFilter.allCases, id: \.self) { filter in
                            Text(filter.rawValue).tag(filter)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding()
                    
                    // Search bar
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                        
                        TextField("Search...", text: $searchText)
                            .textFieldStyle(.plain)
                            .foregroundStyle(.white)
                        
                        if !searchText.isEmpty {
                            Button {
                                searchText = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.white.opacity(0.08))
                    )
                    .padding(.horizontal)
                    
                    // Items list
                    sourceItemsList
                }
            }
            .navigationTitle("Add to Focus")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        showingSourceSheet = false
                    }
                    .foregroundStyle(.yellow)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    
    @ViewBuilder
    private var sourceItemsList: some View {
        let focusIds = Set(focusItems.map { $0.id })
        let canAddMore = focusItems.count < 5
        
        let filteredTasks = availableTasks.filter { task in
            !focusIds.contains(task.id) &&
            (sourceFilter == .all || sourceFilter == .tasks) &&
            (searchText.isEmpty || task.title.localizedCaseInsensitiveContains(searchText))
        }
        
        let filteredProjects = availableProjects.filter { project in
            !focusIds.contains(project.id) &&
            (sourceFilter == .all || sourceFilter == .projects) &&
            (searchText.isEmpty || project.name.localizedCaseInsensitiveContains(searchText))
        }
        
        ScrollView {
            LazyVStack(spacing: 12) {
                if !canAddMore {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text("Focus is full. Remove an item first.")
                            .font(.subheadline)
                            .foregroundStyle(.orange)
                    }
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.orange.opacity(0.1))
                    )
                    .padding(.horizontal)
                }
                
                // Tasks section
                if !filteredTasks.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Tasks")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                        
                        ForEach(filteredTasks) { task in
                            SourceItemRow(
                                icon: "checkmark.circle",
                                iconColor: statusColor(for: task.status),
                                title: task.title,
                                subtitle: task.status?.replacingOccurrences(of: "_", with: " ").capitalized,
                                isDisabled: !canAddMore
                            ) {
                                Task { await addTaskToFocus(taskId: task.id) }
                                showingSourceSheet = false
                            }
                        }
                    }
                }
                
                // Projects section
                if !filteredProjects.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Projects")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                        
                        ForEach(filteredProjects) { project in
                            SourceItemRow(
                                icon: "folder.fill",
                                iconColor: .purple,
                                title: project.name,
                                subtitle: project.status?.capitalized,
                                isDisabled: !canAddMore
                            ) {
                                Task { await addProjectToFocus(projectId: project.id) }
                                showingSourceSheet = false
                            }
                        }
                    }
                }
                
                if filteredTasks.isEmpty && filteredProjects.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        
                        Text("No items available")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 40)
                }
            }
            .padding(.top, 16)
        }
    }
    
    // MARK: - Helper Methods
    
    private func updateConnectionStatus() {
        isConnected = appModel.gatewayServerName != nil
    }
    
    private func statusColor(for status: String?) -> Color {
        switch status {
        case "done": return .green
        case "in_progress": return .orange
        case "review": return .purple
        case "todo": return .blue
        default: return .gray
        }
    }
    
    // MARK: - Gateway Methods
    
    private func loadFocusData() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            // Load focus items
            let focusResponse = try await appModel.gatewaySession.request(
                method: "focus.list",
                paramsJSON: "{}",
                timeoutSeconds: 15
            )
            let focusDecoded = try JSONDecoder().decode(FocusListResponse.self, from: focusResponse)
            
            // Load available tasks
            let tasksResponse = try await appModel.gatewaySession.request(
                method: "kanban.tasks.list",
                paramsJSON: "{}",
                timeoutSeconds: 15
            )
            let tasksDecoded = try JSONDecoder().decode(KanbanTasksResponse.self, from: tasksResponse)
            
            // Load available projects
            let projectsResponse = try await appModel.gatewaySession.request(
                method: "kanban.projects.list",
                paramsJSON: "{}",
                timeoutSeconds: 15
            )
            let projectsDecoded = try JSONDecoder().decode(KanbanProjectsResponse.self, from: projectsResponse)
            
            await MainActor.run {
                focusItems = focusDecoded.items
                availableTasks = tasksDecoded.tasks
                availableProjects = projectsDecoded.projects
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func addTaskToFocus(taskId: String) async {
        do {
            let params = "{\"taskId\":\"\(taskId)\"}"
            _ = try await appModel.gatewaySession.request(
                method: "focus.add_task",
                paramsJSON: params,
                timeoutSeconds: 10
            )
            await loadFocusData()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func addProjectToFocus(projectId: String) async {
        do {
            let params = "{\"projectId\":\"\(projectId)\"}"
            _ = try await appModel.gatewaySession.request(
                method: "focus.add_project",
                paramsJSON: params,
                timeoutSeconds: 10
            )
            await loadFocusData()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func removeFromFocus(itemId: String) async {
        do {
            let params = "{\"itemId\":\"\(itemId)\"}"
            _ = try await appModel.gatewaySession.request(
                method: "focus.remove",
                paramsJSON: params,
                timeoutSeconds: 10
            )
            await loadFocusData()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    enum MoveDirection {
        case up, down
    }
    
    private func moveItem(itemId: String, direction: MoveDirection) async {
        do {
            let method = direction == .up ? "focus.move_up" : "focus.move_down"
            let params = "{\"itemId\":\"\(itemId)\"}"
            _ = try await appModel.gatewaySession.request(
                method: method,
                paramsJSON: params,
                timeoutSeconds: 10
            )
            await loadFocusData()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func clearAllFocus() async {
        do {
            _ = try await appModel.gatewaySession.request(
                method: "focus.clear",
                paramsJSON: "{}",
                timeoutSeconds: 10
            )
            await loadFocusData()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Focus Item Card

struct FocusItemCard: View {
    let item: FocusItem
    let priority: Int
    let onRemove: () -> Void
    let onMoveUp: (() -> Void)?
    let onMoveDown: (() -> Void)?
    
    var body: some View {
        HStack(spacing: 0) {
            // Priority number
            ZStack {
                Rectangle()
                    .fill(Color.yellow)
                    .frame(width: 50)
                
                Text("\(priority)")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(.black)
            }
            
            // Content
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: item.type == "task" ? "checkmark.circle" : "folder.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(item.type == "task" ? .blue : .purple)
                    
                    Text(item.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                }
                
                if let projectName = item.projectName {
                    Text(projectName)
                        .font(.system(size: 11))
                        .foregroundStyle(.yellow.opacity(0.8))
                }
                
                if let status = item.status {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(statusColor(for: status))
                            .frame(width: 6, height: 6)
                        
                        Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            
            // Actions
            VStack(spacing: 4) {
                if let moveUp = onMoveUp {
                    Button(action: moveUp) {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 32, height: 28)
                }
                
                if let moveDown = onMoveDown {
                    Button(action: moveDown) {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 32, height: 28)
                }
                
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.red.opacity(0.8))
                }
                .frame(width: 32, height: 28)
            }
            .padding(.trailing, 8)
        }
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.yellow.opacity(0.15), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    
    private func statusColor(for status: String) -> Color {
        switch status {
        case "done": return .green
        case "in_progress": return .orange
        case "review": return .purple
        case "todo": return .blue
        default: return .gray
        }
    }
}

// MARK: - Empty Focus Slot

struct EmptyFocusSlot: View {
    let slotNumber: Int
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.yellow.opacity(0.1))
                        .frame(width: 50, height: 50)
                    
                    Text("\(slotNumber)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(.yellow.opacity(0.4))
                }
                
                VStack(alignment: .leading, spacing: 4) {
                    Text("Add to Focus")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary)
                    
                    Text("Tap to add a task or project")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary.opacity(0.7))
                }
                
                Spacer()
                
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.yellow.opacity(0.5))
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.1), style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Source Item Row

struct SourceItemRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String?
    let isDisabled: Bool
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(iconColor.opacity(0.15))
                        .frame(width: 40, height: 40)
                    
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(iconColor)
                }
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    
                    if let subtitle = subtitle {
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
                
                Spacer()
                
                if !isDisabled {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.yellow)
                }
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
            .opacity(isDisabled ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .padding(.horizontal)
    }
}

// MARK: - Data Models

struct FocusItem: Codable, Identifiable {
    let id: String
    let type: String  // "task" or "project"
    let title: String
    let description: String?
    let status: String?
    let priority: Int?
    let projectName: String?
    let projectId: String?
    let addedAt: Int?
}

struct FocusListResponse: Codable {
    let items: [FocusItem]
}

struct KanbanTask: Codable, Identifiable {
    let id: String
    let title: String
    let description: String?
    let status: String?
    let priority: String?
    let projectId: String?
    let assignee: String?
    let dueDate: String?
    
    enum CodingKeys: String, CodingKey {
        case id, title, description, status, priority
        case projectId = "project_id"
        case assignee
        case dueDate = "due_date"
    }
}

struct KanbanTasksResponse: Codable {
    let tasks: [KanbanTask]
}

struct KanbanProject: Codable, Identifiable {
    let id: String
    let name: String
    let description: String?
    let status: String?
    let progress: Int?
    let taskCount: Int?
    
    enum CodingKeys: String, CodingKey {
        case id, name, description, status, progress
        case taskCount = "task_count"
    }
}

struct KanbanProjectsResponse: Codable {
    let projects: [KanbanProject]
}

// MARK: - Preview

#Preview {
    FocusTab()
}
