import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LOG_DIR = path.resolve(__dirname, '../../../logs');

function fulfillmentLogPath() {
    const configured = String(process.env.FULFILLMENT_QUEUE_FILE || '').trim();
    const file = configured ? path.resolve(configured) : path.join(DEFAULT_LOG_DIR, 'fulfillment_queue.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
}

export class FulfillmentManager {
    static async fulfillOrder(order) {
        console.log(`📦 FULFILLMENT: Processing order for ${order.id}...`);

        const product = order.product || 'Unknown Product';
        const customerEmail = order.customer_email || 'UNKNOWN';
        const status = order.status || 'PENDING_DELIVERY';

        const entry = {
            timestamp: new Date().toISOString(),
            order_id: order.id,
            product: product,
            // The capture id is the only key that ties a queued order back to
            // the revenue ledger, so a refund or chargeback can be matched to
            // the delivery it was paid for by the resilience audit.
            capture_id: order.capture_id || null,
            product_id: order.product_id || null,
            customer_email: customerEmail,
            amount: order.revenue,
            currency: order.currency || 'USD',
            status,
            action_required: order.action_required !== undefined
                ? order.action_required
                : `Send '${product}' to ${customerEmail}`,
            access_url: order.access_url || null,
            access_pass: order.access_pass || null,
            funding: order.funding || null,
            email: order.email || null
        };

        const logFile = fulfillmentLogPath();
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

        console.log(`✅ FULFILLMENT QUEUED: Saved to ${logFile}`);
        return { status: 'QUEUED', timestamp: entry.timestamp, file: logFile };
    }
}
