import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only PO store: every mutation writes a full snapshot plus an event, so
 * a PO's whole history is recoverable and a crash cannot lose a delivery record.
 */
export class ProcurementStore {
    constructor({ dir = process.env.PROCUREMENT_DATA_DIR || 'data/procurement' } = {}) {
        this.dir = path.resolve(dir);
        this.posFile = path.join(this.dir, 'pos.ndjson');
        this.eventsFile = path.join(this.dir, 'events.ndjson');
        fs.mkdirSync(this.dir, { recursive: true });
    }

    readNdjson(file) {
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }

    /** Latest snapshot per PO reference. */
    listPos() {
        const latest = new Map();
        for (const row of this.readNdjson(this.posFile)) {
            if (row?.po_ref) latest.set(row.po_ref, row);
        }
        return [...latest.values()].sort((a, b) => String(a.po_ref).localeCompare(String(b.po_ref)));
    }

    find(poRef) {
        return this.listPos().find(po => po.po_ref === poRef) || null;
    }

    save(po) {
        fs.appendFileSync(this.posFile, JSON.stringify(po) + '\n');
        return po;
    }

    appendEvent(event) {
        fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n');
        return event;
    }

    events(poRef) {
        return this.readNdjson(this.eventsFile).filter(event => event.po_ref === poRef);
    }
}

export default ProcurementStore;
