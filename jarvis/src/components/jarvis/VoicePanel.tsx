'use client'

import { useState, useRef, useCallback } from 'react'
import { useJarvisStore } from '@/lib/jarvis-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import AudioVisualizer from './AudioVisualizer'
import { Mic, MicOff, Volume2, VolumeX, Loader2, MessageSquare, Repeat } from 'lucide-react'

export default function VoicePanel() {
  const [transcript, setTranscript] = useState('')
  const [response, setResponse] = useState('')
  const [isTtsPlaying, setIsTtsPlaying] = useState(false)
  const [continuousMode, setContinuousMode] = useState(false)
  const [voiceState, setVoiceState] = useState<
    'idle' | 'recording' | 'processing' | 'responding'
  >('idle')
  const [conversationHistory, setConversationHistory] = useState<
    Array<{ role: string; content: string }>
  >([])

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const audioElementRef = useRef<HTMLAudioElement | null>(null)

  const {
    isListening,
    isSpeaking,
    audioLevel,
    setListening,
    setSpeaking,
    setAudioLevel,
    setProcessing,
    addMessage,
  } = useJarvisStore()

  const stopAudioMonitoring = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
    setAudioLevel(0)
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
  }, [setAudioLevel])

  const playTts = useCallback(
    async (text: string): Promise<void> => {
      try {
        setVoiceState('responding')
        setSpeaking(true)

        const res = await fetch('/api/jarvis/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 1000) }),
        })

        if (!res.ok) {
          const errText = await res.text().catch(() => 'Unknown error')
          console.error('[JARVIS Voice TTS] API error:', res.status, errText)
          throw new Error('TTS request failed: ' + res.status)
        }

        const audioBlob = await res.blob()
        const audioUrl = URL.createObjectURL(audioBlob)

        const audio = new Audio(audioUrl)
        audioElementRef.current = audio

        // Wait for audio to be loaded and ready before playing
        await new Promise<void>((resolve, reject) => {
          audio.oncanplaythrough = () => resolve()
          audio.onerror = () => reject(new Error('Audio load failed'))
          setTimeout(() => reject(new Error('Audio load timeout')), 15000)
          audio.load()
        })

        setIsTtsPlaying(true)

        audio.onended = () => {
          setIsTtsPlaying(false)
          setSpeaking(false)
          setVoiceState('idle')
          URL.revokeObjectURL(audioUrl)
          audioElementRef.current = null
        }

        audio.onerror = () => {
          setIsTtsPlaying(false)
          setSpeaking(false)
          setVoiceState('idle')
          URL.revokeObjectURL(audioUrl)
          audioElementRef.current = null
        }

        await audio.play()
      } catch (err) {
        console.error('[JARVIS Voice TTS] Playback error:', err)
        setSpeaking(false)
        setIsTtsPlaying(false)
        setVoiceState('idle')
      }
    },
    [setSpeaking]
  )

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      audioChunksRef.current = []

      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      source.connect(analyser)
      analyser.fftSize = 256
      audioContextRef.current = audioContext
      analyserRef.current = analyser

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const monitorLevel = () => {
        if (mediaRecorder.state === 'recording') {
          analyser.getByteFrequencyData(dataArray)
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255
          setAudioLevel(avg)
          animFrameRef.current = requestAnimationFrame(monitorLevel)
        }
      }

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        stream.getTracks().forEach((t) => t.stop())
        stopAudioMonitoring()
        processVoiceInput(audioBlob)
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(100)
      monitorLevel()

      setVoiceState('recording')
      setListening(true)
      setTranscript('')
      setResponse('')
    } catch {
      setVoiceState('idle')
      setListening(false)
      addMessage({
        id: `voice-err-${Date.now()}`,
        role: 'system',
        content: 'Microphone access denied. Please allow microphone access.',
        timestamp: Date.now(),
      })
    }
  }, [setListening, setAudioLevel, stopAudioMonitoring, addMessage])

  const processVoiceInput = useCallback(
    async (audioBlob: Blob) => {
      setVoiceState('processing')
      setProcessing(true)

      try {
        // Step 1: Speech-to-text
        const formData = new FormData()
        formData.append('audio', audioBlob, 'recording.webm')

        const sttRes = await fetch('/api/jarvis/stt', {
          method: 'POST',
          body: formData,
        })

        if (!sttRes.ok) throw new Error('STT failed')
        const sttData = await sttRes.json()
        // API returns "text" field, not "transcription"
        const transcription = sttData.text || sttData.transcription || ''

        setTranscript(transcription)

        if (!transcription.trim()) {
          setVoiceState('idle')
          setProcessing(false)
          return
        }

        // Step 2: Chat with transcription and conversation history
        const chatRes = await fetch('/api/jarvis/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: transcription,
            history: conversationHistory,
          }),
        })

        if (!chatRes.ok) throw new Error('Chat failed')
        const chatData = await chatRes.json()
        const responseText =
          chatData.response || chatData.content || 'I processed your request.'

        setResponse(responseText)

        // Update conversation history
        const newHistory = [
          ...conversationHistory,
          { role: 'user', content: transcription },
          { role: 'assistant', content: responseText },
        ].slice(-20) // Keep last 20 messages
        setConversationHistory(newHistory)

        // Add to messages
        addMessage({
          id: `voice-${Date.now()}`,
          role: 'user',
          content: transcription,
          timestamp: Date.now(),
          metadata: { type: 'voice' },
        })
        addMessage({
          id: `voice-${Date.now()}-resp`,
          role: 'assistant',
          content: responseText,
          timestamp: Date.now(),
          metadata: { type: 'voice' },
        })

        setProcessing(false)

        // Step 3: TTS playback — JARVIS speaks the response
        await playTts(responseText)

        // Step 4: If continuous mode, auto-start listening again
        if (continuousMode) {
          setTimeout(() => {
            startRecording()
          }, 500)
        }
      } catch {
        setVoiceState('idle')
        setProcessing(false)
        setResponse('Error processing voice input. Please try again.')
      }
    },
    [addMessage, playTts, setProcessing, conversationHistory, continuousMode, startRecording]
  )

  const toggleMic = useCallback(async () => {
    if (voiceState === 'recording') {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      setListening(false)
      stopAudioMonitoring()
      return
    }

    if (voiceState !== 'idle') return
    startRecording()
  }, [voiceState, setListening, stopAudioMonitoring, startRecording])

  const stopTts = useCallback(() => {
    if (audioElementRef.current) {
      audioElementRef.current.pause()
      audioElementRef.current.currentTime = 0
      audioElementRef.current = null
    }
    setIsTtsPlaying(false)
    setSpeaking(false)
    setVoiceState('idle')
  }, [setSpeaking])

  const clearConversation = () => {
    setTranscript('')
    setResponse('')
    setConversationHistory([])
  }

  return (
    <div className="flex flex-col h-full bg-[var(--surface)]/30 rounded-xl border border-[var(--jarvis-dark)]/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--jarvis-dark)]/20">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              voiceState === 'recording'
                ? 'bg-red-500 animate-pulse'
                : voiceState === 'processing'
                  ? 'bg-yellow-500 animate-pulse'
                  : voiceState === 'responding'
                    ? 'bg-[var(--jarvis)] animate-jarvis-pulse'
                    : 'bg-muted-foreground/30'
            }`}
          />
          <span className="text-sm font-mono text-[var(--jarvis)]">Voice Interface</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Continuous mode toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setContinuousMode(!continuousMode)}
            className={`h-7 px-2 text-[10px] font-mono ${
              continuousMode
                ? 'text-[var(--jarvis)] bg-[var(--jarvis)]/10 hover:bg-[var(--jarvis)]/20'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Repeat className="size-3 mr-1" />
            Continuous
          </Button>
          {/* Conversation length */}
          {conversationHistory.length > 0 && (
            <Badge variant="outline" className="text-[9px] font-mono border-[var(--jarvis-dark)]/30 text-muted-foreground">
              <MessageSquare className="size-2.5 mr-1" />
              {conversationHistory.length / 2} turns
            </Badge>
          )}
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            {voiceState === 'idle'
              ? 'Ready'
              : voiceState === 'recording'
                ? 'Recording'
                : voiceState === 'processing'
                  ? 'Processing'
                  : 'Speaking'}
          </span>
        </div>
      </div>

      {/* Main visualizer area */}
      <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6">
        {/* AudioVisualizer */}
        <div className="relative">
          <AudioVisualizer
            audioLevel={audioLevel}
            isActive={voiceState !== 'idle'}
            isSpeaking={isSpeaking}
            isListening={isListening}
            size={200}
          />
          {/* Glow ring behind visualizer when active */}
          {voiceState !== 'idle' && (
            <div
              className={`absolute inset-0 rounded-full -z-10 ${
                isSpeaking
                  ? 'shadow-[0_0_40px_var(--jarvis-glow),0_0_80px_var(--jarvis-glow)]'
                  : 'shadow-[0_0_20px_var(--jarvis-glow)]'
              }`}
            />
          )}
        </div>

        {/* Mic button */}
        <div className="relative">
          <Button
            onClick={toggleMic}
            disabled={voiceState === 'processing'}
            className={`w-16 h-16 rounded-full transition-all duration-300 ${
              voiceState === 'recording'
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-[0_0_20px_rgba(239,68,68,0.5)]'
                : voiceState === 'responding'
                  ? 'bg-[var(--jarvis)] hover:bg-[var(--jarvis)]/80 text-black shadow-[0_0_20px_var(--jarvis-glow)]'
                  : 'bg-[var(--jarvis-dark)] hover:bg-[var(--jarvis)] text-[var(--jarvis)] hover:text-black shadow-[0_0_10px_var(--jarvis-glow)]'
            }`}
          >
            {voiceState === 'recording' ? (
              <MicOff className="size-6" />
            ) : voiceState === 'processing' ? (
              <Loader2 className="size-6 animate-spin" />
            ) : (
              <Mic className="size-6" />
            )}
          </Button>

          {/* Pulse ring when recording */}
          {voiceState === 'recording' && (
            <div className="absolute inset-0 rounded-full border-2 border-red-500/50 animate-ping" />
          )}
        </div>

        {/* Status text */}
        {voiceState === 'recording' && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="w-1 bg-[var(--jarvis)] rounded-full transition-all duration-150"
                  style={{
                    height: `${8 + audioLevel * 20 + Math.sin(Date.now() / 200 + i) * 4}px`,
                  }}
                />
              ))}
            </div>
            <span className="text-xs font-mono text-[var(--jarvis)]">Listening...</span>
          </div>
        )}

        {voiceState === 'responding' && (
          <div className="flex items-center gap-2">
            <Volume2 className="size-4 text-[var(--jarvis)] animate-pulse" />
            <span className="text-xs font-mono text-[var(--jarvis)]">JARVIS is speaking...</span>
          </div>
        )}

        {/* Transcript */}
        {transcript && (
          <Card className="w-full max-w-sm bg-[var(--surface)] border-[var(--jarvis-dark)]/30">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                <span className="text-[10px] font-mono text-blue-400 uppercase tracking-wider">
                  You said
                </span>
              </div>
              <p className="text-sm text-foreground">{transcript}</p>
            </CardContent>
          </Card>
        )}

        {/* Response */}
        {response && (
          <Card className="w-full max-w-sm bg-[var(--surface)] border-l-2 border-l-[var(--jarvis)] border-[var(--jarvis-dark)]/30">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--jarvis)]" />
                <span className="text-[10px] font-mono text-[var(--jarvis)] uppercase tracking-wider">
                  JARVIS
                </span>
              </div>
              <p className="text-sm text-foreground">{response}</p>
            </CardContent>
          </Card>
        )}

        {/* TTS controls */}
        {isTtsPlaying && (
          <Button
            variant="outline"
            size="sm"
            onClick={stopTts}
            className="border-[var(--jarvis-dark)]/30 text-[var(--jarvis)] hover:bg-[var(--surface-light)]"
          >
            <VolumeX className="size-4 mr-1" />
            Stop Audio
          </Button>
        )}

        {/* Replay last response */}
        {response && voiceState === 'idle' && !isTtsPlaying && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => playTts(response)}
            className="border-[var(--jarvis-dark)]/30 text-[var(--jarvis)] hover:bg-[var(--jarvis)]/10"
          >
            <Volume2 className="size-4 mr-1" />
            Replay Response
          </Button>
        )}

        {voiceState === 'idle' && !transcript && !response && (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xs text-muted-foreground font-mono max-w-[250px]">
              Press the microphone to start a voice conversation with JARVIS
            </p>
            <p className="text-[10px] text-muted-foreground/50 font-mono">
              Enable &quot;Continuous&quot; mode for back-and-forth conversation
            </p>
          </div>
        )}
      </div>

      {/* Footer: Clear conversation */}
      {conversationHistory.length > 0 && voiceState === 'idle' && (
        <div className="px-4 py-2 border-t border-[var(--jarvis-dark)]/10 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearConversation}
            className="text-[10px] font-mono text-muted-foreground hover:text-red-400"
          >
            Clear Voice History ({conversationHistory.length / 2} turns)
          </Button>
        </div>
      )}
    </div>
  )
}
