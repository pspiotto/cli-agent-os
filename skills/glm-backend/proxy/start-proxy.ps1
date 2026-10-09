# Starts the glm-backend bundle proxy (LiteLLM) on 127.0.0.1:4000.
# Venv: %LOCALAPPDATA%\agent-os\glm-proxy\venv (created by hand, see SKILL.md "Bundle mode").
# Key: ZAI_API_KEY if set, otherwise ~/.claude/secrets/zai-api-key.txt. It stays in this
# process's environment; it is never written anywhere.
# Launch headless:  C:\Windows\System32\conhost.exe --headless pwsh -NoProfile -File <this file>

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'agent-os\glm-proxy'
$litellm = Join-Path $root 'venv\Scripts\litellm.exe'
$config = Join-Path $PSScriptRoot 'litellm.yaml'
$log = Join-Path $root 'proxy.log'

if (-not (Test-Path -LiteralPath $litellm)) { throw "LiteLLM not installed: $litellm" }

if (-not $env:ZAI_API_KEY) {
    $keyFile = Join-Path $HOME '.claude\secrets\zai-api-key.txt'
    if (-not (Test-Path -LiteralPath $keyFile)) { throw "no Z.ai key: set ZAI_API_KEY or write $keyFile" }
    $env:ZAI_API_KEY = (Get-Content -LiteralPath $keyFile -Raw).Trim()
}

# Already listening? Then there is nothing to do.
if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) {
    "glm-proxy: 127.0.0.1:4000 already listening" | Add-Content -LiteralPath $log
    exit 0
}

$env:PYTHONIOENCODING = 'utf-8'
"glm-proxy: starting $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')" | Add-Content -LiteralPath $log
& $litellm --config $config --host 127.0.0.1 --port 4000 *>> $log
