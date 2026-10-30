import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  Image,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import VideoPlayerView from '../components/VideoPlayerView';
import { Picker } from '@react-native-picker/picker';
import Slider from '@react-native-community/slider';
import { COLORS } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { VideoStreamView } from '../components/VideoStreamView';
import { useVideoStream } from '../hooks/useVideoStream';

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';

const POPULAR_VIDEO_MODELS = [
  { owner: 'bytedance', model: 'omni-human', name: 'Omni-Human' },
  { owner: 'stability-ai', model: 'stable-video-diffusion', name: 'Stable Video Diffusion' },
  { owner: 'lucataco', model: 'animate-diff', name: 'AnimateDiff' },
  { owner: 'cjwbw', model: 'sadtalker', name: 'SadTalker' },
  { owner: 'anotherjesse', model: 'zeroscope-v2-xl', name: 'Zeroscope V2' },
  { owner: 'black-forest-labs', model: 'flux-schnell', name: 'FLUX Schnell' },
];

const PIPELINE_STEPS = [
  { key: 'generating_script', label: 'Script', icon: 'document-text' },
  { key: 'generating_video', label: 'Video', icon: 'videocam' },
  { key: 'sending', label: 'Send', icon: 'send' },
];

// Gateway session the script prompts run in (chat.send / chat.history).
const SCRIPT_SESSION_KEY = 'video-script-generator';
// sendReq times out client-side at 30s, so agent.wait is polled in shorter slices.
const SCRIPT_WAIT_SLICE_MS = 25000;
const SCRIPT_WAIT_MAX_SLICES = 5;

const newIdempotencyKey = (prefix) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// chat.history messages carry content as a string or as [{ type:'text', text }] blocks.
function messageText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return typeof msg?.text === 'string' ? msg.text : '';
}

export function VideoScreen({ gateway }) {
  // State
  const [replicateApiKey, setReplicateApiKey] = useState('');
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  
  const [characters, setCharacters] = useState([]);
  const [selectedCharacter, setSelectedCharacter] = useState(null);
  const [showCharacterModal, setShowCharacterModal] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState(null);
  
  const [topic, setTopic] = useState('');
  const [generatedScript, setGeneratedScript] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [duration, setDuration] = useState(30);
  
  const [pipelineStatus, setPipelineStatus] = useState('idle');
  const [currentStep, setCurrentStep] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  
  const [outputUrl, setOutputUrl] = useState(null);
  const [autoSendTelegram, setAutoSendTelegram] = useState(true);
  const [telegramChatId, setTelegramChatId] = useState('');
  const [sendingTelegram, setSendingTelegram] = useState(false);
  
  const [activeTab, setActiveTab] = useState('stream'); // stream, config, content, generate
  
  // Video streaming hook
  const videoStream = useVideoStream(gateway);

  // Load saved state
  useEffect(() => {
    loadSavedState();
  }, []);

  const loadSavedState = async () => {
    try {
      const [apiKey, savedCharacters, chatId] = await Promise.all([
        AsyncStorage.getItem('replicate_api_key'),
        AsyncStorage.getItem('video_characters'),
        AsyncStorage.getItem('telegram_chat_id'),
      ]);
      
      if (apiKey) setReplicateApiKey(apiKey);
      if (savedCharacters) setCharacters(JSON.parse(savedCharacters));
      if (chatId) setTelegramChatId(chatId);
    } catch (e) {
      console.warn('Failed to load saved state:', e);
    }
  };

  // Fetch models
  const fetchModels = async () => {
    if (!replicateApiKey) {
      Alert.alert('Error', 'Please enter your Replicate API key');
      return;
    }
    
    setLoadingModels(true);
    const loadedModels = [];
    
    for (const { owner, model, name } of POPULAR_VIDEO_MODELS) {
      try {
        const response = await fetch(`${REPLICATE_API_BASE}/models/${owner}/${model}`, {
          headers: {
            'Authorization': `Token ${replicateApiKey}`,
            'Content-Type': 'application/json',
          },
        });
        
        if (response.ok) {
          const data = await response.json();
          loadedModels.push({
            id: `${owner}/${model}`,
            name: data.name || name,
            description: data.description || '',
            version: data.latest_version?.id || '',
            coverImage: data.cover_image_url,
          });
        }
      } catch (e) {
        console.warn(`Failed to fetch ${owner}/${model}:`, e);
      }
    }
    
    setModels(loadedModels);
    setLoadingModels(false);
    
    // Save API key
    await AsyncStorage.setItem('replicate_api_key', replicateApiKey);
    
    if (loadedModels.length === 0) {
      Alert.alert('Warning', 'No models found. Check your API key.');
    }
  };

  // Ask the gateway agent for a script. There is no one-shot completion RPC:
  // chat.send acks with { runId }, agent.wait blocks until the run ends, then
  // the reply is read back from chat.history. Returns the script text (throws
  // on failure) so callers never fall back to made-up content.
  const requestScript = async () => {
    if (!gateway?.sendReq) throw new Error('Not connected to the gateway');
    const characterContext = selectedCharacter
      ? `The presenter is ${selectedCharacter.name}: ${selectedCharacter.description}.`
      : '';

    const prompt = `Generate a short, engaging video script (30-60 seconds when spoken) about: ${topic}

${characterContext}

Requirements:
- Conversational, engaging tone
- Clear introduction, main points, and conclusion
- Suitable for social media (TikTok/Reels style)
- No stage directions, just the spoken words

Script:`;

    const ack = await gateway.sendReq('chat.send', {
      sessionKey: SCRIPT_SESSION_KEY,
      message: prompt,
      deliver: false,
      idempotencyKey: newIdempotencyKey('video-script'),
    });
    const runId = ack?.runId;
    if (!runId) throw new Error('Gateway did not start a run');

    let status = 'timeout';
    for (let i = 0; i < SCRIPT_WAIT_MAX_SLICES && status === 'timeout'; i++) {
      const waited = await gateway.sendReq('agent.wait', { runId, timeoutMs: SCRIPT_WAIT_SLICE_MS });
      status = waited?.status || 'timeout';
      if (status === 'error') throw new Error(waited?.error || 'Agent run failed');
      setProgress(Math.min(90, (i + 1) * 20));
    }
    if (status === 'timeout') throw new Error('Timed out waiting for the agent');

    const history = await gateway.sendReq('chat.history', { sessionKey: SCRIPT_SESSION_KEY, limit: 6 });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const reply = [...messages].reverse().find((m) => m?.role === 'assistant' && messageText(m).trim());
    const text = reply ? messageText(reply).trim() : '';
    if (!text) throw new Error('The agent returned no script');
    return text;
  };

  // Generate script (Content tab button)
  const generateScript = async () => {
    if (!topic) return;

    setCurrentStep('generating_script');
    setPipelineStatus('running');
    setProgress(0);
    setError(null);

    try {
      const text = await requestScript();
      setGeneratedScript(text);
      setProgress(100);
      setPipelineStatus('idle');
      setCurrentStep(null);
    } catch (e) {
      setError(`Script generation failed: ${e.message}`);
      setPipelineStatus('error');
      setCurrentStep(null);
    }
  };

  // Deliver a finished video to Telegram through the gateway `send` RPC.
  const sendToTelegram = async (videoUrl) => {
    const to = telegramChatId.trim();
    if (!to) throw new Error('Set a Telegram chat ID in Config first');
    await gateway.sendReq('send', {
      to,
      channel: 'telegram',
      message: topic ? `Generated video: ${topic}` : 'Generated video',
      mediaUrl: videoUrl,
      idempotencyKey: newIdempotencyKey('video-send'),
    });
  };

  // Generate video
  const generateVideo = async () => {
    if (!selectedModel || (!topic && !generatedScript)) {
      Alert.alert('Error', 'Please select a model and enter a topic');
      return;
    }
    
    const model = models.find(m => m.id === selectedModel);
    if (!model) return;
    
    setPipelineStatus('running');
    setError(null);
    setOutputUrl(null);
    
    try {
      // Step 1: Script (only when a topic is given and none was written yet)
      let script = generatedScript;
      if (!script && topic) {
        setCurrentStep('generating_script');
        setProgress(0);
        script = await requestScript();
        setGeneratedScript(script);
        setProgress(100);
      }

      // No voice-over step: the selected Replicate models take a prompt only.

      // Step 2: Generate video
      setCurrentStep('generating_video');
      setProgress(0);
      
      const dims = getVideoDimensions(aspectRatio);
      const input = {
        prompt: topic || script.substring(0, 200),
        width: dims.width,
        height: dims.height,
        num_frames: Math.min(duration * 24, 120),
      };
      
      // Create Replicate prediction
      const createResponse = await fetch(`${REPLICATE_API_BASE}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${replicateApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: model.version,
          input,
        }),
      });
      
      if (!createResponse.ok) {
        const err = await createResponse.json();
        throw new Error(err.detail || 'Failed to create prediction');
      }
      
      const prediction = await createResponse.json();
      
      // Poll for completion
      let result = prediction;
      while (result.status !== 'succeeded' && result.status !== 'failed') {
        await sleep(3000);
        
        const pollResponse = await fetch(`${REPLICATE_API_BASE}/predictions/${prediction.id}`, {
          headers: { 'Authorization': `Token ${replicateApiKey}` },
        });
        result = await pollResponse.json();
        
        // Estimate progress
        if (result.logs) {
          const match = result.logs.match(/(\d+)%/);
          if (match) setProgress(parseInt(match[1], 10));
        }
      }
      
      if (result.status === 'failed') {
        throw new Error(result.error || 'Video generation failed');
      }
      
      // Get output URL
      const videoUrl = typeof result.output === 'string' 
        ? result.output 
        : Array.isArray(result.output) 
          ? result.output[0] 
          : result.output?.video;
      
      setOutputUrl(videoUrl);
      setProgress(100);
      
      // Step 3: Send to Telegram
      let sendError = null;
      if (autoSendTelegram && telegramChatId.trim() && videoUrl) {
        setCurrentStep('sending');
        setProgress(0);
        try {
          await sendToTelegram(videoUrl);
          setProgress(100);
        } catch (e) {
          sendError = e;
        }
      }
      
      setPipelineStatus('completed');
      setCurrentStep(null);
      if (sendError) setError(`Video is ready, but the Telegram send failed: ${sendError.message}`);
      
    } catch (e) {
      setError(e.message);
      setPipelineStatus('error');
      setCurrentStep(null);
    }
  };

  // Character management
  const saveCharacter = async (character) => {
    const newCharacters = editingCharacter
      ? characters.map(c => c.id === character.id ? character : c)
      : [...characters, { ...character, id: `char-${Date.now()}` }];
    
    setCharacters(newCharacters);
    await AsyncStorage.setItem('video_characters', JSON.stringify(newCharacters));
    setShowCharacterModal(false);
    setEditingCharacter(null);
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        
        {/* Tab Selector */}
        <View style={styles.tabBar}>
          {['stream', 'config', 'content', 'generate'].map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Ionicons 
                name={tab === 'stream' ? 'radio' : tab === 'config' ? 'settings' : tab === 'content' ? 'create' : 'videocam'} 
                size={18} 
                color={activeTab === tab ? COLORS.primary : COLORS.textMuted} 
              />
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'stream' ? 'Live' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Live Stream Tab */}
        {activeTab === 'stream' && (
          <GlassCard style={styles.streamPanel}>
            <View style={styles.streamHeader}>
              <View style={styles.streamHeaderLeft}>
                <Ionicons name="radio" size={20} color={COLORS.primary} />
                <Text style={styles.panelTitle}>Live Stream to Master</Text>
              </View>
              <View style={[
                styles.connectionBadge, 
                gateway?.status === 'connected' && styles.connectionBadgeActive
              ]}>
                <View style={[
                  styles.connectionDot,
                  gateway?.status === 'connected' && styles.connectionDotActive
                ]} />
                <Text style={[
                  styles.connectionText,
                  gateway?.status === 'connected' && styles.connectionTextActive
                ]}>
                  {gateway?.status === 'connected' ? 'Connected' : 'Offline'}
                </Text>
              </View>
            </View>
            
            <Text style={styles.streamDesc}>
              Push your camera frames to the gateway's vision feed so the agent
              can look through this device's camera (vision.pushFrame).
            </Text>
            
            <View style={styles.streamViewContainer}>
              <VideoStreamView
                gateway={gateway}
                streamHook={videoStream}
                showPreview={true}
                compact={false}
              />
            </View>
          </GlassCard>
        )}

        {/* Config Tab */}
        {activeTab === 'config' && (
          <GlassCard style={styles.panel}>
            <Text style={styles.panelTitle}>
              <Ionicons name="settings" size={18} color={COLORS.primary} /> Configuration
            </Text>
            
            {/* API Key */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Replicate API Key</Text>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={replicateApiKey}
                  onChangeText={setReplicateApiKey}
                  placeholder="r8_..."
                  placeholderTextColor={COLORS.textMuted}
                  secureTextEntry
                />
                <TouchableOpacity 
                  style={styles.btnSmall}
                  onPress={fetchModels}
                  disabled={loadingModels}
                >
                  {loadingModels ? (
                    <ActivityIndicator size="small" color={COLORS.primary} />
                  ) : (
                    <Text style={styles.btnSmallText}>Fetch</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
            
            {/* Model Selector */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Video Model</Text>
              <View style={styles.pickerContainer}>
                <Picker
                  selectedValue={selectedModel}
                  onValueChange={setSelectedModel}
                  style={styles.picker}
                  dropdownIconColor={COLORS.primary}
                >
                  <Picker.Item label="Select a model..." value="" color={COLORS.textMuted} />
                  {models.map(model => (
                    <Picker.Item 
                      key={model.id} 
                      label={model.name} 
                      value={model.id}
                      color={COLORS.text}
                    />
                  ))}
                </Picker>
              </View>
              {selectedModel && (
                <Text style={styles.modelDesc}>
                  {models.find(m => m.id === selectedModel)?.description?.substring(0, 100)}...
                </Text>
              )}
            </View>
            
            {/* Aspect Ratio */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Aspect Ratio</Text>
              <View style={styles.radioGroup}>
                {['16:9', '9:16', '1:1'].map(ratio => (
                  <TouchableOpacity
                    key={ratio}
                    style={[styles.radioBtn, aspectRatio === ratio && styles.radioBtnActive]}
                    onPress={() => setAspectRatio(ratio)}
                  >
                    <Text style={[styles.radioText, aspectRatio === ratio && styles.radioTextActive]}>
                      {ratio === '16:9' ? 'Landscape' : ratio === '9:16' ? 'Portrait' : 'Square'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            
            {/* Duration */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Duration: {duration}s</Text>
              <Slider
                style={styles.slider}
                minimumValue={5}
                maximumValue={120}
                step={5}
                value={duration}
                onValueChange={setDuration}
                minimumTrackTintColor={COLORS.primary}
                maximumTrackTintColor={COLORS.border}
                thumbTintColor={COLORS.primary}
              />
            </View>
            
            {/* Auto-send toggle */}
            <TouchableOpacity 
              style={styles.checkboxRow}
              onPress={() => setAutoSendTelegram(!autoSendTelegram)}
            >
              <Ionicons 
                name={autoSendTelegram ? 'checkbox' : 'square-outline'} 
                size={22} 
                color={COLORS.primary} 
              />
              <Text style={styles.checkboxLabel}>Auto-send to Telegram</Text>
            </TouchableOpacity>

            {/* Telegram destination (required by the gateway `send` RPC) */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Telegram Chat ID</Text>
              <TextInput
                style={styles.input}
                value={telegramChatId}
                onChangeText={(v) => {
                  setTelegramChatId(v);
                  AsyncStorage.setItem('telegram_chat_id', v.trim()).catch(() => {});
                }}
                placeholder="Chat ID or @username"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {autoSendTelegram && !telegramChatId.trim() ? (
                <Text style={styles.modelDesc}>
                  No chat ID set — finished videos will not be sent.
                </Text>
              ) : null}
            </View>
          </GlassCard>
        )}

        {/* Content Tab */}
        {activeTab === 'content' && (
          <GlassCard style={styles.panel}>
            <Text style={styles.panelTitle}>
              <Ionicons name="create" size={18} color={COLORS.primary} /> Content
            </Text>
            
            {/* Character Selector */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Character</Text>
              <View style={styles.row}>
                <View style={[styles.pickerContainer, { flex: 1 }]}>
                  <Picker
                    selectedValue={selectedCharacter?.id || ''}
                    onValueChange={(id) => setSelectedCharacter(characters.find(c => c.id === id) || null)}
                    style={styles.picker}
                    dropdownIconColor={COLORS.primary}
                  >
                    <Picker.Item label="No character (text-to-video)" value="" color={COLORS.textMuted} />
                    {characters.map(char => (
                      <Picker.Item key={char.id} label={char.name} value={char.id} color={COLORS.text} />
                    ))}
                  </Picker>
                </View>
                <TouchableOpacity 
                  style={styles.btnSmall}
                  onPress={() => {
                    setEditingCharacter(null);
                    setShowCharacterModal(true);
                  }}
                >
                  <Ionicons name="add" size={18} color={COLORS.primary} />
                </TouchableOpacity>
              </View>
            </View>
            
            {/* Selected Character Preview */}
            {selectedCharacter && (
              <View style={styles.characterPreview}>
                <View style={styles.characterAvatar}>
                  {selectedCharacter.referenceImages?.[0] ? (
                    <Image source={{ uri: selectedCharacter.referenceImages[0] }} style={styles.avatarImage} />
                  ) : (
                    <Ionicons name="person-circle-outline" size={28} color={COLORS.textMuted} />
                  )}
                </View>
                <View style={styles.characterInfo}>
                  <Text style={styles.characterName}>{selectedCharacter.name}</Text>
                  <Text style={styles.characterDesc}>{selectedCharacter.description}</Text>
                </View>
                <TouchableOpacity onPress={() => {
                  setEditingCharacter(selectedCharacter);
                  setShowCharacterModal(true);
                }}>
                  <Ionicons name="pencil" size={18} color={COLORS.textMuted} />
                </TouchableOpacity>
              </View>
            )}
            
            {/* Topic Input */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Topic / Prompt</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={topic}
                onChangeText={setTopic}
                placeholder="Enter a topic or detailed prompt..."
                placeholderTextColor={COLORS.textMuted}
                multiline
                numberOfLines={4}
              />
            </View>
            
            {/* Generate Script Button */}
            <TouchableOpacity
              style={[styles.btn, !topic && styles.btnDisabled]}
              onPress={generateScript}
              disabled={!topic || pipelineStatus === 'running'}
            >
              <Ionicons name="sparkles" size={18} color={COLORS.background} />
              <Text style={styles.btnText}>Generate Script</Text>
            </TouchableOpacity>
            
            {/* Generated Script */}
            {generatedScript ? (
              <View style={styles.formGroup}>
                <Text style={styles.label}>Generated Script</Text>
                <TextInput
                  style={[styles.input, styles.textarea, { height: 150 }]}
                  value={generatedScript}
                  onChangeText={setGeneratedScript}
                  multiline
                />
              </View>
            ) : null}
          </GlassCard>
        )}

        {/* Generate Tab */}
        {activeTab === 'generate' && (
          <GlassCard style={styles.panel}>
            <Text style={styles.panelTitle}>
              <Ionicons name="videocam" size={18} color={COLORS.primary} /> Generation
            </Text>
            
            {/* Pipeline Status */}
            {pipelineStatus !== 'idle' && (
              <View style={styles.pipelineStatus}>
                <View style={styles.pipelineSteps}>
                  {PIPELINE_STEPS.map((step, i) => {
                    const stepIndex = PIPELINE_STEPS.findIndex(s => s.key === currentStep);
                    const isActive = step.key === currentStep;
                    const isDone = stepIndex > i;
                    
                    return (
                      <View key={step.key} style={styles.pipelineStep}>
                        <View style={[
                          styles.stepIcon,
                          isActive && styles.stepIconActive,
                          isDone && styles.stepIconDone,
                        ]}>
                          <Ionicons 
                            name={isDone ? 'checkmark' : step.icon} 
                            size={14} 
                            color={isActive ? COLORS.primary : isDone ? '#4caf50' : COLORS.textMuted} 
                          />
                        </View>
                        <Text style={[
                          styles.stepLabel,
                          isActive && styles.stepLabelActive,
                          isDone && styles.stepLabelDone,
                        ]}>
                          {step.label}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                
                {/* Progress Bar */}
                <View style={styles.progressBar}>
                  <View style={[styles.progressFill, { width: `${progress}%` }]} />
                </View>
              </View>
            )}
            
            {/* Generate Button */}
            <TouchableOpacity
              style={[
                styles.btnGenerate,
                (pipelineStatus === 'running' || !selectedModel) && styles.btnDisabled,
              ]}
              onPress={generateVideo}
              disabled={pipelineStatus === 'running' || !selectedModel}
            >
              {pipelineStatus === 'running' ? (
                <>
                  <ActivityIndicator size="small" color={COLORS.background} />
                  <Text style={styles.btnGenerateText}>Generating...</Text>
                </>
              ) : (
                <>
                  <Ionicons name="rocket" size={22} color={COLORS.background} />
                  <Text style={styles.btnGenerateText}>Generate Video</Text>
                </>
              )}
            </TouchableOpacity>
            
            {/* Output Preview */}
            {outputUrl && (
              <View style={styles.outputSection}>
                <Text style={styles.label}>Output</Text>
                <VideoPlayerView uri={outputUrl} style={styles.videoPlayer} />
                <View style={styles.outputActions}>
                  <TouchableOpacity 
                    style={[styles.btnSmall, { backgroundColor: '#0088cc' }, sendingTelegram && styles.btnDisabled]}
                    disabled={sendingTelegram}
                    onPress={async () => {
                      setSendingTelegram(true);
                      try {
                        await sendToTelegram(outputUrl);
                        Alert.alert('Sent', 'Video sent to Telegram');
                      } catch (e) {
                        Alert.alert('Send failed', e.message);
                      } finally {
                        setSendingTelegram(false);
                      }
                    }}
                  >
                    {sendingTelegram ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Ionicons name="send" size={16} color="#fff" />
                    )}
                    <Text style={[styles.btnSmallText, { color: '#fff' }]}>Send</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            
            {/* Error */}
            {error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={18} color="#f44336" />
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity onPress={() => setError(null)}>
                  <Ionicons name="close" size={18} color="#f44336" />
                </TouchableOpacity>
              </View>
            )}
            
            {/* Status Summary */}
            <View style={styles.statusSummary}>
              <View style={styles.statusItem}>
                <Text style={styles.statusLabel}>Model</Text>
                <Text style={styles.statusValue}>
                  {selectedModel ? models.find(m => m.id === selectedModel)?.name || selectedModel : 'None'}
                </Text>
              </View>
              <View style={styles.statusItem}>
                <Text style={styles.statusLabel}>Ratio</Text>
                <Text style={styles.statusValue}>{aspectRatio}</Text>
              </View>
              <View style={styles.statusItem}>
                <Text style={styles.statusLabel}>Duration</Text>
                <Text style={styles.statusValue}>{duration}s</Text>
              </View>
            </View>
          </GlassCard>
        )}

      </ScrollView>

      {/* Character Modal */}
      <CharacterModal
        visible={showCharacterModal}
        character={editingCharacter}
        onSave={saveCharacter}
        onClose={() => {
          setShowCharacterModal(false);
          setEditingCharacter(null);
        }}
      />
    </SafeAreaView>
  );
}

// Character Modal Component
function CharacterModal({ visible, character, onSave, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [style, setStyle] = useState('');

  useEffect(() => {
    if (character) {
      setName(character.name || '');
      setDescription(character.description || '');
      setImages(character.referenceImages?.join('\n') || '');
      setVoiceId(character.voiceId || '');
      setStyle(character.style || '');
    } else {
      setName('');
      setDescription('');
      setImages('');
      setVoiceId('');
      setStyle('');
    }
  }, [character]);

  const handleSave = () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Name is required');
      return;
    }
    
    onSave({
      id: character?.id,
      name: name.trim(),
      description: description.trim(),
      referenceImages: images.split('\n').filter(url => url.trim()),
      voiceId: voiceId.trim(),
      style: style.trim(),
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>
            {character ? 'Edit Character' : 'New Character'}
          </Text>
          
          <ScrollView style={styles.modalScroll}>
            <View style={styles.formGroup}>
              <Text style={styles.label}>Name *</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Character name"
                placeholderTextColor={COLORS.textMuted}
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={description}
                onChangeText={setDescription}
                placeholder="Brief description..."
                placeholderTextColor={COLORS.textMuted}
                multiline
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={styles.label}>Reference Images (URLs, one per line)</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={images}
                onChangeText={setImages}
                placeholder="https://..."
                placeholderTextColor={COLORS.textMuted}
                multiline
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={styles.label}>Voice ID (ElevenLabs)</Text>
              <TextInput
                style={styles.input}
                value={voiceId}
                onChangeText={setVoiceId}
                placeholder="Optional"
                placeholderTextColor={COLORS.textMuted}
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={styles.label}>Style</Text>
              <TextInput
                style={styles.input}
                value={style}
                onChangeText={setStyle}
                placeholder="e.g., anime, realistic..."
                placeholderTextColor={COLORS.textMuted}
              />
            </View>
          </ScrollView>
          
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.btnCancel} onPress={onClose}>
              <Text style={styles.btnCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} onPress={handleSave}>
              <Text style={styles.btnText}>{character ? 'Save' : 'Create'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Helpers
function getVideoDimensions(ratio) {
  switch (ratio) {
    case '16:9': return { width: 1280, height: 720 };
    case '9:16': return { width: 720, height: 1280 };
    case '1:1': return { width: 1024, height: 1024 };
    default: return { width: 1280, height: 720 };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Styles
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollView: {
    flex: 1,
    padding: 16,
  },
  
  // Tab Bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  tabActive: {
    backgroundColor: COLORS.primaryLight,
  },
  tabText: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextActive: {
    color: COLORS.primary,
  },
  
  // Panel
  panel: {
    padding: 16,
    marginBottom: 16,
  },
  
  // Stream Tab
  streamPanel: {
    padding: 16,
    marginBottom: 16,
    flex: 1,
  },
  streamHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  streamHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  streamDesc: {
    color: COLORS.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  streamViewContainer: {
    flex: 1,
    minHeight: 400,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
  },
  connectionBadgeActive: {
    backgroundColor: 'rgba(34,197,94,0.15)',
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.textMuted,
  },
  connectionDotActive: {
    backgroundColor: '#22c55e',
  },
  connectionText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  connectionTextActive: {
    color: '#22c55e',
  },
  panelTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.primary,
    marginBottom: 16,
  },
  
  // Form
  formGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginBottom: 6,
  },
  input: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 12,
    color: COLORS.text,
    fontSize: 14,
  },
  textarea: {
    height: 100,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  
  // Picker
  pickerContainer: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    overflow: 'hidden',
  },
  picker: {
    color: COLORS.text,
    height: 50,
  },
  modelDesc: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 6,
  },
  
  // Radio
  radioGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  radioBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    alignItems: 'center',
  },
  radioBtnActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.cardBorder,
  },
  radioText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  radioTextActive: {
    color: COLORS.primary,
  },
  
  // Slider
  slider: {
    width: '100%',
    height: 40,
  },
  
  // Checkbox
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  checkboxLabel: {
    color: COLORS.text,
    fontSize: 14,
  },
  
  // Buttons
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    gap: 8,
  },
  btnText: {
    color: COLORS.background,
    fontSize: 14,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    gap: 6,
  },
  btnSmallText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  btnGenerate: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 10,
    marginVertical: 16,
  },
  btnGenerateText: {
    color: COLORS.background,
    fontSize: 16,
    fontWeight: '700',
  },
  btnCancel: {
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  btnCancelText: {
    color: COLORS.textMuted,
    fontSize: 14,
  },
  
  // Character
  characterPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
    gap: 12,
  },
  characterAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 48,
    height: 48,
  },
  avatarEmoji: {
    fontSize: 24,
  },
  characterInfo: {
    flex: 1,
  },
  characterName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  characterDesc: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  
  // Pipeline
  pipelineStatus: {
    marginBottom: 16,
  },
  pipelineSteps: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  pipelineStep: {
    alignItems: 'center',
    flex: 1,
  },
  stepIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  stepIconActive: {
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  stepIconDone: {
    backgroundColor: 'rgba(76,175,80,0.2)',
  },
  stepLabel: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
  stepLabelActive: {
    color: COLORS.primary,
    fontWeight: '600',
  },
  stepLabelDone: {
    color: '#4caf50',
  },
  progressBar: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
  },
  
  // Output
  outputSection: {
    marginTop: 16,
    padding: 12,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 8,
  },
  videoPlayer: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    marginVertical: 12,
    backgroundColor: '#000',
  },
  outputActions: {
    flexDirection: 'row',
    gap: 8,
  },
  
  // Error
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(244,67,54,0.15)',
    borderWidth: 1,
    borderColor: '#f44336',
    borderRadius: 8,
    padding: 12,
    gap: 8,
    marginTop: 16,
  },
  errorText: {
    flex: 1,
    color: '#f44336',
    fontSize: 13,
  },
  
  // Status Summary
  statusSummary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  statusItem: {
    alignItems: 'center',
  },
  statusLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
  },
  
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.primary,
    marginBottom: 16,
  },
  modalScroll: {
    maxHeight: 400,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
});
