import fs from 'fs'
import path from 'path'
import { SwarmOrchestrator } from '../src/orchestration/SwarmOrchestrator.mjs'
import { writeSanitizedJson } from '../src/security/export-sanitizer.mjs'

class MasterAgent {
  async execute(task) {
    const mission = task.payload || {}
    const outDir = path.join('exports', 'missions', 'executions')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, `execution_${mission.id || 'unknown'}_${Date.now()}.json`)
    const payload = {
      mission_id: mission.id || null,
      title: mission.title || '',
      started_at: new Date().toISOString(),
      agent: 'MASTER_AGENT',
      status: 'submitted'
    }
    writeSanitizedJson(file, payload)
    return { ok: true, file }
  }
}

function latestFileByPrefix(dir, prefix) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix))
  if (files.length === 0) return null
  const withTimes = files.map(f => {
    const fp = path.join(dir, f)
    const st = fs.statSync(fp)
    return { file: fp, mtime: st.mtimeMs }
  })
  withTimes.sort((a, b) => b.mtime - a.mtime)
  return withTimes[0].file
}

function loadJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'))
}

function parsePriorityFilter(s) {
  const m = String(s || '').match(/priority=(\w+)/i)
  return m ? m[1].toLowerCase() : null
}

async function runPhase(swarm, items, missionsMap, concurrency) {
  const results = []
  let index = 0
  const workers = Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (index < items.length) {
      const i = index++
      const it = items[i]
      const mission = missionsMap.get(it.id) || null
      const task = {
        type: 'EXECUTE_CONSOLIDATED',
        requiredCapabilities: ['CONSOLIDATED_EXECUTION'],
        resourceKey: 'MASTER_AGENT',
        payload: mission
      }
      try {
        const res = await swarm.executeTask(task)
        results.push({ id: it.id, status: res.status, agentId: res.agentId || null })
      } catch (e) {
        results.push({ id: it.id, status: 'FAILED', error: e.message })
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  const outDir = path.join('exports', 'missions')
  const planPath = latestFileByPrefix(outDir, 'master_agent_plan_')
  const missionsPath = latestFileByPrefix(outDir, 'consolidated_missions_')
  if (!planPath || !missionsPath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_outputs' }) + '\n')
    process.exit(2)
  }
  const plan = loadJson(planPath)
  const missions = loadJson(missionsPath)
  const missionsMap = new Map()
  for (const m of missions) missionsMap.set(m.id, m)

  const swarm = new SwarmOrchestrator()
  await swarm.start()
  const agent = new MasterAgent()
  swarm.registerAgent('MASTER_AGENT', agent, ['CONSOLIDATED_EXECUTION'])

  const allResults = []
  for (const phase of plan.phases) {
    const p = parsePriorityFilter(phase.filter)
    const items = plan.items.filter(it => String(it.priority || '').toLowerCase() === p)
    const res = await runPhase(swarm, items, missionsMap, phase.concurrency || 1)
    allResults.push({ phase: phase.name, count: res.length })
  }

  const runOutDir = path.join('exports', 'missions', 'executions')
  if (!fs.existsSync(runOutDir)) fs.mkdirSync(runOutDir, { recursive: true })
  const summaryFile = path.join(runOutDir, `master_agent_run_${Date.now()}.json`)
  writeSanitizedJson(summaryFile, {
    ok: true,
    planPath,
    missionsPath,
    phases: allResults,
    finished_at: new Date().toISOString()
  })

  process.stdout.write(JSON.stringify({ ok: true, run_summary: summaryFile }) + '\n')
}

main()
