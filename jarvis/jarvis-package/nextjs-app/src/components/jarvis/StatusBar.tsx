'use client'

import { useEffect, useState } from 'react'
import { useJarvisStore } from '@/lib/jarvis-store'
import { Lock, LockOpen, Wifi, WifiOff, Cpu, Clock } from 'lucide-react'

export default function StatusBar() {
  const [currentTime, setCurrentTime] = useState('')
  const { isConnected, encryptionEnabled, swarmConnected, swarmAgents } =
    useJarvisStore()

  const activeAgentCount = swarmAgents.filter(
    (a) => a.status === 'active' || a.status === 'processing'
  ).length

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

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--surface)]/80 backdrop-blur-md border border-[var(--jarvis-dark)]/20 rounded-lg">
      {/* Left section: Connection & Encryption */}
      <div className="flex items-center gap-4">
        {/* Connection status */}
        <div className="flex items-center gap-1.5">
          {isConnected ? (
            <Wifi className="size-3 text-[var(--jarvis)]" />
          ) : (
            <WifiOff className="size-3 text-red-400" />
          )}
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? 'bg-[var(--jarvis)]' : 'bg-red-500'
            }`}
          />
          <span
            className={`text-[10px] font-mono ${
              isConnected ? 'text-[var(--jarvis)]' : 'text-red-400'
            }`}
          >
            {isConnected ? 'Online' : 'Offline'}
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
