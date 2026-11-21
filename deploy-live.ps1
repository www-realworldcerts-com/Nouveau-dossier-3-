param(
  [Parameter(Position = 0)]
  [string]$Action = "readiness",

  [Parameter(Position = 1)]
  [string]$WebhookUrl = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root | Out-Null

$credsPath = Join-Path $root "CREDS.txt"
if (-not (Test-Path -LiteralPath $credsPath)) {
  throw "Missing CREDS.txt next to deploy-live.ps1"
}

$lines = Get-Content -LiteralPath $credsPath -ErrorAction Stop

function FirstMatch([string]$pattern) {
  foreach ($l in $lines) {
    if ($l -match $pattern) { return $Matches }
  }
  return $null
}

function GetCredValue([string]$name) {
  foreach ($l in $lines) {
    $t = $l.Trim()
    if (-not $t) { continue }
    if ($t -match ('^\s*\$env\s*:\s*' + [regex]::Escape($name) + '\s*=\s*(.+)$')) {
      $v = $Matches[1].Trim().Trim('"').Trim("'")
      if (-not $v) { continue }
      if ($v -match "^\s*<\s*YOUR_[A-Z0-9_]+\s*>\s*$") { return $null }
      if ($v -match "^\s*YOUR_[A-Z0-9_]+\s*$") { return $null }
      if ($v -match "^\s*(REPLACE_ME|CHANGEME|TODO)\s*$") { return $null }
      return $v
    }
    if ($t -match ("^" + [regex]::Escape($name) + "\s*[:=]\s*(.+)$")) {
      $v = $Matches[1].Trim().Trim('"').Trim("'")
      if (-not $v) { continue }
      if ($v -match "^\s*<\s*YOUR_[A-Z0-9_]+\s*>\s*$") { return $null }
      if ($v -match "^\s*YOUR_[A-Z0-9_]+\s*$") { return $null }
      if ($v -match "^\s*(REPLACE_ME|CHANGEME|TODO)\s*$") { return $null }
      return $v
    }
  }
  return $null
}

function ApplyEnvAssignmentsFromCreds() {
  foreach ($l in $lines) {
    $t = $l.Trim()
    if (-not $t) { continue }
    if ($t -match '^\s*\$env\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$') {
      $name = $Matches[1].Trim()
      $v = $Matches[2].Trim().Trim('"').Trim("'")
      if (-not $name) { continue }
      if (-not $v) { continue }
      if ($v -match "^\s*<\s*YOUR_[A-Z0-9_]+\s*>\s*$") { continue }
      if ($v -match "^\s*YOUR_[A-Z0-9_]+\s*$") { continue }
      if ($v -match "^\s*(REPLACE_ME|CHANGEME|TODO)\s*$") { continue }
      Set-Item -Path ("Env:" + $name) -Value $v
    }
  }
}

function NextNonEmptyAfter([string]$needle) {
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $needle) { $idx = $i; break }
  }
  if ($idx -lt 0) { return $null }
  for ($j = $idx + 1; $j -lt $lines.Count; $j++) {
    $v = $lines[$j].Trim()
    if ($v -and $v -ne "Disabled" -and ($v -notmatch "^[•]+$")) { return $v }
  }
  return $null
}

function Mask([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return "(missing)" }
  return "(set)"
}

function TryDetectPayPalWebhookId() {
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_ID)) { return $null }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_SECRET)) { return $null }

  $paypalModeRaw = $env:PAYPAL_MODE
  if ([string]::IsNullOrWhiteSpace($paypalModeRaw)) { $paypalModeRaw = "live" }
  $paypalMode = $paypalModeRaw.ToString().ToLowerInvariant()
  $base = $env:PAYPAL_API_BASE_URL
  if ([string]::IsNullOrWhiteSpace($base)) {
    if ($paypalMode -eq "sandbox") { 
      Write-Error "CRITICAL: SANDBOX MODE IS FORBIDDEN. STRICT LIVE MODE ENFORCED."
      exit 1 
    } else { 
      $base = "https://api-m.paypal.com" 
    }
  }

  try {
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($env:PAYPAL_CLIENT_ID):$($env:PAYPAL_CLIENT_SECRET)"))
    $tokenRes = Invoke-RestMethod -Method Post -Uri ($base.TrimEnd("/") + "/v1/oauth2/token") -Headers @{
      Authorization = ("Basic " + $basic)
      "Content-Type" = "application/x-www-form-urlencoded"
    } -Body "grant_type=client_credentials"
    $token = $tokenRes.access_token
    if ([string]::IsNullOrWhiteSpace($token)) { return $null }

    $hooksRes = Invoke-RestMethod -Method Get -Uri ($base.TrimEnd("/") + "/v1/notifications/webhooks") -Headers @{
      Authorization = ("Bearer " + $token)
    }

    $webhooks = $hooksRes.webhooks
    if (-not $webhooks) { return $null }

    foreach ($w in $webhooks) {
      if ($w.url -and ($w.url -match "/paypal/webhook/?$") -and $w.id) { return $w.id }
    }

    $publicBaseRaw = $env:PUBLIC_BASE_URL
    if ([string]::IsNullOrWhiteSpace($publicBaseRaw)) { $publicBaseRaw = $env:PUBLIC_WEBHOOK_BASE_URL }
    if ([string]::IsNullOrWhiteSpace($publicBaseRaw)) { $publicBaseRaw = "" }
    $publicBase = $publicBaseRaw.Trim()
    if (-not [string]::IsNullOrWhiteSpace($publicBase)) {
      $target = ($publicBase.TrimEnd("/") + "/paypal/webhook")
      foreach ($w in $webhooks) {
        if ($w.url -eq $target -and $w.id) { return $w.id }
      }
    }

    if ($webhooks.Count -eq 1 -and $webhooks[0].id) { return $webhooks[0].id }
    return $null
  } catch {
    return $null
  }
}

function ListPayPalWebhooks() {
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_ID)) { throw "Missing PAYPAL_CLIENT_ID" }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_SECRET)) { throw "Missing PAYPAL_CLIENT_SECRET" }

  $paypalModeRaw = $env:PAYPAL_MODE
  if ([string]::IsNullOrWhiteSpace($paypalModeRaw)) { $paypalModeRaw = "live" }
  $paypalMode = $paypalModeRaw.ToString().ToLowerInvariant()
  $base = $env:PAYPAL_API_BASE_URL
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = "https://api-m.paypal.com"
  }

  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($env:PAYPAL_CLIENT_ID):$($env:PAYPAL_CLIENT_SECRET)"))
  $tokenRes = Invoke-RestMethod -Method Post -Uri ($base.TrimEnd("/") + "/v1/oauth2/token") -Headers @{
    Authorization = ("Basic " + $basic)
    "Content-Type" = "application/x-www-form-urlencoded"
  } -Body "grant_type=client_credentials"
  $token = $tokenRes.access_token
  if ([string]::IsNullOrWhiteSpace($token)) { throw "PayPal token response missing access_token" }

  $hooksRes = Invoke-RestMethod -Method Get -Uri ($base.TrimEnd("/") + "/v1/notifications/webhooks") -Headers @{
    Authorization = ("Bearer " + $token)
  }

  $webhooks = $hooksRes.webhooks
  if (-not $webhooks) { return @() }
  return $webhooks | ForEach-Object {
    [pscustomobject]@{
      id = $_.id
      url = $_.url
      event_types = ($_.event_types | ForEach-Object { $_.name })
    }
  }
}

function SaveCredEnvVar([string]$name, [string]$value) {
  if ([string]::IsNullOrWhiteSpace($name)) { return }
  if ([string]::IsNullOrWhiteSpace($value)) { return }

  $newLine = ('$env:' + $name + '="' + $value + '"')
  $current = Get-Content -LiteralPath $credsPath -ErrorAction Stop

  $updated = $false
  for ($i = 0; $i -lt $current.Count; $i++) {
    if ($current[$i] -match ('^\s*\$env\s*:\s*' + [regex]::Escape($name) + '\s*=')) {
      $current[$i] = $newLine
      $updated = $true
      break
    }
    if ($current[$i] -match ("^\s*" + [regex]::Escape($name) + "\s*[:=]")) {
      $current[$i] = ($name + "=" + $value)
      $updated = $true
      break
    }
  }

  if (-not $updated) {
    $insertAt = 0
    while ($insertAt -lt $current.Count -and ($current[$insertAt] -match '^\s*\$env\s*:')) {
      $insertAt++
    }
    $before = @()
    if ($insertAt -gt 0) { $before = $current[0..($insertAt - 1)] }
    $after = $current[$insertAt..($current.Count - 1)]
    $current = @($before + @($newLine) + $after)
  }

  Set-Content -LiteralPath $credsPath -Value $current -Encoding utf8
}

function CreatePayPalWebhook([string]$url) {
  if ([string]::IsNullOrWhiteSpace($url)) { throw "Missing webhook url" }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_ID)) { throw "Missing PAYPAL_CLIENT_ID" }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_SECRET)) { throw "Missing PAYPAL_CLIENT_SECRET" }

  $paypalModeRaw = $env:PAYPAL_MODE
  if ([string]::IsNullOrWhiteSpace($paypalModeRaw)) { $paypalModeRaw = "live" }
  $paypalMode = $paypalModeRaw.ToString().ToLowerInvariant()
  $base = $env:PAYPAL_API_BASE_URL
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = "https://api-m.paypal.com"
  }

  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($env:PAYPAL_CLIENT_ID):$($env:PAYPAL_CLIENT_SECRET)"))
  $tokenRes = Invoke-RestMethod -Method Post -Uri ($base.TrimEnd("/") + "/v1/oauth2/token") -Headers @{
    Authorization = ("Basic " + $basic)
    "Content-Type" = "application/x-www-form-urlencoded"
  } -Body "grant_type=client_credentials"
  $token = $tokenRes.access_token
  if ([string]::IsNullOrWhiteSpace($token)) { throw "PayPal token response missing access_token" }

  $eventTypes = @(
    "PAYMENT.CAPTURE.COMPLETED",
    "CHECKOUT.ORDER.APPROVED",
    "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    "PAYMENT.PAYOUTS-ITEM.FAILED",
    "PAYMENT.PAYOUTS-ITEM.REFUNDED",
    "PAYMENT.PAYOUTS-ITEM.UNCLAIMED"
  ) | ForEach-Object { @{ name = $_ } }

  $body = @{
    url = $url
    event_types = $eventTypes
  } | ConvertTo-Json -Depth 6 -Compress

  return Invoke-RestMethod -Method Post -Uri ($base.TrimEnd("/") + "/v1/notifications/webhooks") -Headers @{
    Authorization = ("Bearer " + $token)
    "Content-Type" = "application/json"
  } -Body $body
}

function InvokeChecked([string]$label, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) {
    throw "$label failed (exit=$LASTEXITCODE)"
  }
}

$payoneerEmail = $null
foreach ($l in $lines) {
  if ($l -match "^Payoneer:(.+)$") { $payoneerEmail = $Matches[1].Trim(); break }
}

$paypalEmail = $null
foreach ($l in $lines) {
  if ($l -match "^paypal:(.+)$") { $paypalEmail = $Matches[1].Trim(); break }
}

ApplyEnvAssignmentsFromCreds

$paypalClientId = GetCredValue "PAYPAL_CLIENT_ID"
if (-not $paypalClientId) { $paypalClientId = NextNonEmptyAfter "Client ID" }
$paypalClientSecret = GetCredValue "PAYPAL_CLIENT_SECRET"
if (-not $paypalClientSecret) { $paypalClientSecret = NextNonEmptyAfter "Secret key 2" }

$swiftMatch = FirstMatch("^CODE SWIFT\s*:\s*(.+)$")
$bankSwift = if ($swiftMatch) { $swiftMatch[1].Trim() } else { $null }

$ribLine = $null
foreach ($l in $lines) {
  if ($l -match "\b(?<bank>\d{3})\s+(?<city>\d{3})\s+(?<serial>\d{10,})\s+(?<key>\d{2})\b") {
    $ribLine = "$($Matches.bank) $($Matches.city) $($Matches.serial) $($Matches.key)"
    break
  }
}

$bankName = $null
foreach ($l in $lines) {
  if ($l -match "Attijariwafa") { $bankName = "Attijariwafa bank"; break }
}

$beneficiaryName = $null
foreach ($l in $lines) {
  if ($l -match "\bTSOULI\b" -and $l -match "\bYOUNES\b") { $beneficiaryName = "M TSOULI YOUNES"; break }
}

if ($paypalClientId) { $env:PAYPAL_CLIENT_ID = $paypalClientId }
if ($paypalClientSecret) { $env:PAYPAL_CLIENT_SECRET = $paypalClientSecret }
$env:PAYPAL_MODE = "live"
$env:SWARM_LIVE = "true"
$env:BASE44_OFFLINE = "false"
$env:BASE44_OFFLINE_MODE = "false"
if (-not $env:NO_PLATFORM_WALLET) { $env:NO_PLATFORM_WALLET = "true" }
if (-not $env:BASE44_ENABLE_TRUTH_ONLY_UI) { $env:BASE44_ENABLE_TRUTH_ONLY_UI = "true" }
if (-not $env:BASE44_ENABLE_REVENUE_FROM_PAYPAL) { $env:BASE44_ENABLE_REVENUE_FROM_PAYPAL = "true" }
if (-not $env:AUTONOMOUS_PAYOUT_LIVE) { $env:AUTONOMOUS_PAYOUT_LIVE = "true" }
if (-not $env:BASE44_ENABLE_PAYOUT_LEDGER_WRITE) { $env:BASE44_ENABLE_PAYOUT_LEDGER_WRITE = "true" }
if (-not $env:AUTONOMOUS_MISSION_HEALTH) { $env:AUTONOMOUS_MISSION_HEALTH = "true" }
if (-not $env:BASE44_ENABLE_MISSION_HEALTH_WRITE) { $env:BASE44_ENABLE_MISSION_HEALTH_WRITE = "true" }
if (-not $env:BASE44_ENABLE_HEALTH_WRITE) { $env:BASE44_ENABLE_HEALTH_WRITE = "true" }
if (-not $env:AUTONOMOUS_MISSION_LIMIT) { $env:AUTONOMOUS_MISSION_LIMIT = "600" }
if (-not $env:AUTONOMOUS_SYNC_PAYPAL_LEDGER) { $env:AUTONOMOUS_SYNC_PAYPAL_LEDGER = "true" }
$env:AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES = "false"
$env:AUTONOMOUS_AUTO_SUBMIT_PAYPAL = "false"
$env:AUTONOMOUS_AUTO_APPROVE_PAYOUT_BATCHES = "false"
$env:AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUT_BATCHES = "false"
$env:AUTONOMOUS_DISABLE_INCIDENT_LOG_WRITE = "true"
$env:AUTONOMOUS_ENFORCE_MISSION_HEALTH_FREEZE = "false"
$env:AUTONOMOUS_DEADMAN = "false"

if ([string]::IsNullOrWhiteSpace($env:BASE44_APP_ID)) { $env:BASE44_APP_ID = GetCredValue "BASE44_APP_ID" }
if ([string]::IsNullOrWhiteSpace($env:BASE44_SERVICE_TOKEN)) { $env:BASE44_SERVICE_TOKEN = GetCredValue "BASE44_SERVICE_TOKEN" }
if ([string]::IsNullOrWhiteSpace($env:PAYPAL_WEBHOOK_ID)) { $env:PAYPAL_WEBHOOK_ID = GetCredValue "PAYPAL_WEBHOOK_ID" }
if ([string]::IsNullOrWhiteSpace($env:PAYPAL_WEBHOOK_ID)) { $env:PAYPAL_WEBHOOK_ID = TryDetectPayPalWebhookId }

if ($bankSwift) { $env:BANK_SWIFT = $bankSwift }
if ($bankName) { $env:BANK_NAME = $bankName }
if ($beneficiaryName) { $env:BANK_BENEFICIARY_NAME = $beneficiaryName }
if ($ribLine) {
  $env:BANK_RIB = $ribLine
  if (-not $env:BANK_ACCOUNT) { $env:BANK_ACCOUNT = $ribLine }
}

if (-not $env:OWNER_PAYPAL_EMAIL -and $paypalEmail) { $env:OWNER_PAYPAL_EMAIL = $paypalEmail }
if (-not $env:OWNER_PAYONEER_ID -and $payoneerEmail) { $env:OWNER_PAYONEER_ID = $payoneerEmail }
if (-not $env:OWNER_BANK_ACCOUNT -and $env:BANK_ACCOUNT) { $env:OWNER_BANK_ACCOUNT = $env:BANK_ACCOUNT }

if (-not $env:AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS -and $env:OWNER_PAYPAL_EMAIL) {
  $env:AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS = $env:OWNER_PAYPAL_EMAIL
}
if (-not $env:AUTONOMOUS_ALLOWED_PAYONEER_RECIPIENTS -and $env:OWNER_PAYONEER_ID) {
  $env:AUTONOMOUS_ALLOWED_PAYONEER_RECIPIENTS = $env:OWNER_PAYONEER_ID
}
if (-not $env:AUTONOMOUS_ALLOWED_BANK_WIRE_ACCOUNTS -and $env:OWNER_BANK_ACCOUNT) {
  $env:AUTONOMOUS_ALLOWED_BANK_WIRE_ACCOUNTS = $env:OWNER_BANK_ACCOUNT
}

if ($env:BANK_NAME -or $env:BANK_SWIFT -or $env:BANK_ACCOUNT -or $env:BANK_BENEFICIARY_NAME) {
  $obj = @{
    bank = $env:BANK_NAME
    swift = $env:BANK_SWIFT
    account = $env:BANK_ACCOUNT
    beneficiary = $env:BANK_BENEFICIARY_NAME
  }
  $env:BASE44_PAYOUT_DESTINATION_JSON = ($obj | ConvertTo-Json -Compress)
}

$actionLower = $Action.ToLowerInvariant()
$shouldPrompt = @("shell") -contains $actionLower

if ($shouldPrompt) {
  if ([string]::IsNullOrWhiteSpace($env:BASE44_APP_ID)) {
    $env:BASE44_APP_ID = Read-Host "BASE44_APP_ID (app id or Base44 app URL)"
  }
  if ([string]::IsNullOrWhiteSpace($env:BASE44_SERVICE_TOKEN)) {
    $sec = Read-Host "BASE44_SERVICE_TOKEN" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $env:BASE44_SERVICE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_WEBHOOK_ID)) {
    $env:PAYPAL_WEBHOOK_ID = Read-Host "PAYPAL_WEBHOOK_ID"
  }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_ID)) {
    $env:PAYPAL_CLIENT_ID = Read-Host "PAYPAL_CLIENT_ID"
  }
  if ([string]::IsNullOrWhiteSpace($env:PAYPAL_CLIENT_SECRET)) {
    $sec = Read-Host "PAYPAL_CLIENT_SECRET" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $env:PAYPAL_CLIENT_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}

Write-Host ("SWARM_LIVE=" + $env:SWARM_LIVE)
Write-Host ("PAYPAL_CLIENT_ID " + (Mask $env:PAYPAL_CLIENT_ID))
Write-Host ("PAYPAL_CLIENT_SECRET " + (Mask $env:PAYPAL_CLIENT_SECRET))
Write-Host ("PAYPAL_WEBHOOK_ID " + (Mask $env:PAYPAL_WEBHOOK_ID))
Write-Host ("BASE44_APP_ID " + (Mask $env:BASE44_APP_ID))
Write-Host ("BASE44_SERVICE_TOKEN " + (Mask $env:BASE44_SERVICE_TOKEN))
Write-Host ("BANK_NAME " + (Mask $env:BANK_NAME))
Write-Host ("BANK_SWIFT " + (Mask $env:BANK_SWIFT))
Write-Host ("BANK_ACCOUNT " + (Mask $env:BANK_ACCOUNT))
Write-Host ("BANK_BENEFICIARY_NAME " + (Mask $env:BANK_BENEFICIARY_NAME))
Write-Host ("BASE44_PAYOUT_DESTINATION_JSON " + (Mask $env:BASE44_PAYOUT_DESTINATION_JSON))
if ($payoneerEmail) { Write-Host ("Payoneer email: " + $payoneerEmail) }
if ($paypalEmail) { Write-Host ("PayPal email: " + $paypalEmail) }

switch ($actionLower) {
  "setup" { npm ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; break }
  "all" {
    InvokeChecked "npm ci" { npm ci }
    InvokeChecked "npm test" { npm test }
    InvokeChecked "readiness" { npm run live:readiness:ping }
    npm run autonomous:daemon
    break
  }
  "readiness" { npm run live:readiness:ping; break }
  "paypalwebhooks" {
    $hooks = ListPayPalWebhooks
    Write-Host ("PAYPAL_WEBHOOKS_COUNT=" + ($hooks | Measure-Object).Count)
    Write-Host ($hooks | ConvertTo-Json -Depth 6 -Compress)
    break
  }
  "paypalwebhookcreate" {
    $targetUrl = $WebhookUrl
    if ([string]::IsNullOrWhiteSpace($targetUrl)) {
      $publicBase = $env:PUBLIC_BASE_URL
      if ([string]::IsNullOrWhiteSpace($publicBase)) { $publicBase = $env:PUBLIC_WEBHOOK_BASE_URL }
      if (-not [string]::IsNullOrWhiteSpace($publicBase)) {
        $targetUrl = ($publicBase.TrimEnd("/") + "/paypal/webhook")
      }
    }
    if ([string]::IsNullOrWhiteSpace($targetUrl)) { throw "Provide -WebhookUrl or set PUBLIC_BASE_URL" }
    $created = CreatePayPalWebhook $targetUrl
    $id = $created.id
    if ([string]::IsNullOrWhiteSpace($id)) { throw "Create webhook did not return an id" }
    $env:PAYPAL_WEBHOOK_ID = $id
    SaveCredEnvVar "PAYPAL_WEBHOOK_ID" $id
    Write-Host ($created | ConvertTo-Json -Depth 6 -Compress)
    break
  }
  "webhook" { npm run paypal:webhook; break }
  "daemon" { npm run autonomous:daemon; break }
  "once" { npm run autonomous:once; break }
  "shell" { Write-Host "Environment is set in this window."; break }
  default { Write-Host ("Unknown action: " + $Action); Write-Host "Actions: all, setup, readiness, paypalwebhooks, paypalwebhookcreate, webhook, daemon, once, shell"; break }
}
