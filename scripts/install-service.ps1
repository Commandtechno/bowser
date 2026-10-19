# registers a scheduled task that runs scripts/bowser-service.ps1 at boot, as the current user
# (not SYSTEM, so it sees the user's files and PATH). run once from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
# remove with: Unregister-ScheduledTask -TaskName Bowser -Confirm:$false
param([string]$TaskName = "Bowser")
$ErrorActionPreference = "Stop"

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "run this from an elevated (administrator) PowerShell - a boot trigger needs admin"
}

$script = Join-Path $PSScriptRoot "bowser-service.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U: runs whether or not the user is logged on, without storing their password
$user = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $user `
  -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "registered and started '$TaskName' - logs in .bowser\logs\service.log"
