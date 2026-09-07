# Audit L2 — PayPal REST History gap (2026‑08‑26 → 2026‑08‑28)

Ce fichier a été ajouté automatiquement par l'audit L2 effectué sur l'organisation www-realworldcerts-com.

Résumé exécutif

- Incident PayPal : "REST History unavailable for 8/26/26–8/28/26" — PayPal a signalé un incident interne. Les bodies de réponse REST/webhook de cette fenêtre n'ont pas été persistés côté PayPal et sont irrécupérables.
- Impact : preuves manquantes pour la réconciliation automatique (webhook bodies). Nécessité de reconstituer preuves via exports API/CSV, offline-store et relevés bancaires.
- Action prise : analyse des sources du repo (public + privé accessible) et production de ce playbook + checklist. Aucune opération d'envoi d'argent n'a été exécutée.

Fichiers / modules inspectés (extraits pertinents)

- Nouveau-dossier-3-/src/paypal-api.mjs
- Nouveau-dossier-3-/src/paypal-event-mapper.mjs
- Nouveau-dossier-3-/src/create-paypal-order.mjs
- Nouveau-dossier-3-/scripts/recover-paypal-payouts.mjs
- realworld.nosim/scripts/payout-paypal-once.mjs
- realworld.nosim/src/sync-paypal-payout-batch.mjs
- realworld.nosim/docs/ATTIJARI_PAYPAL_PORTAL.md
- realworld.nosim/REPORT.txt, changelog_report.txt

Constatations clefs

1. Kill‑switches et protections
   - SWARM_LIVE, BASE44_* flags, PAYPAL_MODE sont utilisés pour empêcher les envois live involontaires.
   - Les scripts de recovery sont en DRY‑RUN par défaut (RECOVERY_FORCE_EXECUTE=false).

2. Réconciliation
   - Le système synchronise les batches PayPal via l'API (sync-paypal-payout-batch.mjs) et peut reconstituer l'état d'un batch si on obtient le batch_id.
   - Pour 2026‑08‑26→28, PayPal n'a pas stocké les bodies ; il faudra utiliser les exports CSV/API (Transactions / Payouts) + offline ledger pour fournir la preuve.

3. L2 / rails alternatifs
   - Crypto rail / fallback présent (bank → payoneer → crypto → paypal). Vérifier idempotence et frais avant bascule.

Risques prioritaires

- Preuves manquantes pour 2026‑08‑26→28 : risque légal/comptable si non‑documenté.
- Risque d'exécution live : faible grâce aux garde‑fous, mais vérifier variables d'environnement avant toute opération.
- Point de concentration (allowlist hardcodée) : si corrompue, destination des fonds immuable.

Checklist d'intervention (lecture seule — non destructive)

- [ ] Ne pas activer SWARM_LIVE ni RECOVERY_FORCE_EXECUTE tant que non validé.
- [ ] Snapshot des stores locaux :
      mkdir -p exports/recon && cp .autonomous-offline-store.json exports/recon/ || true
      tar czf exports/recon/settlements_paypal_$(date +%s).tgz settlements/paypal || true
- [ ] Récupérer et stocker les artifacts GitHub Actions (swarm-tick) autour de 2026‑08‑26→28.
- [ ] Depuis PayPal Merchant Dashboard : télécharger Transactions & Payouts CSV pour 2026‑08‑26→28.
- [ ] Pour chaque payout batch suspect :
      node src/sync-paypal-payout-batch.mjs --batchId <BATCH_ID>    (dry‑run)
      node scripts/recover-paypal-payouts.mjs <BATCH_ID>           (dry‑run par défaut)
- [ ] Reconstituer preuves manquantes : créer un PDF/TXT par transaction avec date, batch_id, montant, destinataire, capture id si disponible, extrait CSV PayPal, extrait ledger offline.
- [ ] Préparer contact PayPal Support (ID de l'incident + liste des batch_ids manquants) et demander attestation officielle.
- [ ] Documenter toute action corrective dans une issue et dans le dossier exports/recon/ (traçabilité).

Commandes utiles (exemples)

# Sauvegardes locales
mkdir -p exports/recon
cp .autonomous-offline-store.json exports/recon/. || true
tar czf exports/recon/settlements_paypal_$(date +%s).tgz settlements/paypal || true

# Vérifier token PayPal (dry)
node --input-type=module -e "import('./src/paypal-api.mjs').then(m=>m.getPayPalAccessToken().then(()=>console.log('TOKEN_OK')).catch(e=>console.error('TOKEN_FAIL',e.message))).catch(e=>console.error(e))"

# Sync batch (dry-run)
node src/sync-paypal-payout-batch.mjs --batchId BATCH_ID

# Recover (dry-run; to execute set RECOVERY_FORCE_EXECUTE=true and SWARM_LIVE=true after manual validation)
node scripts/recover-paypal-payouts.mjs BATCH_ID

Artifacts / emplacement de sortie

- exports/recon/ (ce dossier -à créer manuellement via commandes ci‑dessus-). Ce commit ajoute ce fichier de rapport; il ne contient pas encore les snapshots binaires.

Notes finales

- J'ai préparé ce rapport et je n'ai exécuté aucune opération de paiement. Pour aller plus loin je peux :
  • collecter automatiquement les artifacts (ex: exécuter les commandes ci‑dessus depuis un runner sécurisé) et les pousser vers exports/recon/ (requiert autorisation d'écriture) ;
  • ouvrir une issue (je vais en créer une ci‑dessous) ;
  • préparer le mail à PayPal Support.

Report created by: Audit L2 assistant
Date: 2026-09-07
