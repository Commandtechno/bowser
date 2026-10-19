# runs bowser on 127.0.0.1:$PORT and exposes it to the tailnet via `tailscale serve` -
# launched at boot by the scheduled task scripts/install-service.ps1 registers
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$port = if ($env:PORT) { $env:PORT } else { "8888" }
$env:HOST = "127.0.0.1"
$env:PORT = $port
$env:NODE_ENV = "production"

# a task started before logon doesn't get the user's PATH, which is where winget/npm put
# pnpm, ffmpeg, exiftool and poppler (see requirements.txt)
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
  [Environment]::GetEnvironmentVariable("Path", "User")

$logDir = Join-Path $root ".bowser\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "service.log"
# a log line is never worth taking the service down for
function Write-Log($message) { Add-Content $log "[$(Get-Date -Format s)] $message" -ErrorAction SilentlyContinue }

# native output goes through cmd's redirection - a transcript doesn't capture it, and piping
# stderr in Windows PowerShell turns each line into an error record
function Invoke-Logged($command) {
  cmd /c "$command >> `"$log`" 2>&1"
  return $LASTEXITCODE
}

Write-Log "starting"

# rebuild on every start so the service always serves the checked-out code - skips
# `astro check` (the `build` script) since a type error shouldn't keep the server down
$code = Invoke-Logged "pnpm exec astro build"
if ($code -ne 0) { Write-Log "astro build failed ($code)"; exit $code }

# serve config persists inside tailscaled, so this is idempotent; it's re-applied each boot
# in case it was reset. non-fatal: bowser still runs locally if tailscale is down. bounded
# because it blocks forever (printing an enable link) while Serve is off for the tailnet
$serve = Start-Process tailscale -ArgumentList "serve", "--bg", "--https=443", "http://127.0.0.1:$port" `
  -NoNewWindow -PassThru
if (-not $serve.WaitForExit(30000)) {
  $serve.Kill()
  Write-Log "tailscale serve timed out - is Serve enabled for the tailnet?"
} elseif ($serve.ExitCode -ne 0) {
  Write-Log "tailscale serve failed ($($serve.ExitCode))"
}

# task scheduler only restarts a task that fails to launch, not one whose process exits, so
# the server is kept up here. --env-file-if-exists: astro only loads .env in dev, the
# standalone server reads process.env
while ($true) {
  $code = Invoke-Logged "node --env-file-if-exists=.env ./dist/server/entry.mjs"
  Write-Log "server exited ($code), restarting in 10s"
  Start-Sleep -Seconds 10
}
