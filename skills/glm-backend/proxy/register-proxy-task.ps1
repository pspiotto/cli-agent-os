# Registers the GLM-Bundle-Proxy scheduled task: at logon, run start-proxy.ps1 headless
# (conhost --headless, per RULES.md) so 127.0.0.1:4000 is up for `/glm-backend on --bundle`.
# Rerun after moving the checkout. Remove: Unregister-ScheduledTask -TaskName GLM-Bundle-Proxy

$ErrorActionPreference = 'Stop'
$pwsh = (Get-Command pwsh).Source
$script = Join-Path $PSScriptRoot 'start-proxy.ps1'
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\conhost.exe' `
    -Argument "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'GLM-Bundle-Proxy' -Action $action -Trigger $trigger -Settings $settings `
    -Description 'LiteLLM proxy for agent-os glm-backend bundle mode (127.0.0.1:4000)' -Force | Out-Null
Get-ScheduledTask -TaskName 'GLM-Bundle-Proxy' | Select-Object TaskName, State
