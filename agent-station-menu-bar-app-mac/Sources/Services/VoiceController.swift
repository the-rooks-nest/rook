import AVFoundation
import Foundation
import Speech

/// Local voice loop: on-device speech-to-text (Apple Speech) for input and
/// AVSpeechSynthesizer for spoken replies. Plain service with callbacks — the
/// model holds the @Published mirror state, matching the other services.
@MainActor
final class VoiceController: NSObject {
    var onTranscript: ((String) -> Void)?                  // final utterance → agent
    var onListeningChanged: ((Bool) -> Void)?
    var onSpeakingChanged: ((Bool) -> Void)?
    var onPartial: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var latestTranscript = ""

    private(set) var isListening = false
    private(set) var isSpeaking = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    // MARK: - Permissions

    func authorized() -> Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized
            && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    func requestPermissions(_ completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            AVCaptureDevice.requestAccess(for: .audio) { micGranted in
                Task { @MainActor in
                    completion(speechStatus == .authorized && micGranted)
                }
            }
        }
    }

    // MARK: - Listening (speech → text)

    func toggleListening() {
        if isListening {
            stopListening(send: true)
        } else {
            startListening()
        }
    }

    func startListening() {
        guard !isListening else {
            return
        }
        guard authorized() else {
            onError?("Microphone or speech recognition not authorized")
            return
        }
        // Don't capture our own TTS.
        stopSpeaking()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request
        latestTranscript = ""

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            onError?("Audio engine failed: \(error.localizedDescription)")
            cleanupAudio()
            return
        }

        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else {
                    return
                }
                if let result {
                    self.latestTranscript = result.bestTranscription.formattedString
                    self.onPartial?(self.latestTranscript)
                    self.resetSilenceTimer()
                    if result.isFinal {
                        self.stopListening(send: true)
                    }
                }
                if error != nil {
                    self.stopListening(send: !self.latestTranscript.isEmpty)
                }
            }
        }

        isListening = true
        onListeningChanged?(true)
    }

    func stopListening(send: Bool) {
        guard isListening else {
            return
        }
        silenceTimer?.invalidate()
        silenceTimer = nil
        cleanupAudio()
        task?.finish()
        task = nil
        isListening = false
        onListeningChanged?(false)

        let transcript = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        latestTranscript = ""
        if send, !transcript.isEmpty {
            onTranscript?(transcript)
        }
    }

    private func cleanupAudio() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
    }

    /// Apple Speech doesn't reliably auto-endpoint on macOS; finalize after a
    /// short silence following the last partial result.
    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.stopListening(send: true)
            }
        }
    }

    // MARK: - Speaking (text → speech)

    /// Speak a complete response in one pass (called once the agent turn ends).
    func speak(_ text: String) {
        let cleaned = Self.cleanForSpeech(text)
        guard !cleaned.isEmpty else {
            return
        }
        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.voice = Self.preferredVoice()
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }

    func stopSpeaking() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    /// Pick the best installed English voice: premium (Siri-quality) →
    /// enhanced → default. Override with `defaults write … VoiceIdentifier <id>`.
    static func preferredVoice() -> AVSpeechSynthesisVoice? {
        if let id = UserDefaults.standard.string(forKey: "VoiceIdentifier"),
           let voice = AVSpeechSynthesisVoice(identifier: id) {
            return voice
        }
        let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        func best(_ quality: AVSpeechSynthesisVoiceQuality) -> AVSpeechSynthesisVoice? {
            english.filter { $0.quality == quality }
                .sorted { ($0.language == "en-US" ? 0 : 1) < ($1.language == "en-US" ? 0 : 1) }
                .first
        }
        return best(.premium) ?? best(.enhanced) ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    static func preferredVoiceName() -> String {
        preferredVoice()?.name ?? "System default"
    }

    /// Strip markdown/code so the synthesizer doesn't read syntax aloud.
    static func cleanForSpeech(_ text: String) -> String {
        var s = text
        // Drop fenced code blocks entirely.
        s = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: " (code) ", options: .regularExpression)
        // Inline code / emphasis / headings / list / quote markers.
        s = s.replacingOccurrences(of: "[`*_#>|]", with: "", options: .regularExpression)
        // Markdown links [text](url) → text.
        s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        // Collapse whitespace.
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension VoiceController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = true
            self.onSpeakingChanged?(true)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if !synthesizer.isSpeaking {
                self.isSpeaking = false
                self.onSpeakingChanged?(false)
            }
        }
    }
}
