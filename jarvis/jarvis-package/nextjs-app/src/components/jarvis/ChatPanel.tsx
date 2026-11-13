'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useJarvisStore, type Message, type ChatAttachment } from '@/lib/jarvis-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Send,
  Mic,
  MicOff,
  Search,
  ImageIcon,
  FileText,
  Users,
  Bot,
  User,
  Info,
  Loader2,
  Paperclip,
  X,
  Volume2,
  VolumeX,
  Code2,
  Shield,
  TestTube2,
  Gauge,
  CreditCard,
  Puzzle,
  Globe,
  Wrench,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'

const metadataBadgeMap: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
  search: { icon: <Search className="size-3" />, label: 'Web Search', className: 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50' },
  image_gen: { icon: <ImageIcon className="size-3" />, label: 'Image Generated', className: 'bg-purple-900/40 text-purple-300 border-purple-700/50' },
  file_upload: { icon: <FileText className="size-3" />, label: 'File', className: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  swarm: { icon: <Users className="size-3" />, label: 'Swarm', className: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  voice: { icon: <Mic className="size-3" />, label: 'Voice', className: 'bg-sky-900/40 text-sky-300 border-sky-700/50' },
  text: { icon: <Info className="size-3" />, label: 'Text', className: 'bg-slate-700/40 text-slate-300 border-slate-600/50' },
  agent: { icon: <Users className="size-3" />, label: 'Agent', className: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
}

const toolIconMap: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
  web_search: { icon: <Search className="size-3" />, label: 'Web Search', className: 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50' },
  image_generate: { icon: <ImageIcon className="size-3" />, label: 'Image Gen', className: 'bg-purple-900/40 text-purple-300 border-purple-700/50' },
  web_reader: { icon: <Globe className="size-3" />, label: 'Web Reader', className: 'bg-blue-900/40 text-blue-300 border-blue-700/50' },
  generate_document: { icon: <FileText className="size-3" />, label: 'Document Gen', className: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  track_shipment: { icon: <Globe className="size-3" />, label: 'Shipment Track', className: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
}

const agentIconMap: Record<string, React.ReactNode> = {
  'code-reviewer': <Code2 className="size-3" />,
  'security-auditor': <Shield className="size-3" />,
  'test-engineer': <TestTube2 className="size-3" />,
  'web-perf': <Gauge className="size-3" />,
  'payment-agent': <CreditCard className="size-3" />,
  'custom-agent': <Puzzle className="size-3" />,
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isAgent = message.role === 'agent'
  const badge = message.metadata?.type ? metadataBadgeMap[message.metadata.type] : null
  const agentName = message.metadata?.agentName
  const toolsUsed = (message.metadata as Record<string, unknown>)?.toolsUsed as string[] | undefined

  if (isSystem) {
    return (
      <div className="flex justify-center animate-fade-up">
        <div className="bg-[var(--surface)]/60 border border-[var(--jarvis-dark)]/30 rounded-lg px-4 py-2 max-w-[80%]">
          <div className="flex items-center gap-2 mb-1">
            <Info className="size-3 text-muted-foreground" />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">System</span>
          </div>
          <p className="text-xs text-muted-foreground text-center">{message.content}</p>
          <span className="text-[9px] text-muted-foreground/50 font-mono mt-1 block text-center">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-up`}
    >
      <div
        className={`max-w-[85%] rounded-xl px-4 py-3 ${
          isUser
            ? 'bg-[var(--surface-light)] border border-[var(--jarvis-dark)]/20 text-foreground'
            : isAgent
              ? 'bg-[var(--surface)] border-l-2 border-l-emerald-400 border border-[var(--jarvis-dark)]/30 text-foreground'
              : 'bg-[var(--surface)] border-l-2 border-l-[var(--jarvis)] border border-[var(--jarvis-dark)]/30 text-foreground'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center gap-2 mb-1.5 ${isUser ? 'justify-end' : ''}`}>
          {isUser ? (
            <>
              <span className="text-[10px] font-mono text-muted-foreground">
                {new Date(message.timestamp).toLocaleTimeString()}
              </span>
              <User className="size-3 text-muted-foreground" />
            </>
          ) : isAgent && agentName ? (
            <>
              {agentIconMap[message.metadata?.agentId || ''] || <Users className="size-3 text-emerald-400" />}
              <span className="text-[10px] font-mono text-emerald-400">{agentName}</span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {new Date(message.timestamp).toLocaleTimeString()}
              </span>
            </>
          ) : (
            <>
              <Bot className="size-3 text-[var(--jarvis)]" />
              <span className="text-[10px] font-mono text-[var(--jarvis)]">JARVIS</span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {new Date(message.timestamp).toLocaleTimeString()}
              </span>
            </>
          )}
        </div>

        {/* Content */}
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>

        {/* Attached files indicator */}
        {message.metadata?.attachedFiles && message.metadata.attachedFiles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.metadata.attachedFiles.map((f) => (
              <Badge key={f.id} variant="outline" className="text-[9px] px-1.5 py-0 border-amber-700/50 text-amber-300 bg-amber-900/20">
                <FileText className="size-2.5 mr-0.5" />
                {f.name}
              </Badge>
            ))}
          </div>
        )}

        {/* Tools Used Indicator */}
        {toolsUsed && toolsUsed.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <Wrench className="size-3 text-muted-foreground" />
            <span className="text-[9px] font-mono text-muted-foreground">Used:</span>
            {toolsUsed.map((tool) => {
              const toolInfo = toolIconMap[tool]
              return toolInfo ? (
                <Badge key={tool} variant="outline" className={toolInfo.className}>
                  {toolInfo.icon}
                  <span className="ml-1">{toolInfo.label}</span>
                  <CheckCircle2 className="size-2.5 ml-1" />
                </Badge>
              ) : (
                <Badge key={tool} variant="outline" className="bg-slate-700/40 text-slate-300 border-slate-600/50">
                  <Wrench className="size-2.5 mr-1" />
                  {tool}
                  <CheckCircle2 className="size-2.5 ml-1" />
                </Badge>
              )
            })}
          </div>
        )}

        {/* Metadata badge */}
        {badge && !toolsUsed && (
          <div className="mt-2">
            <Badge variant="outline" className={badge.className}>
              {badge.icon}
              {badge.label}
            </Badge>
          </div>
        )}

        {/* Sources from web search */}
        {message.metadata?.sources && message.metadata.sources.length > 0 && (
          <div className="mt-2 space-y-1">
            <p className="text-[9px] font-mono text-muted-foreground flex items-center gap-1">
              <ExternalLink className="size-2.5" />
              Sources:
            </p>
            {message.metadata.sources.map((source, idx) => (
              <a
                key={idx}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-xs text-[var(--jarvis)] hover:underline truncate"
              >
                ↗ {source.title || source.url}
              </a>
            ))}
          </div>
        )}

        {/* Generated Image */}
        {message.metadata?.imageUrl && (
          <div className="mt-2 rounded-lg overflow-hidden border border-[var(--jarvis-dark)]/30">
            <img
              src={message.metadata.imageUrl}
              alt="JARVIS generated content"
              className="w-full max-h-72 object-contain bg-black/20"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function TypingIndicator({ agentName }: { agentName?: string }) {
  return (
    <div className="flex justify-start animate-fade-up">
      <div className={`bg-[var(--surface)] border-l-2 ${agentName ? 'border-l-emerald-400' : 'border-l-[var(--jarvis)]'} border border-[var(--jarvis-dark)]/30 rounded-xl px-4 py-3`}>
        <div className="flex items-center gap-2">
          {agentName ? (
            <>
              <Users className="size-3 text-emerald-400" />
              <span className="text-[10px] font-mono text-emerald-400">{agentName}</span>
            </>
          ) : (
            <>
              <Bot className="size-3 text-[var(--jarvis)]" />
              <span className="text-[10px] font-mono text-[var(--jarvis)]">JARVIS</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 mt-2">
          <div className="w-2 h-2 rounded-full bg-[var(--jarvis)] typing-dot-1" />
          <div className="w-2 h-2 rounded-full bg-[var(--jarvis)] typing-dot-2" />
          <div className="w-2 h-2 rounded-full bg-[var(--jarvis)] typing-dot-3" />
        </div>
      </div>
    </div>
  )
}

export default function ChatPanel() {
  const [inputValue, setInputValue] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)

  const {
    messages,
    isProcessing,
    addMessage,
    setProcessing,
    setListening,
    setSpeaking,
    setAudioLevel,
    voiceMode,
    setVoiceMode,
    chatAttachments,
    addChatAttachment,
    updateChatAttachment,
    removeChatAttachment,
    clearChatAttachments,
    activeChatAgents,
    toggleChatAgent,
    swarmAgents,
  } = useJarvisStore()

  // Close agent picker on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        const toggleBtn = agentPickerRef.current.querySelector('[data-agent-toggle]')
        if (toggleBtn && toggleBtn.contains(e.target as Node)) return
        setShowAgentPicker(false)
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [showAgentPicker])

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      }
    }
  }, [messages, isProcessing])

  // TTS playback for voice mode
  const playTts = useCallback(async (text: string) => {
    try {
      setSpeaking(true)
      const res = await fetch('/api/jarvis/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 1000) }),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error')
        console.error('[JARVIS Chat TTS] API error:', res.status, errText)
        throw new Error('TTS failed: ' + res.status)
      }

      const audioBlob = await res.blob()
      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)
      ttsAudioRef.current = audio

      await new Promise<void>((resolve, reject) => {
        audio.oncanplaythrough = () => resolve()
        audio.onerror = () => reject(new Error('Audio load failed'))
        setTimeout(() => reject(new Error('Audio load timeout')), 15000)
        audio.load()
      })

      audio.onended = () => {
        setSpeaking(false)
        URL.revokeObjectURL(audioUrl)
        ttsAudioRef.current = null
      }
      audio.onerror = () => {
        setSpeaking(false)
        URL.revokeObjectURL(audioUrl)
        ttsAudioRef.current = null
      }

      await audio.play()
    } catch (err) {
      console.error('[JARVIS Chat TTS] Playback error:', err)
      setSpeaking(false)
    }
  }, [setSpeaking])

  const stopTts = useCallback(() => {
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current.currentTime = 0
      ttsAudioRef.current = null
    }
    setSpeaking(false)
  }, [setSpeaking])

  // Upload a file and get analysis
  const uploadFile = useCallback(async (file: File) => {
    const fileId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const attachment: ChatAttachment = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      status: 'uploading',
    }
    addChatAttachment(attachment)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/jarvis/upload', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json()

      updateChatAttachment(fileId, {
        status: 'complete',
        analysis: data.analysis || 'File uploaded successfully.',
        content: data.content,
      })
    } catch {
      updateChatAttachment(fileId, { status: 'error' })
    }
  }, [addChatAttachment, updateChatAttachment])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files) {
      Array.from(files).forEach(uploadFile)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isProcessing) return

      // Build file contexts from attachments
      const fileContexts = chatAttachments
        .filter((a) => a.status === 'complete')
        .map((a) => ({
          name: a.name,
          type: a.type,
          analysis: a.analysis,
          content: a.content,
        }))

      const attachedFiles = chatAttachments
        .filter((a) => a.status === 'complete')
        .map((a) => ({ id: a.id, name: a.name, size: a.size, type: a.type }))

      const userMessage: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
        metadata: {
          ...(attachedFiles.length > 0 ? { type: 'file_upload' as const } : {}),
          ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
        },
      }
      addMessage(userMessage)
      setInputValue('')
      clearChatAttachments()
      setProcessing(true)

      try {
        // If agents are active, dispatch to each agent
        if (activeChatAgents.length > 0) {
          for (const agentId of activeChatAgents) {
            const res = await fetch('/api/jarvis/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: text.trim(),
                history: [],
                agentId,
                fileContexts,
              }),
            })

            if (!res.ok) throw new Error('Agent chat failed')
            const data = await res.json()

            const agentMsg: Message = {
              id: `msg-${Date.now()}-agent-${agentId}`,
              role: 'agent',
              content: data.response || 'Agent processed your request.',
              timestamp: Date.now(),
              metadata: {
                type: 'agent',
                agentId,
                agentName: data.metadata?.agentName || agentId,
                ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
                ...(data.metadata?.toolsUsed ? { toolsUsed: data.metadata.toolsUsed } : {}),
                ...(data.metadata?.sources ? { sources: data.metadata.sources } : {}),
                ...(data.metadata?.imageUrl ? { imageUrl: data.metadata.imageUrl } : {}),
              },
            }
            addMessage(agentMsg)

            // Voice mode: speak the last agent's response
            if (voiceMode && agentId === activeChatAgents[activeChatAgents.length - 1]) {
              playTts(data.response || '')
            }
          }

          // Also get JARVIS's own summary if multiple agents
          if (activeChatAgents.length > 1) {
            const agentResponses = useJarvisStore.getState().messages
              .filter((m) => m.metadata?.type === 'agent' && m.timestamp > Date.now() - 30000)
              .map((m) => `${m.metadata?.agentName}: ${m.content}`)
              .join('\n\n')

            const summaryRes = await fetch('/api/jarvis/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: `Summarize and synthesize the following agent responses for the user. Provide a cohesive overview:\n\n${agentResponses}`,
                history: [],
              }),
            })

            if (summaryRes.ok) {
              const summaryData = await summaryRes.json()
              addMessage({
                id: `msg-${Date.now()}-summary`,
                role: 'assistant',
                content: summaryData.response || 'Analysis complete.',
                timestamp: Date.now(),
                metadata: summaryData.metadata,
              })
              if (voiceMode) {
                playTts(summaryData.response || '')
              }
            }
          }
        } else {
          // Standard JARVIS chat
          const currentMessages = useJarvisStore.getState().messages
          const history = currentMessages.slice(-20).map((m) => ({
            role: m.role === 'agent' ? 'assistant' : m.role,
            content: m.content,
          }))

          const res = await fetch('/api/jarvis/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text.trim(),
              history,
              fileContexts,
            }),
          })

          if (!res.ok) throw new Error('Chat request failed')
          const data = await res.json()

          const assistantMessage: Message = {
            id: `msg-${Date.now()}-resp`,
            role: 'assistant',
            content: data.response || data.content || 'I processed your request.',
            timestamp: Date.now(),
            metadata: data.metadata,
          }
          addMessage(assistantMessage)

          // Voice mode: speak the response
          if (voiceMode) {
            playTts(data.response || '')
          }
        }
      } catch {
        const errorMessage: Message = {
          id: `msg-${Date.now()}-err`,
          role: 'system',
          content: 'Connection error. Please try again.',
          timestamp: Date.now(),
        }
        addMessage(errorMessage)
      } finally {
        setProcessing(false)
      }
    },
    [addMessage, isProcessing, setProcessing, chatAttachments, activeChatAgents, voiceMode, playTts, clearChatAttachments]
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(inputValue)
  }

  const toggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      setIsRecording(false)
      setListening(false)
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mediaRecorder = new MediaRecorder(stream)
        audioChunksRef.current = []

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data)
          }
        }

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
          stream.getTracks().forEach((t) => t.stop())

          setProcessing(true)
          try {
            const formData = new FormData()
            formData.append('audio', audioBlob, 'recording.webm')

            const sttRes = await fetch('/api/jarvis/stt', {
              method: 'POST',
              body: formData,
            })

            if (!sttRes.ok) throw new Error('STT request failed')
            const sttData = await sttRes.json()

            if (sttData.text) {
              sendMessage(sttData.text)
            } else if (sttData.transcription) {
              sendMessage(sttData.transcription)
            }
          } catch {
            addMessage({
              id: `msg-${Date.now()}-stt-err`,
              role: 'system',
              content: 'Voice recognition failed. Please try again.',
              timestamp: Date.now(),
            })
          } finally {
            setProcessing(false)
          }
        }

        const audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        source.connect(analyser)
        analyser.fftSize = 256
        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        const monitorLevel = () => {
          if (mediaRecorder.state === 'recording') {
            analyser.getByteFrequencyData(dataArray)
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255
            setAudioLevel(avg)
            requestAnimationFrame(monitorLevel)
          } else {
            setAudioLevel(0)
            audioContext.close()
          }
        }

        mediaRecorderRef.current = mediaRecorder
        mediaRecorder.start(100)
        monitorLevel()
        setIsRecording(true)
        setListening(true)
      } catch {
        addMessage({
          id: `msg-${Date.now()}-mic-err`,
          role: 'system',
          content: 'Microphone access denied. Please allow microphone access.',
          timestamp: Date.now(),
        })
      }
    }
  }

  const completedAttachments = chatAttachments.filter((a) => a.status === 'complete')
  const hasAttachments = chatAttachments.length > 0

  return (
    <div className="flex flex-col h-full bg-[var(--surface)]/30 rounded-xl border border-[var(--jarvis-dark)]/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--jarvis-dark)]/20">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[var(--jarvis)] animate-jarvis-pulse" />
          <span className="text-sm font-mono text-[var(--jarvis)]">JARVIS Chat</span>
          <Badge variant="outline" className="text-[8px] px-1.5 py-0 border-cyan-700/40 text-cyan-400 bg-cyan-900/20">
            <Wrench className="size-2.5 mr-0.5" />
            Operations Mode
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {/* Voice mode toggle */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              if (voiceMode) {
                stopTts()
                setVoiceMode(false)
              } else {
                setVoiceMode(true)
              }
            }}
            className={`h-7 px-2 text-[10px] font-mono ${
              voiceMode
                ? 'text-[var(--jarvis)] bg-[var(--jarvis)]/10 hover:bg-[var(--jarvis)]/20'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {voiceMode ? <Volume2 className="size-3 mr-1" /> : <VolumeX className="size-3 mr-1" />}
            Voice
          </Button>
          <span className="text-[10px] font-mono text-muted-foreground">
            {messages.length} messages
          </span>
        </div>
      </div>

      {/* Active agents bar */}
      {activeChatAgents.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-2 bg-emerald-900/10 border-b border-emerald-700/20 flex-wrap">
          <Users className="size-3 text-emerald-400" />
          <span className="text-[10px] font-mono text-emerald-400 mr-1">Active:</span>
          {activeChatAgents.map((agentId) => {
            const agent = swarmAgents.find((a) => a.id === agentId)
            return agent ? (
              <Badge
                key={agentId}
                variant="outline"
                className="text-[9px] px-1.5 py-0 border-emerald-600/40 text-emerald-300 bg-emerald-900/20 cursor-pointer hover:bg-emerald-900/40"
                onClick={() => toggleChatAgent(agentId)}
              >
                {agentIconMap[agentId]}
                <span className="ml-0.5">{agent.name}</span>
                <X className="size-2.5 ml-1" />
              </Badge>
            ) : null
          })}
          <span className="text-[9px] text-muted-foreground font-mono ml-1">
            Agents will respond to your messages
          </span>
        </div>
      )}

      {/* Messages */}
      <ScrollArea className="flex-1 p-4 jarvis-scrollbar" ref={scrollRef}>
        <div className="space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bot className="size-10 text-[var(--jarvis-dark)] mb-3" />
              <p className="text-sm text-muted-foreground font-mono mb-2">
                JARVIS is ready. How can I assist you?
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] text-muted-foreground/60 font-mono">
                <span className="flex items-center gap-1"><Search className="size-3" /> Web Search</span>
                <span>•</span>
                <span className="flex items-center gap-1"><ImageIcon className="size-3" /> Image Gen</span>
                <span>•</span>
                <span className="flex items-center gap-1"><Paperclip className="size-3" /> Files</span>
                <span>•</span>
                <span className="flex items-center gap-1"><Volume2 className="size-3" /> Voice</span>
              </div>
              <div className="mt-3 px-3 py-2 bg-cyan-900/10 border border-cyan-700/20 rounded-lg">
                <p className="text-[9px] font-mono text-cyan-400">
                  <Wrench className="size-3 inline mr-1" />
                  Operations: Web Search • Image Gen • Document Gen • Shipment Tracking • Page Reader
                </p>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {isProcessing && <TypingIndicator agentName={activeChatAgents.length > 0 ? swarmAgents.find(a => a.id === activeChatAgents[0])?.name : undefined} />}
        </div>
      </ScrollArea>

      {/* File attachments preview */}
      {hasAttachments && (
        <div className="flex items-center gap-1.5 px-4 py-2 bg-[var(--surface)]/60 border-t border-[var(--jarvis-dark)]/10 flex-wrap">
          <Paperclip className="size-3 text-muted-foreground" />
          {chatAttachments.map((att) => (
            <Badge
              key={att.id}
              variant="outline"
              className={`text-[9px] px-1.5 py-0 cursor-pointer ${
                att.status === 'complete'
                  ? 'border-amber-600/40 text-amber-300 bg-amber-900/20'
                  : att.status === 'error'
                    ? 'border-red-600/40 text-red-300 bg-red-900/20'
                    : 'border-muted-foreground/30 text-muted-foreground bg-muted-foreground/10'
              }`}
            >
              <FileText className="size-2.5 mr-0.5" />
              {att.name}
              {att.status === 'uploading' && <Loader2 className="size-2.5 ml-1 animate-spin" />}
              {att.status === 'complete' && (
                <X
                  className="size-2.5 ml-1 hover:text-red-400"
                  onClick={(e) => { e.stopPropagation(); removeChatAttachment(att.id) }}
                />
              )}
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-[9px] text-muted-foreground hover:text-red-400 px-1"
            onClick={clearChatAttachments}
          >
            Clear all
          </Button>
        </div>
      )}

      {/* Input area */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-[var(--jarvis-dark)]/20">
        <div className="flex items-center gap-2">
          {/* Agent selector button */}
          <div className="relative" ref={agentPickerRef}>
            <Button
              type="button"
              size="icon"
              variant="outline"
              data-agent-toggle
              onClick={() => setShowAgentPicker(!showAgentPicker)}
              className={`shrink-0 border-[var(--jarvis-dark)]/30 ${
                activeChatAgents.length > 0
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-900/20 hover:bg-emerald-900/30'
                  : 'text-[var(--jarvis)] hover:text-[var(--jarvis)] hover:bg-[var(--surface-light)]'
              }`}
            >
              <Users className="size-4" />
            </Button>

            {/* Agent picker dropdown */}
            {showAgentPicker && (
              <div className="absolute bottom-full left-0 mb-2 w-72 bg-[var(--surface)] border border-[var(--jarvis-dark)]/30 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--jarvis-dark)]/20">
                  <p className="text-xs font-mono text-[var(--jarvis)]">Swarm Agents</p>
                  <p className="text-[9px] text-muted-foreground font-mono">Select agents to include in chat</p>
                </div>
                <div className="max-h-64 overflow-y-auto jarvis-scrollbar">
                  {swarmAgents.map((agent) => {
                    const isActive = activeChatAgents.includes(agent.id)
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => toggleChatAgent(agent.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                          isActive
                            ? 'bg-emerald-900/20 hover:bg-emerald-900/30'
                            : 'hover:bg-[var(--surface-light)]/30'
                        }`}
                      >
                        <div className={`p-1.5 rounded-md ${isActive ? 'bg-emerald-900/40 text-emerald-400' : 'bg-muted-foreground/10 text-muted-foreground'}`}>
                          {agentIconMap[agent.id] || <Puzzle className="size-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-medium ${isActive ? 'text-emerald-300' : 'text-foreground'}`}>
                            {agent.name}
                          </p>
                          <p className="text-[9px] text-muted-foreground truncate">{agent.description}</p>
                        </div>
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                          isActive ? 'border-emerald-400 bg-emerald-400' : 'border-muted-foreground/30'
                        }`}>
                          {isActive && <span className="text-black text-[10px]">✓</span>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* File attach button */}
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className={`shrink-0 border-[var(--jarvis-dark)]/30 ${
              hasAttachments
                ? 'text-amber-400 border-amber-500/30 bg-amber-900/20 hover:bg-amber-900/30'
                : 'text-[var(--jarvis)] hover:text-[var(--jarvis)] hover:bg-[var(--surface-light)]'
            }`}
          >
            <Paperclip className="size-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Text input */}
          <div className="relative flex-1">
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                activeChatAgents.length > 0
                  ? `Ask ${activeChatAgents.map(id => swarmAgents.find(a => a.id === id)?.name).join(', ')}...`
                  : 'Ask JARVIS anything...'
              }
              disabled={isProcessing}
              className="bg-[var(--surface)] border-[var(--jarvis-dark)]/30 focus-visible:border-[var(--jarvis)] focus-visible:ring-[var(--jarvis)]/20 placeholder:text-muted-foreground/50 font-mono text-sm pr-10"
            />
            {isProcessing && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <Loader2 className="size-4 text-[var(--jarvis)] animate-spin" />
              </div>
            )}
          </div>

          {/* Mic button */}
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={toggleRecording}
            disabled={isProcessing}
            className={`shrink-0 border-[var(--jarvis-dark)]/30 hover:border-[var(--jarvis)]/50 ${
              isRecording
                ? 'bg-red-900/40 text-red-400 border-red-500/50 hover:bg-red-900/60'
                : 'text-[var(--jarvis)] hover:text-[var(--jarvis)] hover:bg-[var(--surface-light)]'
            }`}
          >
            {isRecording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </Button>

          {/* Send button */}
          <Button
            type="submit"
            size="icon"
            disabled={(!inputValue.trim() && completedAttachments.length === 0) || isProcessing}
            className="shrink-0 bg-[var(--jarvis-dark)] hover:bg-[var(--jarvis)] text-[var(--jarvis)] hover:text-black disabled:opacity-30"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </form>
    </div>
  )
}
