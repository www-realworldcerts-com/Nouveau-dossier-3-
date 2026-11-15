import fs from 'fs'
import path from 'path'
import { IntelligentMissionConsolidator } from '../src/swarm/mission-consolidator.mjs'
import { writeSanitizedJson, writeSanitizedText } from '../src/security/export-sanitizer.mjs'

function parseCsvLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"' && line[i + 1] === '"') {
      current += '"'
      i++
      continue
    }
    if (c === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (c === ',' && !inQuotes) {
      result.push(current)
      current = ''
      continue
    }
    current += c
  }
  result.push(current)
  return result
}

function readCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0)
  const header = parseCsvLine(lines[0]).map(h => h.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const obj = {}
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = cols[j] ?? ''
    }
    rows.push(obj)
  }
  return rows
}

function normalizeMission(row) {
  return {
    title: row.title || '',
    type: row.type || '',
    priority: row.priority || '',
    status: row.status || '',
    assigned_agent_ids: row.assigned_agent_ids || '[]',
    mission_parameters: row.mission_parameters || '{}',
    progress_data: row.progress_data || '{}',
    estimated_duration_hours: row.estimated_duration_hours || '',
    actual_duration_hours: row.actual_duration_hours || '',
    deadline: row.deadline || '',
    completion_notes: row.completion_notes || '',
    revenue_generated: row.revenue_generated || '0',
    id: row.id || `mission_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }
}

function rankPriority(p) {
  const s = String(p || '').toLowerCase()
  if (s.includes('high')) return 3
  if (s.includes('medium')) return 2
  if (s.includes('low')) return 1
  return 0
}

function toSchedule(consolidated) {
  const items = consolidated.map(c => ({
    id: c.id,
    title: c.title,
    priority: c.priority || '',
    est_hours: parseFloat(c.estimated_duration_hours || '0') || 0,
    action: 'execute_consolidated',
    agents_count: JSON.parse(c.assigned_agent_ids || '[]').length
  }))
  items.sort((a, b) => {
    const pr = rankPriority(b.priority) - rankPriority(a.priority)
    if (pr !== 0) return pr
    return a.est_hours - b.est_hours
  })
  return items
}

function writeOutputs(baseName, report, consolidatedMissions, scheduleItems) {
  const outDir = path.join('exports', 'missions')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const ts = Date.now()
  const reportPath = path.join(outDir, `consolidation_report_${baseName}_${ts}.json`)
  const missionsPath = path.join(outDir, `consolidated_missions_${baseName}_${ts}.json`)
  const planPath = path.join(outDir, `master_agent_plan_${baseName}_${ts}.json`)
  const scheduleCsv = path.join(outDir, `master_agent_schedule_${baseName}_${ts}.csv`)

  writeSanitizedJson(reportPath, report)
  writeSanitizedJson(missionsPath, consolidatedMissions)

  const plan = {
    generated_at: new Date().toISOString(),
    phases: [
      { name: 'High Priority', filter: 'priority=high', concurrency: 3 },
      { name: 'Medium Priority', filter: 'priority=medium', concurrency: 2 },
      { name: 'Low Priority', filter: 'priority=low', concurrency: 1 }
    ],
    items: scheduleItems
  }
  writeSanitizedJson(planPath, plan)

  const header = ['id', 'title', 'priority', 'est_hours', 'action', 'agents_count']
  const lines = [header.join(',')]
  for (const it of scheduleItems) {
    lines.push([it.id, it.title.replace(/,/g, ' '), it.priority, String(it.est_hours), it.action, String(it.agents_count)].join(','))
  }
  writeSanitizedText(scheduleCsv, `${lines.join('\n')}\n`)

  return { reportPath, missionsPath, planPath, scheduleCsv }
}

function main() {
  const arg = process.argv.find(a => a.startsWith('--csv='))
  const csvPath = arg ? arg.split('=')[1] : 'Mission_export (72).csv'
  if (!fs.existsSync(csvPath)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'csv_not_found', path: csvPath }) + '\n')
    process.exit(2)
  }
  const rows = readCsv(csvPath)
  const missions = rows.map(normalizeMission)
  const consolidator = new IntelligentMissionConsolidator(missions)
  const report = consolidator.generateConsolidationReport()
  const consolidatedMissions = report.clusters.map(c => c.consolidated_mission)
  const scheduleItems = toSchedule(consolidatedMissions)
  const baseName = path.basename(csvPath).replace(/\.[^/.]+$/, '').replace(/\s+/g, '_')
  const outputs = writeOutputs(baseName, report, consolidatedMissions, scheduleItems)
  process.stdout.write(JSON.stringify({ ok: true, outputs }) + '\n')
}

main()
