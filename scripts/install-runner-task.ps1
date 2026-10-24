# Register the OneMemory command runner as a Scheduled Task so it survives a
# reboot. Run this once, in a normal (non-admin) PowerShell window.
#
# It deliberately does NOT run as administrator: the runner executes whatever
# the allowlist names, and that should not come with admin rights by default.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cmd  = Join-Path $root "scripts\runner.cmd"
$name = "OneMemory Runner"

if (-not (Test-Path $cmd)) { throw "Cannot find $cmd" }

if (-not $env:ONEMEMORY_RUNNER_SECRET) {
  Write-Warning "ONEMEMORY_RUNNER_SECRET is not set for your user account."
  Write-Warning "Set it first, or the runner will refuse to start:"
  Write-Warning '  setx ONEMEMORY_RUNNER_SECRET "your-long-random-secret"'
}

$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmd`"" -WorkingDirectory $root
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
             -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Description "Watches OneMemory for signed commands and runs allowlisted ones." -Force | Out-Null

Write-Host "Registered '$name'. It starts at logon."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName '$name'"
Write-Host "Stop it with:       Stop-ScheduledTask  -TaskName '$name'"
Write-Host "Remove it with:     Unregister-ScheduledTask -TaskName '$name' -Confirm:`$false"
