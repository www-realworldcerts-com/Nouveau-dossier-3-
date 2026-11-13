'use client'

import { useCallback } from 'react'
import { useJarvisStore, type SwarmAgent } from '@/lib/jarvis-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Code2,
  Shield,
  TestTube2,
  Gauge,
  CreditCard,
  Puzzle,
  Wifi,
  WifiOff,
  Power,
  PowerOff,
  Loader2,
  Clock,
} from 'lucide-react'

const agentIconMap: Record<string, React.ReactNode> = {
  'code-reviewer': <Code2 className="size-5" />,
  'security-auditor': <Shield className="size-5" />,
  'test-engineer': <TestTube2 className="size-5" />,
  'web-performance': <Gauge className="size-5" />,
  'payment-agent': <CreditCard className="size-5" />,
  custom: <Puzzle className="size-5" />,
}

const statusConfig: Record<
  SwarmAgent['status'],
  { color: string; bg: string; label: string; dotColor: string }
> = {
  idle: {
    color: 'text-muted-foreground',
    bg: 'bg-muted-foreground/10',
    label: 'Idle',
    dotColor: 'bg-muted-foreground/40',
  },
  active: {
    color: 'text-[var(--jarvis)]',
    bg: 'bg-[var(--jarvis)]/10',
    label: 'Active',
    dotColor: 'bg-[var(--jarvis)]',
  },
  processing: {
    color: 'text-yellow-400',
    bg: 'bg-yellow-400/10',
    label: 'Processing',
    dotColor: 'bg-yellow-400',
  },
  error: {
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    label: 'Error',
    dotColor: 'bg-red-400',
  },
}

function AgentCard({ agent }: { agent: SwarmAgent }) {
  const { updateSwarmAgent } = useJarvisStore()
  const config = statusConfig[agent.status]
  const icon = agentIconMap[agent.type] || <Puzzle className="size-5" />
  const isActive = agent.status === 'active' || agent.status === 'processing'

  const toggleAgent = useCallback(async () => {
    const newState: SwarmAgent['status'] = isActive ? 'idle' : 'active'
    updateSwarmAgent(agent.id, { status: newState })

    try {
      await fetch(`/api/jarvis/swarm/agent/${agent.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activate: !isActive }),
      })
    } catch {
      // Revert on error
      updateSwarmAgent(agent.id, { status: agent.status })
    }
  }, [agent.id, agent.status, isActive, updateSwarmAgent])

  return (
    <Card className="bg-[var(--surface)] border-[var(--jarvis-dark)]/20 hover:border-[var(--jarvis-dark)]/40 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className={`p-2 rounded-lg ${config.bg} ${config.color}`}>{icon}</div>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${config.dotColor} ${agent.status === 'processing' ? 'animate-pulse' : ''}`} />
            <span className={`text-[10px] font-mono ${config.color}`}>
              {config.label}
            </span>
          </div>
        </div>

        <h3 className="text-sm font-semibold text-foreground mb-1">{agent.name}</h3>
        <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
          {agent.description}
        </p>

        {/* Capability tags */}
        <div className="flex flex-wrap gap-1 mb-3">
          {agent.capabilities.map((cap) => (
            <Badge
              key={cap}
              variant="outline"
              className="text-[9px] px-1.5 py-0 border-[var(--jarvis-dark)]/30 text-muted-foreground"
            >
              {cap}
            </Badge>
          ))}
        </div>

        {/* Last action */}
        {agent.lastAction && (
          <div className="flex items-center gap-1 mb-3 text-muted-foreground">
            <Clock className="size-3" />
            <span className="text-[9px] font-mono">{agent.lastAction}</span>
          </div>
        )}

        {/* Activate/Deactivate button */}
        <Button
          size="sm"
          variant="outline"
          onClick={toggleAgent}
          disabled={agent.status === 'processing'}
          className={`w-full text-xs font-mono ${
            isActive
              ? 'border-red-500/30 text-red-400 hover:bg-red-900/20 hover:text-red-300'
              : 'border-[var(--jarvis-dark)]/30 text-[var(--jarvis)] hover:bg-[var(--jarvis)]/10 hover:text-[var(--jarvis)]'
          }`}
        >
          {agent.status === 'processing' ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Processing...
            </>
          ) : isActive ? (
            <>
              <PowerOff className="size-3" />
              Deactivate
            </>
          ) : (
            <>
              <Power className="size-3" />
              Activate
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}

export default function SwarmPanel() {
  const { swarmAgents, swarmConnected, setSwarmConnected, setSwarmAgents } = useJarvisStore()

  const activeCount = swarmAgents.filter(
    (a) => a.status === 'active' || a.status === 'processing'
  ).length

  const connectSwarm = useCallback(async () => {
    try {
      const res = await fetch('/api/jarvis/swarm/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) throw new Error('Failed to connect')

      const data = await res.json()
      setSwarmConnected(true)

      if (data.agents) {
        setSwarmAgents(data.agents)
      }
    } catch {
      setSwarmConnected(false)
    }
  }, [setSwarmConnected, setSwarmAgents])

  return (
    <div className="flex flex-col h-full bg-[var(--surface)]/30 rounded-xl border border-[var(--jarvis-dark)]/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--jarvis-dark)]/20">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              swarmConnected ? 'bg-[var(--jarvis)] animate-jarvis-pulse' : 'bg-red-500'
            }`}
          />
          <span className="text-sm font-mono text-[var(--jarvis)]">Swarm Network</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={`text-[10px] font-mono ${
              swarmConnected
                ? 'border-[var(--jarvis)]/30 text-[var(--jarvis)]'
                : 'border-red-500/30 text-red-400'
            }`}
          >
            {swarmConnected ? (
              <Wifi className="size-3 mr-1" />
            ) : (
              <WifiOff className="size-3 mr-1" />
            )}
            {swarmConnected ? 'Connected' : 'Disconnected'}
          </Badge>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--surface)]/50 border-b border-[var(--jarvis-dark)]/10">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-muted-foreground">Agents:</span>
            <span className="text-[10px] font-mono text-foreground">{swarmAgents.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-muted-foreground">Active:</span>
            <span className="text-[10px] font-mono text-[var(--jarvis)]">{activeCount}</span>
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={connectSwarm}
          className={`text-[10px] font-mono h-7 ${
            swarmConnected
              ? 'border-[var(--jarvis)]/30 text-[var(--jarvis)] hover:bg-[var(--jarvis)]/10'
              : 'border-red-500/30 text-red-400 hover:bg-red-900/20'
          }`}
        >
          {swarmConnected ? (
            <>
              <Wifi className="size-3" />
              Reconnect
            </>
          ) : (
            <>
              <Wifi className="size-3" />
              Connect Swarm
            </>
          )}
        </Button>
      </div>

      {/* Operational notice */}
      <div className="px-4 py-2 bg-cyan-900/10 border-b border-cyan-700/20">
        <p className="text-[9px] font-mono text-cyan-400">
          ⚡ Swarm agents are fully operational — processing, tracking, generating, and executing across all domains.
        </p>
      </div>

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto p-4 jarvis-scrollbar">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {swarmAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </div>
    </div>
  )
}
