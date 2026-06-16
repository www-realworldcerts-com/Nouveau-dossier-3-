import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '../../../logs');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const FULFILLMENT_LOG = path.join(LOG_DIR, 'fulfillment_queue.log');

export class FulfillmentManager {
    static async fulfillOrder(order) {
        console.log(`📦 FULFILLMENT: Processing order for ${order.id}...`);

        // 1. Identify Product
        const product = order.product || 'Unknown Product';
        const customerEmail = order.customer_email || 'UNKNOWN';

        // 2. "Deliver" (Log to persistent queue for manual/async processing)
        // In a future upgrade, this would call SendGrid/Mailgun directly.
        // For now, writing to a file ensures the obligation is RECORDED and not lost.
        
        const entry = {
            timestamp: new Date().toISOString(),
            order_id: order.id,
            product: product,
            customer_email: customerEmail,
            amount: order.revenue,
            status: 'PENDING_DELIVERY', // Needs manual or daemon pickup
            action_required: `Send '${product}' to ${customerEmail}`
        };

        fs.appendFileSync(FULFILLMENT_LOG, JSON.stringify(entry) + '\n');

        console.log(`✅ FULFILLMENT QUEUED: Saved to ${FULFILLMENT_LOG}`);
        return { status: 'QUEUED', timestamp: entry.timestamp };
    }
}
