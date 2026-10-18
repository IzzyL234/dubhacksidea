param(
  [string]$BotProject = (Join-Path $env:USERPROFILE 'my-project'),
  [string]$CloudflaredPath = 'cloudflared',
  [int]$Port = 3003
)
$ErrorActionPreference = 'Stop'
$checkout = Split-Path $PSScriptRoot -Parent
$botRoot = (Resolve-Path -LiteralPath $BotProject).Path
$readToken = Join-Path $botRoot '.google-calendar-token.json'
$writeToken = Join-Path $botRoot '.google-calendar-write-token.json'
foreach ($token in @($readToken, $writeToken)) {
  if (-not (Test-Path -LiteralPath $token)) { throw 'Authorize Calendar reading and writing in the bot project first.' }
}
$bunCommand = Get-Command bun -ErrorAction Stop
$tunnelCommand = Get-Command $CloudflaredPath -ErrorAction Stop
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is already in use. Keep the existing worker, or stop it before running this script."
}
$env:SCHEDULE_REVIEW_DIRECTORY = Join-Path $botRoot 'data/schedule-reviews'
$env:GOOGLE_CALENDAR_TOKEN_FILE = $readToken
$env:GOOGLE_CALENDAR_WRITE_TOKEN_FILE = $writeToken
$env:REVIEW_WORKER_PORT = [string]$Port
$worker = Start-Process -FilePath $bunCommand.Source -ArgumentList 'src/review-worker.ts' -WorkingDirectory $checkout -WindowStyle Hidden -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($worker.HasExited) { throw 'The approval worker stopped during startup.' }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'The approval worker did not start listening.' }
  Write-Host 'The protected approval worker is running. Keep this terminal open.'
  Write-Host 'Wait for Registered tunnel connection before using the printed address.'
  & $tunnelCommand.Source tunnel --protocol http2 --url "http://127.0.0.1:$Port" --no-autoupdate
} finally {
  if (-not $worker.HasExited) { Stop-Process -Id $worker.Id }
}
