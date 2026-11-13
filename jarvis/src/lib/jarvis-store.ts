import { create } from 'zustand'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'agent'
  content: string
  timestamp: number
  metadata?: {
    type?: 'search' | 'image_gen' | 'file_upload' | 'swarm' | 'voice' | 'text' | 'agent'
    imageUrl?: string
    sources?: Array<{ title: string; url: string }>
    fileName?: string
    fileSize?: number
    agentName?: string
    agentId?: string
    agentStatus?: string
    attachedFiles?: ChatAttachment[]
  }
  audioUrl?: string
}

export interface ChatAttachment {
  id: string
  name: string
  size: number
  type: string
  analysis?: string
  content?: string
  status: 'uploading' | 'complete' | 'error'
}

export interface SwarmAgent {
  id: string
  name: string
  type: 'code-reviewer' | 'security-auditor' | 'test-engineer' | 'web-performance' | 'payment-agent' | 'custom'
  status: 'idle' | 'active' | 'processing' | 'error'
  lastAction?: string
  description: string
  capabilities: string[]
}

export interface JarvisState {
  // Connection
  isConnected: boolean
  isConnecting: boolean
  error: string | null

  // Voice
  isListening: boolean
  isSpeaking: boolean
  audioLevel: number

  // Chat
  messages: Message[]
  isProcessing: boolean
  voiceMode: boolean // auto-speak JARVIS responses
  chatAttachments: ChatAttachment[] // files attached to current chat input
  activeChatAgents: string[] // agent IDs participating in chat

  // Swarm
  swarmAgents: SwarmAgent[]
  swarmConnected: boolean

  // Security
  isAuthenticated: boolean
  encryptionEnabled: boolean

  // Active tab
  activeTab: 'chat' | 'voice' | 'swarm' | 'files'

  // Actions
  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setError: (error: string | null) => void
  setListening: (listening: boolean) => void
  setSpeaking: (speaking: boolean) => void
  setAudioLevel: (level: number) => void
  addMessage: (message: Message) => void
  clearMessages: () => void
  setProcessing: (processing: boolean) => void
  setVoiceMode: (enabled: boolean) => void
  addChatAttachment: (attachment: ChatAttachment) => void
  updateChatAttachment: (id: string, updates: Partial<ChatAttachment>) => void
  removeChatAttachment: (id: string) => void
  clearChatAttachments: () => void
  toggleChatAgent: (agentId: string) => void
  setActiveChatAgents: (agents: string[]) => void
  setSwarmAgents: (agents: SwarmAgent[]) => void
  updateSwarmAgent: (id: string, updates: Partial<SwarmAgent>) => void
  setSwarmConnected: (connected: boolean) => void
  setAuthenticated: (auth: boolean) => void
  setEncryptionEnabled: (enabled: boolean) => void
  setActiveTab: (tab: 'chat' | 'voice' | 'swarm' | 'files') => void
}

export const useJarvisStore = create<JarvisState>((set) => ({
  isConnected: false,
  isConnecting: false,
  error: null,
  isListening: false,
  isSpeaking: false,
  audioLevel: 0,
  messages: [],
  isProcessing: false,
  voiceMode: false,
  chatAttachments: [],
  activeChatAgents: [],
  swarmAgents: [
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      type: 'code-reviewer',
      status: 'idle',
      description: 'Analyzes code quality, patterns, and best practices',
      capabilities: ['Code Review', 'Pattern Analysis', 'Best Practices'],
    },
    {
      id: 'security-auditor',
      name: 'Security Auditor',
      type: 'security-auditor',
      status: 'idle',
      description: 'Scans for vulnerabilities and security issues',
      capabilities: ['Vulnerability Scan', 'Security Audit', 'Threat Analysis'],
    },
    {
      id: 'test-engineer',
      name: 'Test Engineer',
      type: 'test-engineer',
      status: 'idle',
      description: 'Generates and validates test cases',
      capabilities: ['Test Generation', 'Coverage Analysis', 'Regression Testing'],
    },
    {
      id: 'web-perf',
      name: 'Web Performance',
      type: 'web-performance',
      status: 'idle',
      description: 'Monitors and optimizes web performance',
      capabilities: ['Performance Audit', 'Lighthouse Analysis', 'Optimization'],
    },
    {
      id: 'payment-agent',
      name: 'Payment Processing',
      type: 'payment-agent',
      status: 'idle',
      description: 'Processes payments, generates POs, invoices, and receipts',
      capabilities: ['Payment Processing', 'PO Generation', 'Invoice & Receipts'],
    },
    {
      id: 'custom-agent',
      name: 'Custom Operations',
      type: 'custom',
      status: 'idle',
      description: 'Handles custom operations, automation, and cross-domain tasks',
      capabilities: ['Operations Automation', 'Shipment Tracking', 'Document Gen'],
    },
  ],
  swarmConnected: false,
  isAuthenticated: false,
  encryptionEnabled: true,
  activeTab: 'chat',

  setConnected: (connected) => set({ isConnected: connected }),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setError: (error) => set({ error }),
  setListening: (listening) => set({ isListening: listening }),
  setSpeaking: (speaking) => set({ isSpeaking: speaking }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  clearMessages: () => set({ messages: [] }),
  setProcessing: (processing) => set({ isProcessing: processing }),
  setVoiceMode: (enabled) => set({ voiceMode: enabled }),
  addChatAttachment: (attachment) =>
    set((state) => ({ chatAttachments: [...state.chatAttachments, attachment] })),
  updateChatAttachment: (id, updates) =>
    set((state) => ({
      chatAttachments: state.chatAttachments.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),
  removeChatAttachment: (id) =>
    set((state) => ({ chatAttachments: state.chatAttachments.filter((a) => a.id !== id) })),
  clearChatAttachments: () => set({ chatAttachments: [] }),
  toggleChatAgent: (agentId) =>
    set((state) => ({
      activeChatAgents: state.activeChatAgents.includes(agentId)
        ? state.activeChatAgents.filter((id) => id !== agentId)
        : [...state.activeChatAgents, agentId],
    })),
  setActiveChatAgents: (agents) => set({ activeChatAgents: agents }),
  setSwarmAgents: (agents) => set({ swarmAgents: agents }),
  updateSwarmAgent: (id, updates) =>
    set((state) => ({
      swarmAgents: state.swarmAgents.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),
  setSwarmConnected: (connected) => set({ swarmConnected: connected }),
  setAuthenticated: (auth) => set({ isAuthenticated: auth }),
  setEncryptionEnabled: (enabled) => set({ encryptionEnabled: enabled }),
  setActiveTab: (tab) => set({ activeTab: tab }),
}))
