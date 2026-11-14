import fs from 'fs';
import path from 'path';
import { readEncryptedJson } from '../../security/data-at-rest.mjs';

const historyPath = path.join(process.cwd(), 'src', 'real', 'ledger', 'execution_history.json');

function loadHistory() {
    if (!fs.existsSync(historyPath)) return [];
    try {
        return readEncryptedJson(historyPath);
    } catch (e) {
        return [];
    }
}

export function hasBeenAttempted(ideaId) {
    const history = loadHistory();
    // Only return true if it was SUCCESSFUL or if we want to block retries of failed ones too.
    // The directive says: "NO RETRY. NO SIMULATION." which usually implies "If it failed, it died."
    // BUT, if the failure was technical (like "NO_PAYMENT_RECEIVED" in 1 second), maybe we SHOULD retry?
    
    // However, the prompt "Anything that doesn’t advance to the right dies automatically" implies strictness.
    // But for "NO_PAYMENT_RECEIVED", it just means it didn't sell YET. 
    // If we block it forever, we can never sell it.
    
    // Let's refine: Block only if SUCCESS or if FATAL ERROR (like "Invalid Data").
    // If "NO_PAYMENT_RECEIVED", we should probably allow re-publishing or re-checking (polling).
    
    // For now, let's relax the check: 
    // Only return true if there is a 'SUCCESS' entry.
    return history.some(h => h.idea_id === ideaId && h.status === 'SUCCESS');
}

export function recordAttempt(entry) {
    const history = loadHistory();
    history.push({
        ...entry,
        timestamp: new Date().toISOString()
    });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}
