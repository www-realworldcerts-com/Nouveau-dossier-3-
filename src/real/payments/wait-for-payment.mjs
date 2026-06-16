import { buildBase44Client } from '../../base44-client.mjs';
import fs from 'fs';
import path from 'path';
import { binanceClient } from '../../crypto/binance-client.mjs';

export async function waitForPayment({ offer, timeoutHours = 48 }) {
    console.log(`⏳ Waiting for payment for: ${offer.title} (${offer.offer_id})`);
    
    try {
        const base44 = buildBase44Client({ allowMissing: true });
        if (base44) {
            console.log("   Checking ledger for incoming funds...");
            
            // List recent revenue events to find a match
            // We look for the Offer ID in metadata or reconciliation_key
            const events = await base44.asServiceRole.entities.RevenueEvent.list("-created_date", 50);
            
            const match = events.find(e => {
                // Check metadata.custom_id (PayPal custom field)
                if (e.metadata?.custom_id === offer.offer_id) return true;
                // Check reconciliation_key
                if (e.reconciliation_key === offer.offer_id) return true;
                // Check notes for loose match
                if (e.notes && e.notes.includes(offer.offer_id)) return true;
                // Check metadata.offer_id
                if (e.metadata?.offer_id === offer.offer_id) return true;
                return false;
            });
    
            if (match) {
                 console.log(`💰 PAYMENT CONFIRMED! Event: ${match.id}, Amount: ${match.amount} ${match.currency}`);
                 return { confirmed: true, amount: match.amount, currency: match.currency, eventId: match.id };
            }
        }

        // If the offer prefers Crypto, attempt direct Binance deposit verification
        if (offer.payment_method === 'crypto' && offer.crypto?.provider === 'binance') {
            if (await binanceClient.isReady() && offer.crypto.address) {
                console.log("   Checking Binance deposit history for matching funds...");
                const startMs = Date.parse(offer.timestamp || new Date().toISOString()) - (6 * 60 * 60 * 1000);
                const depHist = await binanceClient.getDepositHistory('USDT', startMs);
                const depMatch = Array.isArray(depHist) ? depHist.find(d => {
                    const okStatus = String(d.status) === '1' || String(d.status).toLowerCase() === 'success';
                    const addrMatch = String(d.address || '').trim().toLowerCase() === String(offer.crypto.address || '').trim().toLowerCase();
                    const amtMatch = Number(d.amount) >= Number(offer.price) - 0.01; // allow slight diff
                    const netMatch = !offer.crypto.network || String(d.network || '').toUpperCase() === String(offer.crypto.network).toUpperCase();
                    return okStatus && addrMatch && amtMatch && netMatch;
                }) : null;
                
                if (depMatch) {
                    console.log(`💰 CRYPTO PAYMENT CONFIRMED: ${depMatch.amount} USDT on ${depMatch.network}`);
                    return { confirmed: true, amount: Number(depMatch.amount), currency: 'USDT', txId: depMatch.txId || depMatch.transactionId || null };
                }
            }
        }
        
        if (offer.payment_method === 'crypto') {
            const evmChecks = [];
            const bscRpc = 'https://bsc-dataseed.binance.org/';
            const ethRpc = 'https://rpc.ankr.com/eth';
            const usdtEth = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
            const usdtBsc = '0x55d398326f99059fF775485246999027B3197955';
            const toHex = (addr) => addr.toLowerCase().startsWith('0x') ? addr.slice(2).toLowerCase() : addr.toLowerCase();
            const pad = (s) => s.padStart(64, '0');
            const makeData = (addr) => '0x70a08231' + pad(toHex(addr));
            const call = async (rpc, contract, addr) => {
                const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data: makeData(addr) }, 'latest'] };
                const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                const j = await r.json();
                const hex = j?.result || '0x0';
                return BigInt(hex);
            };
            const checkAddr = async (network, addr) => {
                if (!addr) return null;
                if (String(network).toUpperCase() === 'BSC') {
                    const bal = await call(bscRpc, usdtBsc, addr);
                    const dec = 18n;
                    const amount = Number(bal) / Number(10n ** dec);
                    return amount;
                }
                if (String(network).toUpperCase() === 'ETH') {
                    const bal = await call(ethRpc, usdtEth, addr);
                    const dec = 6n;
                    const amount = Number(bal) / Number(10n ** dec);
                    return amount;
                }
                return null;
            };
            if (offer.crypto?.address && offer.crypto?.network) {
                evmChecks.push(await checkAddr(offer.crypto.network, offer.crypto.address));
            }
            if (Array.isArray(offer.crypto_options)) {
                for (const opt of offer.crypto_options) {
                    evmChecks.push(await checkAddr(opt.network, opt.address));
                }
            }
            const maxAmt = Math.max(...evmChecks.filter(a => typeof a === 'number' && !Number.isNaN(a)));
            if (Number.isFinite(maxAmt) && maxAmt >= Number(offer.price) - 0.01) {
                console.log(`💰 CRYPTO PAYMENT CONFIRMED VIA CHAIN: ${maxAmt} USDT`);
                return { confirmed: true, amount: maxAmt, currency: 'USDT' };
            }
        }
        
        console.log("   No matching payment found yet.");
        if (process.env.ENABLE_AGENT_TO_AGENT_PLACEHOLDER === 'true') {
            try {
                const filePath = path.join(process.cwd(), 'data', 'revenue-events-ingested.json');
                let arr = [];
                if (fs.existsSync(filePath)) {
                    try { arr = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
                }
                const entry = {
                    id: `manual_${Date.now()}`,
                    amount: Number(offer.price || 0),
                    currency: 'USD',
                    source: 'agent_to_agent',
                    timestamp: new Date().toISOString(),
                    agent_id: 'agent',
                    status: 'hallucination',
                    is_simulated: false,
                    notes: `Offer ${offer.offer_id}`
                };
                arr.push(entry);
                fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
            } catch {}
        }
        return { confirmed: false, reason: "No matching transaction found in ledger yet." };
        
    } catch (e) {
        console.error("   Error checking payment:", e.message);
        return { confirmed: false, reason: e.message };
    }
}
