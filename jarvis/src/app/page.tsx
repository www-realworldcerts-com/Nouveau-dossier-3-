'use client'

import { useEffect, useState } from 'react'
import { useJarvisStore } from '@/lib/jarvis-store'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import ChatPanel from '@/components/jarvis/ChatPanel'
import VoicePanel from '@/components/jarvis/VoicePanel'
import SwarmPanel from '@/components/jarvis/SwarmPanel'
import FileUploadPanel from '@/components/jarvis/FileUploadPanel'
import StatusBar from '@/components/jarvis/StatusBar'
import AudioVisualizer from '@/components/jarvis/AudioVisualizer'
import {
  MessageSquare,
  Mic,
  Users,
  FileUp,
  Shield,
  Lock,
  ChevronRight,
  Zap,
  Globe,
  Cpu,
} from 'lucide-react'

function AuthGate({ onAuth }: { onAuth: () => void }) {
  const [authStep, setAuthStep] = useState<'init' | 'connecting' | 'ready'>('init')

  const handleAuth = async () => {
    setAuthStep('connecting')
    // Simulate secure connection
    await new Promise((r) => setTimeout(r, 1500))
    setAuthStep('ready')
    await new Promise((r) => setTimeout(r, 500))
    onAuth()
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden bg-background">
      {/* Animated grid background */}
      <div className="absolute inset-0 z-0 jarvis-grid opacity-40" />

      {/* Floating orbs */}
      <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-[var(--jarvis)]/5 rounded-full blur-3xl animate-jarvis-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-48 h-48 bg-[var(--jarvis)]/3 rounded-full blur-2xl animate-jarvis-pulse" style={{ animationDelay: '1s' }} />

      <div className="z-10 flex flex-col items-center max-w-lg w-full px-6">
        {/* JARVIS Logo/Icon */}
        <div className="relative mb-8">
          <div className="w-24 h-24 rounded-full border-2 border-[var(--jarvis)]/40 flex items-center justify-center animate-jarvis-glow">
            <div className="w-20 h-20 rounded-full border border-[var(--jarvis)]/20 flex items-center justify-center">
              <Cpu className="size-10 text-[var(--jarvis)]" />
            </div>
          </div>
          {/* Orbiting dot */}
          <div className="absolute inset-0 animate-jarvis-ring">
            <div className="w-2 h-2 rounded-full bg-[var(--jarvis)] absolute -top-1 left-1/2 -translate-x-1/2" />
          </div>
        </div>

        <h1 className="text-4xl font-bold tracking-tighter text-foreground mb-1 font-mono">
          JARVIS
        </h1>
        <p className="text-sm font-mono text-[var(--jarvis)] mb-1 tracking-widest uppercase">
          Just A Rather Very Intelligent System
        </p>
        <p className="text-xs text-muted-foreground font-mono mb-8">
          Secure Personalized AI Agent &bull; Swarm Integration &bull; Voice Interface
        </p>

        {/* Auth card */}
        <div className="w-full bg-[var(--surface)]/80 backdrop-blur-md p-6 rounded-2xl border border-[var(--jarvis-dark)]/30 shadow-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-[var(--jarvis)]/10 border border-[var(--jarvis-dark)]/30">
              <Lock className="size-5 text-[var(--jarvis)]" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Secure Authentication</h2>
              <p className="text-xs text-muted-foreground font-mono">WSS/TLS Encrypted Connection</p>
            </div>
          </div>

          {/* Security features */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--surface-light)]/30">
              <Shield className="size-4 text-emerald-400" />
              <span className="text-[10px] font-mono text-emerald-400">End-to-End Encryption</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--surface-light)]/30">
              <Zap className="size-4 text-[var(--jarvis)]" />
              <span className="text-[10px] font-mono text-[var(--jarvis)]">Real-time Processing</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--surface-light)]/30">
              <Globe className="size-4 text-[var(--jarvis)]" />
              <span className="text-[10px] font-mono text-[var(--jarvis)]">Web Search & Analysis</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--surface-light)]/30">
              <Users className="size-4 text-[var(--jarvis)]" />
              <span className="text-[10px] font-mono text-[var(--jarvis)]">Swarm Agent Network</span>
            </div>
          </div>

          <Button
            onClick={handleAuth}
            disabled={authStep === 'connecting'}
            className="w-full py-5 bg-[var(--jarvis-dark)] hover:bg-[var(--jarvis)] text-[var(--jarvis)] hover:text-black font-bold tracking-widest uppercase transition-all duration-300 shadow-lg hover:shadow-[0_0_20px_var(--jarvis-glow)] group"
          >
            {authStep === 'init' && (
              <>
                <span>Initialize JARVIS</span>
                <ChevronRight className="size-4 ml-2 group-hover:translate-x-1 transition-transform" />
              </>
            )}
            {authStep === 'connecting' && (
              <span className="animate-pulse">Establishing Secure Connection...</span>
            )}
            {authStep === 'ready' && (
              <span>System Online</span>
            )}
          </Button>

          <p className="text-[9px] text-muted-foreground/50 font-mono text-center mt-4">
            v2.0.0 &bull; All communications are encrypted via WSS/TLS &bull; Swarm protocol: Secure Mesh
          </p>
        </div>
      </div>
    </div>
  )
}

function JarvisDashboard() {
  const {
    activeTab,
    setActiveTab,
    setConnected,
    setSwarmConnected,
    setAuthenticated,
    isConnected,
    isListening,
    isSpeaking,
    audioLevel,
  } = useJarvisStore()

  useEffect(() => {
    // Mark as connected once authenticated
    setConnected(true)
    // Auto-connect swarm
    fetch('/api/jarvis/swarm/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.connected) {
          setSwarmConnected(true)
        }
      })
      .catch(() => {})
  }, [setConnected, setSwarmConnected])

  return (
    <div className="min-h-screen flex flex-col bg-background jarvis-grid relative">
      {/* Header */}
      <header className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            {/* Mini visualizer */}
            <div className="hidden sm:block">
              <AudioVisualizer
                audioLevel={audioLevel}
                isActive={isListening || isSpeaking}
                isSpeaking={isSpeaking}
                isListening={isListening}
                size={40}
              />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tighter text-foreground font-mono">
                JARVIS
              </h1>
              <p className="text-[10px] font-mono text-[var(--jarvis)] tracking-widest uppercase -mt-0.5">
                Agent System v2.0
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface)]/80 border border-[var(--jarvis-dark)]/20">
              <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-[var(--jarvis)] animate-jarvis-pulse' : 'bg-red-500'}`} />
              <span className="text-[10px] font-mono text-muted-foreground">
                {isConnected ? 'System Online' : 'Offline'}
              </span>
            </div>
          </div>
        </div>

        {/* Status bar */}
        <StatusBar />
      </header>

      {/* Main content */}
      <main className="flex-1 px-4 pb-4 min-h-0">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'chat' | 'voice' | 'swarm' | 'files')}
          className="flex flex-col h-full"
        >
          <TabsList className="grid w-full grid-cols-4 bg-[var(--surface)]/60 border border-[var(--jarvis-dark)]/20 rounded-lg h-9">
            <TabsTrigger
              value="chat"
              className="text-xs font-mono data-[state=active]:bg-[var(--jarvis-dark)] data-[state=active]:text-[var(--jarvis)] transition-all gap-1"
            >
              <MessageSquare className="size-3.5" />
              <span className="hidden sm:inline">Chat</span>
            </TabsTrigger>
            <TabsTrigger
              value="voice"
              className="text-xs font-mono data-[state=active]:bg-[var(--jarvis-dark)] data-[state=active]:text-[var(--jarvis)] transition-all gap-1"
            >
              <Mic className="size-3.5" />
              <span className="hidden sm:inline">Voice</span>
            </TabsTrigger>
            <TabsTrigger
              value="swarm"
              className="text-xs font-mono data-[state=active]:bg-[var(--jarvis-dark)] data-[state=active]:text-[var(--jarvis)] transition-all gap-1"
            >
              <Users className="size-3.5" />
              <span className="hidden sm:inline">Swarm</span>
            </TabsTrigger>
            <TabsTrigger
              value="files"
              className="text-xs font-mono data-[state=active]:bg-[var(--jarvis-dark)] data-[state=active]:text-[var(--jarvis)] transition-all gap-1"
            >
              <FileUp className="size-3.5" />
              <span className="hidden sm:inline">Files</span>
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 mt-3 min-h-0">
            <TabsContent value="chat" className="h-full m-0">
              <ChatPanel />
            </TabsContent>
            <TabsContent value="voice" className="h-full m-0">
              <VoicePanel />
            </TabsContent>
            <TabsContent value="swarm" className="h-full m-0">
              <SwarmPanel />
            </TabsContent>
            <TabsContent value="files" className="h-full m-0">
              <FileUploadPanel />
            </TabsContent>
          </div>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="px-4 py-2 text-center border-t border-[var(--jarvis-dark)]/10">
        <p className="text-[9px] font-mono text-muted-foreground/40">
          JARVIS Agent System v2.0 &bull; Secure WSS/TLS &bull; Swarm Protocol Active &bull; All Rights Reserved
        </p>
      </footer>
    </div>
  )
}

export default function Home() {
  const { isAuthenticated, setAuthenticated } = useJarvisStore()

  if (!isAuthenticated) {
    return <AuthGate onAuth={() => setAuthenticated(true)} />
  }

  return <JarvisDashboard />
}
