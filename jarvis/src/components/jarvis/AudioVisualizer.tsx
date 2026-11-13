'use client'

import { useEffect, useRef, useMemo } from 'react'

interface AudioVisualizerProps {
  audioLevel: number
  isActive: boolean
  isSpeaking: boolean
  isListening: boolean
  size?: number
}

export default function AudioVisualizer({
  audioLevel,
  isActive,
  isSpeaking,
  isListening,
  size = 200,
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number>(0)
  const timeRef = useRef<number>(0)

  const barCount = 36
  const maxBarLength = size * 0.15

  // Simulated audio bars for when active
  const simulatedBars = useRef<number[]>(Array(barCount).fill(0))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const centerX = size / 2
    const centerY = size / 2
    const baseRadius = size * 0.2

    const draw = () => {
      timeRef.current += 0.02
      ctx.clearRect(0, 0, size, size)

      // Update simulated bars
      for (let i = 0; i < barCount; i++) {
        if (isListening || isSpeaking) {
          const target =
            audioLevel *
            maxBarLength *
            (0.5 +
              0.5 *
                Math.sin(timeRef.current * 3 + i * 0.5) *
                Math.cos(timeRef.current * 2 + i * 0.3))
          simulatedBars.current[i] += (target - simulatedBars.current[i]) * 0.3
        } else {
          simulatedBars.current[i] *= 0.9
        }
      }

      // Draw outer rotating ring
      ctx.save()
      ctx.translate(centerX, centerY)
      ctx.rotate(timeRef.current * 0.5)
      const ringRadius = baseRadius + maxBarLength + 20
      ctx.beginPath()
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 0.3)
      ctx.strokeStyle = isSpeaking
        ? 'rgba(6, 182, 212, 0.6)'
        : 'rgba(6, 182, 212, 0.2)'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(0, 0, ringRadius, Math.PI, Math.PI * 1.3)
      ctx.strokeStyle = isSpeaking
        ? 'rgba(6, 182, 212, 0.6)'
        : 'rgba(6, 182, 212, 0.2)'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()

      // Draw second rotating ring (opposite direction)
      ctx.save()
      ctx.translate(centerX, centerY)
      ctx.rotate(-timeRef.current * 0.3)
      const ring2Radius = baseRadius + maxBarLength + 32
      ctx.beginPath()
      ctx.arc(0, 0, ring2Radius, Math.PI * 0.5, Math.PI * 0.9)
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(0, 0, ring2Radius, Math.PI * 1.5, Math.PI * 1.9)
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()

      // Draw audio bars radiating outward
      if (isActive || isListening || isSpeaking) {
        for (let i = 0; i < barCount; i++) {
          const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2
          const barLength = Math.max(2, simulatedBars.current[i])

          const x1 = centerX + Math.cos(angle) * (baseRadius + 8)
          const y1 = centerY + Math.sin(angle) * (baseRadius + 8)
          const x2 = centerX + Math.cos(angle) * (baseRadius + 8 + barLength)
          const y2 = centerY + Math.sin(angle) * (baseRadius + 8 + barLength)

          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)

          const alpha = isSpeaking
            ? 0.7 + 0.3 * Math.sin(timeRef.current * 4 + i)
            : 0.4 + 0.3 * (barLength / maxBarLength)

          ctx.strokeStyle = `rgba(6, 182, 212, ${alpha})`
          ctx.lineWidth = 3
          ctx.lineCap = 'round'
          ctx.stroke()
        }
      }

      // Draw concentric rings
      for (let r = 0; r < 3; r++) {
        const ringR = baseRadius - 8 - r * 10
        if (ringR < 5) continue

        const pulseOffset =
          r === 0
            ? Math.sin(timeRef.current * 2) * 2
            : r === 1
              ? Math.sin(timeRef.current * 1.5 + 1) * 2
              : Math.sin(timeRef.current * 1 + 2) * 1.5

        ctx.beginPath()
        ctx.arc(centerX, centerY, ringR + pulseOffset, 0, Math.PI * 2)

        const ringAlpha =
          r === 0
            ? 0.3
            : r === 1
              ? 0.15
              : 0.08

        ctx.strokeStyle = `rgba(6, 182, 212, ${ringAlpha})`
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // Draw central glow circle
      const pulseScale = isActive
        ? 1 + audioLevel * 0.15 + Math.sin(timeRef.current * 3) * 0.02
        : 1 + Math.sin(timeRef.current * 1.5) * 0.03

      const glowRadius = baseRadius * pulseScale

      // Outer glow
      if (isSpeaking) {
        const gradient = ctx.createRadialGradient(
          centerX,
          centerY,
          glowRadius * 0.5,
          centerX,
          centerY,
          glowRadius * 2
        )
        gradient.addColorStop(0, 'rgba(6, 182, 212, 0.15)')
        gradient.addColorStop(0.5, 'rgba(6, 182, 212, 0.05)')
        gradient.addColorStop(1, 'rgba(6, 182, 212, 0)')
        ctx.beginPath()
        ctx.arc(centerX, centerY, glowRadius * 2, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()
      }

      // Main circle
      const mainGradient = ctx.createRadialGradient(
        centerX,
        centerY,
        0,
        centerX,
        centerY,
        glowRadius
      )

      if (isSpeaking) {
        mainGradient.addColorStop(0, 'rgba(6, 182, 212, 0.4)')
        mainGradient.addColorStop(0.6, 'rgba(6, 182, 212, 0.2)')
        mainGradient.addColorStop(1, 'rgba(6, 182, 212, 0.05)')
      } else if (isListening) {
        mainGradient.addColorStop(0, 'rgba(6, 182, 212, 0.25)')
        mainGradient.addColorStop(0.6, 'rgba(6, 182, 212, 0.1)')
        mainGradient.addColorStop(1, 'rgba(6, 182, 212, 0.02)')
      } else {
        mainGradient.addColorStop(0, 'rgba(6, 182, 212, 0.12)')
        mainGradient.addColorStop(0.6, 'rgba(6, 182, 212, 0.06)')
        mainGradient.addColorStop(1, 'rgba(6, 182, 212, 0.01)')
      }

      ctx.beginPath()
      ctx.arc(centerX, centerY, glowRadius, 0, Math.PI * 2)
      ctx.fillStyle = mainGradient
      ctx.fill()

      // Circle border
      ctx.beginPath()
      ctx.arc(centerX, centerY, glowRadius, 0, Math.PI * 2)
      ctx.strokeStyle = isSpeaking
        ? 'rgba(6, 182, 212, 0.8)'
        : isListening
          ? 'rgba(6, 182, 212, 0.5)'
          : 'rgba(6, 182, 212, 0.25)'
      ctx.lineWidth = isSpeaking ? 2.5 : 1.5
      ctx.stroke()

      // Center dot
      ctx.beginPath()
      ctx.arc(centerX, centerY, 3, 0, Math.PI * 2)
      ctx.fillStyle = isSpeaking
        ? 'rgba(6, 182, 212, 1)'
        : 'rgba(6, 182, 212, 0.6)'
      ctx.fill()

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [size, audioLevel, isActive, isSpeaking, isListening, maxBarLength])

  const canvasStyle = useMemo(
    () => ({
      width: size,
      height: size,
    }),
    [size]
  )

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        className="rounded-full"
      />
      {/* Status label */}
      {(isListening || isSpeaking) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-mono tracking-widest text-[var(--jarvis)] uppercase opacity-80">
            {isListening ? 'Listening' : isSpeaking ? 'Speaking' : ''}
          </span>
        </div>
      )}
    </div>
  )
}
