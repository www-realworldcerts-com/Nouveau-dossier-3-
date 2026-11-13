'use client'

import { useState, useRef, useCallback } from 'react'
import { useJarvisStore } from '@/lib/jarvis-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import AudioVisualizer from './AudioVisualizer'
import { Mic, MicOff, Volume2, VolumeX, Loader2 } from 'lucide-react'

export default function VoicePanel() {
  const [transcript, setTranscript] = useState('')
  const [response, setResponse] = useState('')
  const [isTtsPlaying, setIsTtsPlaying] = useState(false)
  const [voiceState, setVoiceState] = useState<
    'idle' | 'recording' | 'processing' | 'responding'
  >('idle')

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
    async (text: string) => {
      try {
        setVoiceState('responding')
        setSpeaking(true)

        const res = await fetch('/api/jarvis/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })

        if (!res.ok) throw new Error('TTS request failed')

        const audioBlob = await res.blob()
        const audioUrl = URL.createObjectURL(audioBlob)

        const audio = new Audio(audioUrl)
        audioElementRef.current = audio
        setIsTtsPlaying(true)

        audio.onended = () => {
          setIsTtsPlaying(false)
          setSpeaking(false)
          setVoiceState('idle')
          URL.revokeObjectURL(audioUrl)
        }

        audio.onerror = () => {
          setIsTtsPlaying(false)
          setSpeaking(false)
          setVoiceState('idle')
          URL.revokeObjectURL(audioUrl)
        }

        await audio.play()
      } catch {
        setSpeaking(false)
        setIsTtsPlaying(false)
        setVoiceState('idle')
      }
    },
    [setSpeaking]
  )

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
        const transcription = sttData.transcription || ''

        setTranscript(transcription)

        if (!transcription.trim()) {
          setVoiceState('idle')
          setProcessing(false)
          return
        }

        // Step 2: Chat with transcription
        const chatRes = await fetch('/api/jarvis/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: transcription,
            history: [],
          }),
        })

        if (!chatRes.ok) throw new Error('Chat failed')
        const chatData = await chatRes.json()
        const responseText =
          chatData.response || chatData.content || 'I processed your request.'

        setResponse(responseText)

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
          metadata: chatData.metadata,
        })

        setProcessing(false)

        // Step 3: TTS playback
        await playTts(responseText)
      } catch {
        setVoiceState('idle')
        setProcessing(false)
        setResponse('Error processing voice input. Please try again.')
      }
    },
    [addMessage, playTts, setProcessing]
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      audioChunksRef.current = []

      // Audio monitoring
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
    }
  }, [voiceState, setListening, setAudioLevel, stopAudioMonitoring, processVoiceInput])

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
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
          {voiceState === 'idle'
            ? 'Ready'
            : voiceState === 'recording'
              ? 'Recording'
              : voiceState === 'processing'
                ? 'Processing'
                : 'Responding'}
        </span>
      </div>

      {/* Main visualizer area */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
        {/* AudioVisualizer */}
        <div className="relative">
          <AudioVisualizer
            audioLevel={audioLevel}
            isActive={voiceState !== 'idle'}
            isSpeaking={isSpeaking}
            isListening={isListening}
            size={220}
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

        {/* Listening label */}
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

        {voiceState === 'idle' && !transcript && !response && (
          <p className="text-xs text-muted-foreground text-center font-mono max-w-[250px]">
            Press the microphone to start a voice conversation with JARVIS
          </p>
        )}
      </div>
    </div>
  )
}
