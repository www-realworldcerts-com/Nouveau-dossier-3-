'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Clock, PackageSearch, RefreshCw, Scale } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface ContentieuxHold {
  code: string
  meaning?: string
}

interface ContentieuxCase {
  case_id: string
  po_ref: string
  supplier: string
  recipient: string | null
  amount_mad: number
  status: string
  waiting_days: number
  severity: 'high' | 'medium' | 'low'
  holds: ContentieuxHold[]
  next_action: string | null
  recommended: string | null
}

interface ContentieuxReport {
  available: boolean
  generated_at?: string | null
  totals?: { cases: number; amount_mad: number; high: number }
  cases?: ContentieuxCase[]
  message?: string
}

const severityColor: Record<string, string> = {
  high: 'border-red-500/30 text-red-400 bg-red-500/10',
  medium: 'border-amber-500/30 text-amber-400 bg-amber-500/10',
  low: 'border-sky-500/30 text-sky-400 bg-sky-500/10',
}

export default function ContentieuxPanel() {
  const [report, setReport] = useState<ContentieuxReport | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/jarvis/contentieux', { cache: 'no-store' })
      setReport(await res.json())
    } catch {
      setReport({ available: false, message: 'Contentieux report is unreachable.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const totals = report?.totals
  const cases = report?.cases || []

  return (
    <Card className="mb-4 bg-[var(--surface)] border-[var(--jarvis-dark)]/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Scale className="size-4 text-[var(--jarvis)]" />
            <CardTitle className="text-sm font-mono text-foreground">
              Procurement Contentieux
            </CardTitle>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={load}
            disabled={loading}
            className="h-7 text-[10px] font-mono border-[var(--jarvis-dark)]/30"
          >
            <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading && !report ? (
          <p className="text-xs font-mono text-muted-foreground">Loading cases...</p>
        ) : !report?.available ? (
          <p className="text-xs font-mono text-muted-foreground">
            {report?.message || 'No contentieux report available.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Badge variant="outline" className="text-[10px] font-mono">
                <PackageSearch className="size-3 mr-1" />
                {totals?.cases ?? 0} cases
              </Badge>
              <Badge variant="outline" className="text-[10px] font-mono">
                {(totals?.amount_mad ?? 0).toFixed(2)} MAD at stake
              </Badge>
              {(totals?.high ?? 0) > 0 && (
                <Badge variant="outline" className="text-[10px] font-mono border-red-500/30 text-red-400">
                  <AlertTriangle className="size-3 mr-1" />
                  {totals?.high} high
                </Badge>
              )}
              {report.generated_at && (
                <span className="text-[9px] font-mono text-muted-foreground/60">
                  audit {new Date(report.generated_at).toLocaleString()}
                </span>
              )}
            </div>

            {!cases.length ? (
              <p className="text-xs font-mono text-emerald-400">
                No open contentieux cases — every PO is within its delivery window.
              </p>
            ) : (
              <div className="space-y-2">
                {cases.map(item => (
                  <div
                    key={item.case_id}
                    className="rounded-md border border-[var(--jarvis-dark)]/20 bg-[var(--surface-light)]/20 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-[var(--jarvis)]">{item.case_id}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{item.po_ref}</span>
                      </div>
                      <Badge
                        variant="outline"
                        className={`text-[9px] font-mono uppercase ${severityColor[item.severity] || severityColor.low}`}
                      >
                        {item.severity} · {item.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-muted-foreground">
                      <span>{item.supplier}</span>
                      <span>{item.amount_mad.toFixed(2)} MAD</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {item.waiting_days}d waiting
                      </span>
                    </div>
                    {item.holds.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {item.holds.map(hold => (
                          <span
                            key={hold.code}
                            title={hold.meaning}
                            className="rounded border border-red-500/20 px-1 text-[9px] font-mono text-red-300/80"
                          >
                            {hold.code}
                          </span>
                        ))}
                      </div>
                    )}
                    {item.next_action && (
                      <p className="mt-1 text-[10px] font-mono text-muted-foreground/80">
                        Next: {item.next_action}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
