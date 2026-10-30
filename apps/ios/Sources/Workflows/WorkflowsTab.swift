import SwiftUI

/// Workflows tab - Markdown instruction documents with Notion sync
/// Connects to gateway workflows.* methods for CRUD operations
struct WorkflowsTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var workflows: [WorkflowListItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var searchText = ""
    @State private var selectedWorkflow: WorkflowFull?
    @State private var showingEditor = false
    @State private var showingCreateSheet = false
    @State private var isConnected = false
    
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
                    workflowsContent
                } else {
                    disconnectedView
                }
            }
            .navigationTitle("Workflows")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        Button {
                            showingCreateSheet = true
                        } label: {
                            Image(systemName: "plus")
                                .foregroundStyle(.yellow)
                        }
                        
                        Button {
                            Task { await loadWorkflows() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .foregroundStyle(.yellow)
                        }
                    }
                }
            }
            .sheet(item: $selectedWorkflow) { workflow in
                WorkflowDetailSheet(
                    workflow: workflow,
                    onSave: { updated in
                        Task { 
                            await updateWorkflow(updated)
                            selectedWorkflow = nil
                        }
                    },
                    onDelete: {
                        Task {
                            await deleteWorkflow(id: workflow.id)
                            selectedWorkflow = nil
                        }
                    },
                    onSyncNotion: {
                        Task { await syncToNotion(id: workflow.id) }
                    },
                    appModel: appModel
                )
            }
            .sheet(isPresented: $showingCreateSheet) {
                CreateWorkflowSheet(
                    onCreate: { name, description, tags, body in
                        Task {
                            await createWorkflow(name: name, description: description, tags: tags, body: body)
                            showingCreateSheet = false
                        }
                    }
                )
            }
        }
        .onAppear {
            updateConnectionStatus()
        }
        .onChange(of: appModel.gatewayServerName) { _, _ in
            updateConnectionStatus()
            if appModel.gatewayServerName != nil {
                Task { await loadWorkflows() }
            }
        }
        .task {
            if isConnected {
                await loadWorkflows()
            }
        }
    }
    
    // MARK: - Content Views
    
    @ViewBuilder
    private var workflowsContent: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                
                TextField("Search workflows...", text: $searchText)
                    .textFieldStyle(.plain)
                    .foregroundStyle(.white)
                    .onChange(of: searchText) { _, _ in
                        Task { await loadWorkflows() }
                    }
                
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        Task { await loadWorkflows() }
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
            .padding()
            
            if isLoading {
                loadingView
            } else if let error = errorMessage {
                errorView(message: error)
            } else if workflows.isEmpty {
                emptyState
            } else {
                workflowsList
            }
        }
    }
    
    @ViewBuilder
    private var workflowsList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(filteredWorkflows) { workflow in
                    WorkflowCard(workflow: workflow) {
                        Task { await selectWorkflow(id: workflow.id) }
                    }
                }
            }
            .padding()
        }
        .refreshable {
            await loadWorkflows()
        }
    }
    
    private var filteredWorkflows: [WorkflowListItem] {
        if searchText.isEmpty {
            return workflows
        }
        return workflows.filter { workflow in
            workflow.name.localizedCaseInsensitiveContains(searchText) ||
            (workflow.description?.localizedCaseInsensitiveContains(searchText) ?? false) ||
            (workflow.tags ?? []).contains { $0.localizedCaseInsensitiveContains(searchText) }
        }
    }
    
    @ViewBuilder
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(.yellow)
                .scaleEffect(1.2)
            
            Text("Loading workflows...")
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
            
            Text("Failed to load workflows")
                .font(.headline)
                .foregroundStyle(.white)
            
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            
            Button("Retry") {
                Task { await loadWorkflows() }
            }
            .buttonStyle(.bordered)
            .tint(.yellow)
        }
        .frame(maxHeight: .infinity)
    }
    
    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.text")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            
            Text(searchText.isEmpty ? "No workflows yet" : "No matching workflows")
                .font(.headline)
                .foregroundStyle(.secondary)
            
            Text("Workflows are reusable instruction documents\nthat define step-by-step processes.")
                .font(.caption)
                .foregroundStyle(.secondary.opacity(0.7))
                .multilineTextAlignment(.center)
            
            if searchText.isEmpty {
                Button {
                    showingCreateSheet = true
                } label: {
                    Label("Create Workflow", systemImage: "plus")
                }
                .buttonStyle(.bordered)
                .tint(.yellow)
            }
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
                
                Text("Connect to your Moltbot gateway to access workflows.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }
        }
        .padding()
    }
    
    // MARK: - Helper Methods
    
    private func updateConnectionStatus() {
        isConnected = appModel.gatewayServerName != nil
    }
    
    // MARK: - Gateway Methods
    
    private func loadWorkflows() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        
        do {
            let params = searchText.isEmpty ? "{}" : "{\"query\":\"\(searchText.replacingOccurrences(of: "\"", with: "\\\""))\"}"
            let response = try await appModel.gatewaySession.request(
                method: "workflows.list",
                paramsJSON: params,
                timeoutSeconds: 15
            )
            
            let decoded = try JSONDecoder().decode(WorkflowsListResponse.self, from: response)
            await MainActor.run {
                workflows = decoded.workflows
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func selectWorkflow(id: String) async {
        do {
            let params = "{\"id\":\"\(id)\"}"
            let response = try await appModel.gatewaySession.request(
                method: "workflows.get",
                paramsJSON: params,
                timeoutSeconds: 15
            )
            
            let decoded = try JSONDecoder().decode(WorkflowFull.self, from: response)
            await MainActor.run {
                selectedWorkflow = decoded
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func createWorkflow(name: String, description: String, tags: [String], body: String) async {
        do {
            let tagsJSON = tags.isEmpty ? "null" : "[\(tags.map { "\"\($0)\"" }.joined(separator: ","))]"
            let params = """
            {"name":"\(name.replacingOccurrences(of: "\"", with: "\\\""))","description":"\(description.replacingOccurrences(of: "\"", with: "\\\""))","body":"\(body.replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n"))","tags":\(tagsJSON)}
            """
            _ = try await appModel.gatewaySession.request(
                method: "workflows.create",
                paramsJSON: params,
                timeoutSeconds: 15
            )
            await loadWorkflows()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func updateWorkflow(_ workflow: WorkflowFull) async {
        do {
            let tagsJSON = (workflow.tags ?? []).isEmpty ? "null" : "[\((workflow.tags ?? []).map { "\"\($0)\"" }.joined(separator: ","))]"
            let params = """
            {"id":"\(workflow.id)","name":"\(workflow.name.replacingOccurrences(of: "\"", with: "\\\""))","description":"\((workflow.description ?? "").replacingOccurrences(of: "\"", with: "\\\""))","body":"\(workflow.body.replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n"))","tags":\(tagsJSON)}
            """
            _ = try await appModel.gatewaySession.request(
                method: "workflows.update",
                paramsJSON: params,
                timeoutSeconds: 15
            )
            await loadWorkflows()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func deleteWorkflow(id: String) async {
        do {
            let params = "{\"id\":\"\(id)\"}"
            _ = try await appModel.gatewaySession.request(
                method: "workflows.delete",
                paramsJSON: params,
                timeoutSeconds: 10
            )
            await loadWorkflows()
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func syncToNotion(id: String) async {
        guard let workflow = workflows.first(where: { $0.id == id }) else { return }
        
        do {
            // First get full workflow body
            let getParams = "{\"id\":\"\(id)\"}"
            let response = try await appModel.gatewaySession.request(
                method: "workflows.get",
                paramsJSON: getParams,
                timeoutSeconds: 15
            )
            let full = try JSONDecoder().decode(WorkflowFull.self, from: response)
            
            // Sync to Notion
            let tagsJSON = (workflow.tags ?? []).isEmpty ? "[]" : "[\((workflow.tags ?? []).map { "\"\($0)\"" }.joined(separator: ","))]"
            let syncParams = """
            {"workflowId":"\(id)","name":"\(workflow.name.replacingOccurrences(of: "\"", with: "\\\""))","description":"\((workflow.description ?? "").replacingOccurrences(of: "\"", with: "\\\""))","tags":\(tagsJSON),"body":"\(full.body.replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n"))"}
            """
            _ = try await appModel.gatewaySession.request(
                method: "notion.sync.workflow",
                paramsJSON: syncParams,
                timeoutSeconds: 20
            )
        } catch {
            await MainActor.run {
                errorMessage = "Notion sync failed: \(error.localizedDescription)"
            }
        }
    }
}

// MARK: - Workflow Card

struct WorkflowCard: View {
    let workflow: WorkflowListItem
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                // Header
                HStack {
                    Image(systemName: "doc.text.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.yellow)
                    
                    Text(workflow.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    
                    Spacer()
                    
                    if workflow.notionPageId != nil {
                        Image(systemName: "link")
                            .font(.system(size: 10))
                            .foregroundStyle(.yellow.opacity(0.7))
                    }
                    
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                
                // Description
                if let description = workflow.description, !description.isEmpty {
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                
                // Preview
                if !workflow.preview.isEmpty {
                    Text(workflow.preview)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary.opacity(0.7))
                        .lineLimit(2)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color.white.opacity(0.03))
                        )
                }
                
                // Tags & Meta
                HStack(spacing: 8) {
                    if let tags = workflow.tags, !tags.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(tags.prefix(3), id: \.self) { tag in
                                Text(tag)
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(
                                        Capsule()
                                            .fill(Color.white.opacity(0.08))
                                    )
                            }
                            if tags.count > 3 {
                                Text("+\(tags.count - 3)")
                                    .font(.system(size: 9))
                                    .foregroundStyle(.secondary.opacity(0.7))
                            }
                        }
                    }
                    
                    Spacer()
                    
                    Text(formatBodySize(workflow.bodyLength))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary.opacity(0.7))
                    
                    if let updatedAt = workflow.updatedAt {
                        Text(formatDate(updatedAt))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary.opacity(0.7))
                    }
                }
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.yellow.opacity(0.1), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    private func formatBodySize(_ length: Int) -> String {
        if length >= 1000 {
            return String(format: "%.1fk chars", Double(length) / 1000)
        }
        return "\(length) chars"
    }
    
    private func formatDate(_ dateStr: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if let date = formatter.date(from: dateStr) {
            let displayFormatter = DateFormatter()
            displayFormatter.dateStyle = .short
            return displayFormatter.string(from: date)
        }
        return dateStr
    }
}

// MARK: - Workflow Detail Sheet

struct WorkflowDetailSheet: View {
    let workflow: WorkflowFull
    let onSave: (WorkflowFull) -> Void
    let onDelete: () -> Void
    let onSyncNotion: () -> Void
    let appModel: NodeAppModel
    
    @Environment(\.dismiss) private var dismiss
    @State private var editedName: String
    @State private var editedDescription: String
    @State private var editedTags: String
    @State private var editedBody: String
    @State private var isEditing = false
    @State private var showingDeleteConfirm = false
    @State private var isSyncing = false
    
    init(workflow: WorkflowFull, onSave: @escaping (WorkflowFull) -> Void, onDelete: @escaping () -> Void, onSyncNotion: @escaping () -> Void, appModel: NodeAppModel) {
        self.workflow = workflow
        self.onSave = onSave
        self.onDelete = onDelete
        self.onSyncNotion = onSyncNotion
        self.appModel = appModel
        _editedName = State(initialValue: workflow.name)
        _editedDescription = State(initialValue: workflow.description ?? "")
        _editedTags = State(initialValue: (workflow.tags ?? []).joined(separator: ", "))
        _editedBody = State(initialValue: workflow.body)
    }
    
    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Metadata section
                        VStack(alignment: .leading, spacing: 12) {
                            if isEditing {
                                editableMetadata
                            } else {
                                readOnlyMetadata
                            }
                        }
                        .padding()
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.white.opacity(0.05))
                        )
                        
                        // Body section
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("Content")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                
                                Spacer()
                                
                                Text("\(editedBody.count) chars")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary.opacity(0.7))
                            }
                            
                            if isEditing {
                                TextEditor(text: $editedBody)
                                    .font(.system(size: 13, design: .monospaced))
                                    .foregroundStyle(.white)
                                    .scrollContentBackground(.hidden)
                                    .frame(minHeight: 300)
                                    .padding(12)
                                    .background(
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .fill(Color.white.opacity(0.03))
                                    )
                            } else {
                                Text(workflow.body)
                                    .font(.system(size: 13, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.9))
                                    .textSelection(.enabled)
                                    .padding(12)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .fill(Color.white.opacity(0.03))
                                    )
                            }
                        }
                        .padding()
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.white.opacity(0.05))
                        )
                        
                        // Actions
                        if !isEditing {
                            HStack(spacing: 12) {
                                Button {
                                    isSyncing = true
                                    onSyncNotion()
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                        isSyncing = false
                                    }
                                } label: {
                                    Label(isSyncing ? "Syncing..." : "Sync to Notion", systemImage: "link")
                                        .font(.system(size: 13, weight: .medium))
                                }
                                .buttonStyle(.bordered)
                                .tint(.yellow)
                                .disabled(isSyncing)
                                
                                Spacer()
                                
                                Button(role: .destructive) {
                                    showingDeleteConfirm = true
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                        .font(.system(size: 13, weight: .medium))
                                }
                                .buttonStyle(.bordered)
                            }
                            .padding(.horizontal)
                        }
                    }
                    .padding()
                }
            }
            .navigationTitle(isEditing ? "Edit Workflow" : workflow.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if isEditing {
                        Button("Cancel") {
                            // Reset to original values
                            editedName = workflow.name
                            editedDescription = workflow.description ?? ""
                            editedTags = (workflow.tags ?? []).joined(separator: ", ")
                            editedBody = workflow.body
                            isEditing = false
                        }
                    } else {
                        Button("Done") {
                            dismiss()
                        }
                    }
                }
                
                ToolbarItem(placement: .topBarTrailing) {
                    if isEditing {
                        Button("Save") {
                            let tags = editedTags
                                .split(separator: ",")
                                .map { $0.trimmingCharacters(in: .whitespaces) }
                                .filter { !$0.isEmpty }
                            
                            var updated = workflow
                            updated.name = editedName
                            updated.description = editedDescription
                            updated.tags = tags
                            updated.body = editedBody
                            
                            onSave(updated)
                            isEditing = false
                        }
                        .fontWeight(.semibold)
                        .foregroundStyle(.yellow)
                    } else {
                        Button("Edit") {
                            isEditing = true
                        }
                        .foregroundStyle(.yellow)
                    }
                }
            }
            .confirmationDialog("Delete Workflow", isPresented: $showingDeleteConfirm, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    onDelete()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to delete \"\(workflow.name)\"? This cannot be undone.")
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
    
    @ViewBuilder
    private var editableMetadata: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Name")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                
                TextField("Workflow name", text: $editedName)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.08))
                    )
            }
            
            VStack(alignment: .leading, spacing: 4) {
                Text("Description")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                
                TextField("Short description", text: $editedDescription)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.08))
                    )
            }
            
            VStack(alignment: .leading, spacing: 4) {
                Text("Tags")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                
                TextField("tag1, tag2, tag3", text: $editedTags)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, design: .monospaced))
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.08))
                    )
            }
        }
    }
    
    @ViewBuilder
    private var readOnlyMetadata: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let description = workflow.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            
            if let tags = workflow.tags, !tags.isEmpty {
                HStack(spacing: 6) {
                    ForEach(tags, id: \.self) { tag in
                        Text(tag)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.yellow.opacity(0.9))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .fill(Color.yellow.opacity(0.15))
                            )
                    }
                }
            }
            
            HStack(spacing: 16) {
                if let notionPageId = workflow.notionPageId {
                    HStack(spacing: 4) {
                        Image(systemName: "link")
                            .font(.system(size: 10))
                        Text("Synced to Notion")
                            .font(.system(size: 11))
                    }
                    .foregroundStyle(.yellow.opacity(0.8))
                }
                
                if let updatedAt = workflow.updatedAt {
                    Text("Updated \(formatDate(updatedAt))")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary.opacity(0.7))
                }
            }
        }
    }
    
    private func formatDate(_ dateStr: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if let date = formatter.date(from: dateStr) {
            let displayFormatter = DateFormatter()
            displayFormatter.dateStyle = .medium
            displayFormatter.timeStyle = .short
            return displayFormatter.string(from: date)
        }
        return dateStr
    }
}

// MARK: - Create Workflow Sheet

struct CreateWorkflowSheet: View {
    let onCreate: (String, String, [String], String) -> Void
    
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var tags = ""
    @State private var body = "# New Workflow\n\n## Steps\n\n1. \n2. \n3. \n"
    
    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Metadata
                        VStack(alignment: .leading, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Name *")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                
                                TextField("Workflow name", text: $name)
                                    .textFieldStyle(.plain)
                                    .font(.system(size: 14))
                                    .padding(10)
                                    .background(
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .fill(Color.white.opacity(0.08))
                                    )
                            }
                            
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Description")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                
                                TextField("Short description", text: $description)
                                    .textFieldStyle(.plain)
                                    .font(.system(size: 14))
                                    .padding(10)
                                    .background(
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .fill(Color.white.opacity(0.08))
                                    )
                            }
                            
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Tags")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                
                                TextField("tag1, tag2, tag3", text: $tags)
                                    .textFieldStyle(.plain)
                                    .font(.system(size: 14, design: .monospaced))
                                    .padding(10)
                                    .background(
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .fill(Color.white.opacity(0.08))
                                    )
                            }
                        }
                        .padding()
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.white.opacity(0.05))
                        )
                        
                        // Body
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Content")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                            
                            TextEditor(text: $body)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(.white)
                                .scrollContentBackground(.hidden)
                                .frame(minHeight: 250)
                                .padding(12)
                                .background(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(Color.white.opacity(0.03))
                                )
                        }
                        .padding()
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.white.opacity(0.05))
                        )
                    }
                    .padding()
                }
            }
            .navigationTitle("New Workflow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Create") {
                        let tagsList = tags
                            .split(separator: ",")
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        
                        onCreate(name, description, tagsList, body)
                    }
                    .fontWeight(.semibold)
                    .foregroundStyle(.yellow)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Data Models

struct WorkflowListItem: Codable, Identifiable {
    let id: String
    let name: String
    let description: String?
    let tags: [String]?
    let preview: String
    let bodyLength: Int
    let updatedAt: String?
    let createdAt: String?
    let notionPageId: String?
    let notionSyncedAt: String?
}

struct WorkflowFull: Codable, Identifiable {
    let id: String
    var name: String
    var description: String?
    var tags: [String]?
    var body: String
    let preview: String?
    let bodyLength: Int?
    let updatedAt: String?
    let createdAt: String?
    let notionPageId: String?
    let notionSyncedAt: String?
}

struct WorkflowsListResponse: Codable {
    let workflows: [WorkflowListItem]
}

// MARK: - Preview

#Preview {
    WorkflowsTab()
}
