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
Start-Transcript -Path (Join-Path $logDir "service.log") -Append | Out-Null

try {
  # rebuild on every start so the service always serves the checked-out code - skips
  # `astro check` (the `build` script) since a type error shouldn't keep the server down
  pnpm exec astro build
  if ($LASTEXITCODE -ne 0) { throw "astro build failed ($LASTEXITCODE)" }

  # serve config persists inside tailscaled, so this is idempotent; it's re-applied each boot
  # in case it was reset. non-fatal: bowser still runs locally if tailscale is down. bounded
  # because it blocks forever (printing an enable link) while Serve is off for the tailnet
  $serve = Start-Process tailscale -ArgumentList "serve", "--bg", "--https=443", "http://127.0.0.1:$port" `
    -NoNewWindow -PassThru
  if (-not $serve.WaitForExit(30000)) {
    $serve.Kill()
    Write-Warning "tailscale serve timed out - is Serve enabled for the tailnet?"
  } elseif ($serve.ExitCode -ne 0) {
    Write-Warning "tailscale serve failed ($($serve.ExitCode))"
  }

  # --env-file-if-exists: astro only loads .env in dev, the standalone server reads process.env
  node --env-file-if-exists=.env ./dist/server/entry.mjs
  exit $LASTEXITCODE
} finally {
  Stop-Transcript | Out-Null
}
