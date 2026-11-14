'use client'

import { useEffect, useState } from 'react'
import { useJarvisStore } from '@/lib/jarvis-store'
import { Lock, LockOpen, Wifi, WifiOff, Cpu, Clock, AlertTriangle } from 'lucide-react'

interface RuntimeSummary {
  status: 'operational' | 'degraded' | 'blocked' | 'unknown'
  reasons: string[]
  heartbeat: { status: string; age_minutes: number | null }
  findings: { open: number; highest: string | null }
}

export default function StatusBar() {
  const [currentTime, setCurrentTime] = useState('')
  const [runtime, setRuntime] = useState<RuntimeSummary | null>(null)
  const { isConnected, encryptionEnabled, swarmConnected, swarmAgents } =
    useJarvisStore()

  const activeAgentCount = swarmAgents.filter(
    (a) => a.status === 'active' || a.status === 'processing'
  ).length

  // Read the real swarm state; a missing heartbeat is not "online".
  useEffect(() => {
    let active = true
    const loadRuntime = async () => {
      try {
        const res = await fetch('/api/jarvis/status', { cache: 'no-store' })
        const data = await res.json()
        if (active && data?.runtime) setRuntime(data.runtime)
      } catch {
        // Keep the last known state; the indicator falls back to the store.
      }
    }
    loadRuntime()
    const interval = setInterval(loadRuntime, 30000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  // Update time every second
  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      setCurrentTime(
        now.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    }
    updateTime()
    const interval = setInterval(updateTime, 1000)
    return () => clearInterval(interval)
  }, [])

  const runtimeStatus = runtime?.status || (isConnected ? 'online' : 'offline')
  const runtimeHealthy = runtimeStatus === 'operational' || runtimeStatus === 'online'
  const runtimeTitle = runtime?.reasons?.length ? runtime.reasons.join(' ') : undefined

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--surface)]/80 backdrop-blur-md border border-[var(--jarvis-dark)]/20 rounded-lg">
      {/* Left section: Connection & Encryption */}
      <div className="flex items-center gap-4">
        {/* Connection status */}
        <div className="flex items-center gap-1.5" title={runtimeTitle}>
          {runtimeHealthy ? (
            <Wifi className="size-3 text-[var(--jarvis)]" />
          ) : (
            <WifiOff className="size-3 text-red-400" />
          )}
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              runtimeHealthy ? 'bg-[var(--jarvis)]' : 'bg-red-500'
            }`}
          />
          <span
            className={`text-[10px] font-mono uppercase ${
              runtimeHealthy ? 'text-[var(--jarvis)]' : 'text-red-400'
            }`}
          >
            {runtime ? runtimeStatus : isConnected ? 'Online' : 'Offline'}
          </span>
        </div>

        {/* Encryption status */}
        <div className="flex items-center gap-1.5">
          {encryptionEnabled ? (
            <>
              <Lock className="size-3 text-emerald-400" />
              <span className="text-[10px] font-mono text-emerald-400">Encrypted</span>
            </>
          ) : (
            <>
              <LockOpen className="size-3 text-amber-400" />
              <span className="text-[10px] font-mono text-amber-400">Unencrypted</span>
            </>
          )}
        </div>
      </div>

      {/* Center section: Swarm & Agents */}
      <div className="flex items-center gap-4">
        {/* Swarm connectivity */}
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              swarmConnected ? 'bg-[var(--jarvis)]' : 'bg-muted-foreground/40'
            }`}
          />
          <span
            className={`text-[10px] font-mono ${
              swarmConnected ? 'text-[var(--jarvis)]' : 'text-muted-foreground'
            }`}
          >
            Swarm: {swarmConnected ? 'Active' : 'Inactive'}
          </span>
        </div>

        {/* Open audit findings */}
        {runtime && (
          <div className="flex items-center gap-1.5" title={runtime.findings.highest ? `Highest: ${runtime.findings.highest}` : undefined}>
            <AlertTriangle className={`size-3 ${runtime.findings.open ? 'text-amber-400' : 'text-muted-foreground'}`} />
            <span className="text-[10px] font-mono text-muted-foreground">
              Findings: <span className={runtime.findings.open ? 'text-amber-400' : 'text-[var(--jarvis)]'}>{runtime.findings.open}</span>
            </span>
          </div>
        )}

        {/* Active agents */}
        <div className="flex items-center gap-1.5">
          <Cpu className="size-3 text-muted-foreground" />
          <span className="text-[10px] font-mono text-muted-foreground">
            Agents: <span className="text-[var(--jarvis)]">{activeAgentCount}</span>
            <span className="text-muted-foreground/50">/{swarmAgents.length}</span>
          </span>
        </div>
      </div>

      {/* Right section: Timestamp */}
      <div className="flex items-center gap-1.5">
        <Clock className="size-3 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {currentTime}
        </span>
      </div>
    </div>
  )
}
