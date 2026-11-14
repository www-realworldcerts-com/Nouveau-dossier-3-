
import fs from 'fs';
import path from 'path';

export class FlightRecorder {
  constructor(options = {}) {
    this.maxLogs = options.maxLogs || 1000;
    this.logBuffer = [];
    this.dumpDir = options.dumpDir || path.join(process.cwd(), 'logs', 'dumps');
    this.startTime = new Date().toISOString();
  }

  log(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta,
      pid: process.pid
    };

    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogs) {
      this.logBuffer.shift();
    }
    
    // Also output to console for now, but structured
    if (level === 'ERROR' || level === 'FATAL') {
        console.error(`[${entry.timestamp}] [${level}] ${message}`, meta);
    } else {
        console.log(`[${entry.timestamp}] [${level}] ${message}`);
    }
  }

  info(message, meta) { this.log('INFO', message, meta); }
  warn(message, meta) { this.log('WARN', message, meta); }
  error(message, meta) { this.log('ERROR', message, meta); }
  fatal(message, meta) { this.log('FATAL', message, meta); }

  recordDecision(context, rationale, outcome) {
    this.info(`DECISION: ${context}`, { rationale, outcome });
  }

  dump(reason = 'manual_trigger') {
    const dumpId = `crash_dump_${Date.now()}_${process.pid}`;
    const dumpPath = path.join(this.dumpDir, `${dumpId}.json`);
    
    const dumpData = {
      dumpId,
      reason,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      logs: this.logBuffer
    };

    try {
      fs.mkdirSync(this.dumpDir, { recursive: true });
      fs.writeFileSync(dumpPath, JSON.stringify(dumpData, null, 2));
      console.error(`🔥 FLIGHT RECORDER DUMP SAVED: ${dumpPath}`);
      return dumpPath;
    } catch (err) {
      console.error('Failed to write flight recorder dump:', err);
      return null;
    }
  }
  
  async wrap(fn) {
      try {
          return await fn();
      } catch (err) {
          this.fatal('Uncaught exception in wrapped function', { error: err.message, stack: err.stack });
          this.dump('uncaught_exception');
          throw err;
      }
  }
}

export const globalRecorder = new FlightRecorder();
