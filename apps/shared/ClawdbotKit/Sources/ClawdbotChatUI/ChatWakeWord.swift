import AVFoundation
import Observation
import Speech
import SwiftUI

/// Wake word detection and voice input for mobile
/// Uses iOS Speech framework for continuous listening
@MainActor
@Observable
public final class ChatWakeWordManager {
    public static let shared = ChatWakeWordManager()
    
    // Configuration
    public var wakeWord: String = "hey ash"
    public var isEnabled: Bool = false
    public var autoSendAfterSilence: Bool = true
    public var silenceTimeoutMs: Int = 2500
    
    // State
    public private(set) var isListening: Bool = false
    public private(set) var isRecognizing: Bool = false
    public private(set) var wakeWordDetected: Bool = false
    public private(set) var interimText: String = ""
    public private(set) var finalText: String = ""
    public private(set) var errorMessage: String?
    public private(set) var authorizationStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
    
    // Callbacks
    public var onTranscript: ((String, Bool) -> Void)?
    public var onAutoSend: ((String) -> Void)?
    public var onWakeWordDetected: (() -> Void)?
    
    // Private
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var silenceTimer: Timer?
    private var lastSpeechTime: Date = Date()
    private var accumulatedText: String = ""
    
    // Storage keys
    private let wakeWordKey = "moltbot.wakeword.phrase"
    private let enabledKey = "moltbot.wakeword.enabled"
    private let autoSendKey = "moltbot.wakeword.autosend"
    private let silenceTimeoutKey = "moltbot.wakeword.silence"
    
    private init() {
        loadSettings()
        setupSpeechRecognizer()
    }
    
    // MARK: - Public API
    
    public func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                Task { @MainActor in
                    self.authorizationStatus = status
                    continuation.resume(returning: status == .authorized)
                }
            }
        }
    }
    
    public func start() async {
        guard !isListening else { return }
        
        // Check authorization
        guard authorizationStatus == .authorized else {
            let authorized = await requestAuthorization()
            guard authorized else {
                errorMessage = "Speech recognition not authorized"
                return
            }
        }
        
        // Request microphone permission
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            errorMessage = "Failed to configure audio session: \(error.localizedDescription)"
            return
        }
        
        startRecognition()
    }
    
    public func stop() {
        stopRecognition()
        isEnabled = false
        saveSettings()
    }
    
    public func toggle() async {
        if isListening {
            stop()
        } else {
            isEnabled = true
            saveSettings()
            await start()
        }
    }
    
    public func updateWakeWord(_ newWord: String) {
        wakeWord = newWord.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        saveSettings()
    }
    
    // MARK: - Private Implementation
    
    private func setupSpeechRecognizer() {
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        speechRecognizer?.defaultTaskHint = .dictation
    }
    
    private func startRecognition() {
        guard let speechRecognizer = speechRecognizer, speechRecognizer.isAvailable else {
            errorMessage = "Speech recognizer not available"
            return
        }
        
        // Cancel any existing task
        recognitionTask?.cancel()
        recognitionTask = nil
        
        // Create recognition request
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else {
            errorMessage = "Failed to create recognition request"
            return
        }
        
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.requiresOnDeviceRecognition = false
        
        // Add keep-alive for continuous recognition (iOS 16+)
        if #available(iOS 16.0, *) {
            recognitionRequest.addsPunctuation = false
        }
        
        // Start recognition task
        recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            Task { @MainActor in
                self?.handleRecognitionResult(result: result, error: error)
            }
        }
        
        // Configure audio input
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }
        
        // Start audio engine
        audioEngine.prepare()
        do {
            try audioEngine.start()
            isListening = true
            isRecognizing = true
            errorMessage = nil
            startSilenceTimer()
        } catch {
            errorMessage = "Failed to start audio engine: \(error.localizedDescription)"
        }
    }
    
    private func stopRecognition() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        
        recognitionTask?.cancel()
        recognitionTask = nil
        
        isListening = false
        isRecognizing = false
        wakeWordDetected = false
        interimText = ""
        accumulatedText = ""
    }
    
    private func handleRecognitionResult(result: SFSpeechRecognitionResult?, error: Error?) {
        if let error = error {
            let nsError = error as NSError
            // Ignore certain expected errors
            if nsError.domain == "kAFAssistantErrorDomain" {
                // Restart recognition on timeout
                if isEnabled && !isListening {
                    Task {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        await self.start()
                    }
                }
                return
            }
            errorMessage = error.localizedDescription
            return
        }
        
        guard let result = result else { return }
        
        let transcript = result.bestTranscription.formattedString
        let isFinal = result.isFinal
        
        lastSpeechTime = Date()
        
        // Check for wake word
        let lowerTranscript = transcript.lowercased()
        let lowerWakeWord = wakeWord.lowercased()
        
        if let range = lowerTranscript.range(of: lowerWakeWord) {
            if !wakeWordDetected {
                wakeWordDetected = true
                onWakeWordDetected?()
                
                // Play haptic feedback
                let generator = UIImpactFeedbackGenerator(style: .medium)
                generator.impactOccurred()
            }
            
            // Extract text after wake word
            let afterWake = String(transcript[range.upperBound...]).trimmingCharacters(in: .whitespaces)
            if !afterWake.isEmpty {
                accumulatedText = afterWake
                interimText = afterWake
                onTranscript?(afterWake, isFinal)
            }
        } else if wakeWordDetected {
            // Continue accumulating after wake word was detected
            accumulatedText = transcript
            interimText = transcript
            onTranscript?(transcript, isFinal)
        }
        
        if isFinal && wakeWordDetected {
            finalText = accumulatedText
        }
    }
    
    private func startSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkSilence()
            }
        }
    }
    
    private func checkSilence() {
        guard wakeWordDetected, autoSendAfterSilence else { return }
        
        let elapsed = Date().timeIntervalSince(lastSpeechTime) * 1000
        if elapsed >= Double(silenceTimeoutMs) {
            let textToSend = accumulatedText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !textToSend.isEmpty {
                onAutoSend?(textToSend)
                
                // Play send haptic
                let generator = UINotificationFeedbackGenerator()
                generator.notificationOccurred(.success)
            }
            
            // Reset state
            wakeWordDetected = false
            accumulatedText = ""
            interimText = ""
            finalText = ""
        }
    }
    
    // MARK: - Settings Persistence
    
    private func loadSettings() {
        let defaults = UserDefaults.standard
        if let saved = defaults.string(forKey: wakeWordKey) {
            wakeWord = saved
        }
        isEnabled = defaults.bool(forKey: enabledKey)
        autoSendAfterSilence = defaults.object(forKey: autoSendKey) as? Bool ?? true
        silenceTimeoutMs = defaults.object(forKey: silenceTimeoutKey) as? Int ?? 2500
    }
    
    private func saveSettings() {
        let defaults = UserDefaults.standard
        defaults.set(wakeWord, forKey: wakeWordKey)
        defaults.set(isEnabled, forKey: enabledKey)
        defaults.set(autoSendAfterSilence, forKey: autoSendKey)
        defaults.set(silenceTimeoutMs, forKey: silenceTimeoutKey)
    }
}

// MARK: - Wake Word Button View

@MainActor
public struct ChatWakeWordButton: View {
    @State private var manager = ChatWakeWordManager.shared
    @State private var showSettings = false
    
    let onTranscript: (String) -> Void
    let onSend: (String) -> Void
    
    public init(
        onTranscript: @escaping (String) -> Void,
        onSend: @escaping (String) -> Void
    ) {
        self.onTranscript = onTranscript
        self.onSend = onSend
    }
    
    public var body: some View {
        HStack(spacing: 8) {
            // Main wake word toggle button
            Button {
                Task {
                    await manager.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: manager.isListening ? "waveform" : "mic.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .symbolEffect(.variableColor, isActive: manager.isListening)
                    
                    if manager.isListening {
                        Text(manager.wakeWordDetected ? "LISTENING" : "WAKE: \"\(manager.wakeWord)\"")
                            .font(.system(size: 10, weight: .bold))
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(buttonBackground)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .strokeBorder(buttonBorderColor, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .animation(.spring(response: 0.3), value: manager.isListening)
            .animation(.spring(response: 0.3), value: manager.wakeWordDetected)
            
            // Settings button
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gear")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
            }
            .sheet(isPresented: $showSettings) {
                WakeWordSettingsSheet(manager: manager)
            }
        }
        .onAppear {
            setupCallbacks()
            
            // Auto-start if enabled
            if manager.isEnabled {
                Task {
                    await manager.start()
                }
            }
        }
    }
    
    private var buttonBackground: some ShapeStyle {
        if manager.wakeWordDetected {
            return AnyShapeStyle(Color.green.opacity(0.15))
        } else if manager.isListening {
            return AnyShapeStyle(Color.accentColor.opacity(0.15))
        } else {
            return AnyShapeStyle(Color(uiColor: .tertiarySystemBackground))
        }
    }
    
    private var buttonBorderColor: Color {
        if manager.wakeWordDetected {
            return .green
        } else if manager.isListening {
            return .accentColor
        } else {
            return .clear
        }
    }
    
    private func setupCallbacks() {
        manager.onTranscript = { text, isFinal in
            onTranscript(text)
        }
        manager.onAutoSend = { text in
            onSend(text)
        }
    }
}

// MARK: - Settings Sheet

@MainActor
private struct WakeWordSettingsSheet: View {
    @Bindable var manager: ChatWakeWordManager
    @Environment(\.dismiss) private var dismiss
    @State private var wakeWordInput: String = ""
    
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Enable Wake Word", isOn: Binding(
                        get: { manager.isEnabled },
                        set: { newValue in
                            if newValue {
                                manager.isEnabled = true
                                Task { await manager.start() }
                            } else {
                                manager.stop()
                            }
                        }
                    ))
                } header: {
                    Text("Voice Activation")
                } footer: {
                    Text("Say the wake word to start voice input. Voice will be sent after silence timeout.")
                }
                
                Section("Wake Word") {
                    TextField("Wake word phrase", text: $wakeWordInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onAppear {
                            wakeWordInput = manager.wakeWord
                        }
                        .onChange(of: wakeWordInput) { _, newValue in
                            manager.updateWakeWord(newValue)
                        }
                    
                    Text("Examples: \"hey ash\", \"ok clawd\", \"computer\"")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                
                Section("Auto-Send") {
                    Toggle("Send after silence", isOn: Binding(
                        get: { manager.autoSendAfterSilence },
                        set: { manager.autoSendAfterSilence = $0 }
                    ))
                    
                    Stepper(
                        "Silence timeout: \(manager.silenceTimeoutMs / 1000).\(manager.silenceTimeoutMs % 1000 / 100)s",
                        value: Binding(
                            get: { manager.silenceTimeoutMs },
                            set: { manager.silenceTimeoutMs = $0 }
                        ),
                        in: 1000...5000,
                        step: 500
                    )
                }
                
                Section {
                    HStack {
                        Text("Status")
                        Spacer()
                        Text(statusText)
                            .foregroundStyle(statusColor)
                    }
                    
                    if let error = manager.errorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Wake Word Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
    
    private var statusText: String {
        if manager.isListening {
            return manager.wakeWordDetected ? "Active (listening)" : "Listening for wake word"
        }
        switch manager.authorizationStatus {
        case .authorized: return "Ready"
        case .denied: return "Permission denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not configured"
        @unknown default: return "Unknown"
        }
    }
    
    private var statusColor: Color {
        if manager.isListening {
            return manager.wakeWordDetected ? .green : .orange
        }
        return manager.authorizationStatus == .authorized ? .green : .red
    }
}
