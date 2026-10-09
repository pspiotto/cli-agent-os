#Requires -Version 5.1
<#
.SYNOPSIS
  Exercises install-banner.ps1 and uninstall-banner.ps1 against a scratch home
  folder, with the status line chain as the subject.

.DESCRIPTION
  Points USERPROFILE at a temp folder for the duration of the run, so the real
  ~/.claude is never touched, and passes -SkipProfiles to both scripts, since
  the PowerShell profile paths come from the Documents folder and no
  environment variable moves them.

    1. no statusLine yet: install adds ours and writes no chain
    2. uninstall from there: the key goes, nothing is restored
    3. a foreign statusLine: install adopts it, chain.txt holds the old
       command, sibling keys survive
    4. install twice: the second run does not chain ourselves
    5. uninstall: the foreign command comes back, banner folder gone
    6. a stale chain.txt with no statusLine to adopt is removed, not honoured
    7. the script itself runs the chained command and prints both lines
    8. the canary reads the contents of the claude-os block, not the markers,
       so an emptied block (what /disable-global-rules leaves) reads OFF
    9. statusline.json is seeded once and never overwritten, the segments
       follow it, and the repo's old shell pipeline is replaced, not chained

  Exit code 0 when every check passes, 1 otherwise.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-os-banner-test-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$claudeDir = Join-Path $scratch '.claude'
$bannerDir = Join-Path $claudeDir 'banner'
$chainPath = Join-Path $bannerDir 'chain.txt'
$configPath = Join-Path $bannerDir 'statusline.json'
$settings = Join-Path $claudeDir 'settings.json'

$statusCommand = 'node "$HOME/.claude/banner/claude-os-statusline.js"'
# A status line that belongs to the machine rather than to this repo. It has no
# replacement here, so install chains it and uninstall gives it back.
$foreign = 'bash C:/tools/machine-statusline.sh'
# This repo's own old jq pipeline. The status line renders those segments
# itself now, so this one is replaced outright and never chained.
$superseded = 'bash C:/Users/someone/.claude/statusline-command.sh'

$script:fails = 0
$script:passes = 0

function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passes++; Write-Host "  PASS  $name" }
    else { $script:fails++; Write-Host "  FAIL  $name" }
}

function Read-Text([string] $path) { return [System.IO.File]::ReadAllText($path) }
function Write-Text([string] $path, [string] $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Read-Settings {
    $raw = Read-Text $settings
    if ($PSVersionTable.PSVersion.Major -ge 6) { return $raw | ConvertFrom-Json -Depth 20 }
    return $raw | ConvertFrom-Json
}
function Has-Prop($obj, [string] $name) {
    if ($null -eq $obj) { return $false }
    return ($null -ne $obj.PSObject.Properties[$name])
}
function Run-Install { & (Join-Path $here 'install-banner.ps1') -SkipProfiles | Out-Null }
function Run-Uninstall { & (Join-Path $here 'uninstall-banner.ps1') -SkipProfiles | Out-Null }
function Reset-Home {
    if (Test-Path -LiteralPath $claudeDir) { Remove-Item -LiteralPath $claudeDir -Recurse -Force }
    New-Item -ItemType Directory -Path $claudeDir | Out-Null
}

New-Item -ItemType Directory -Path $scratch | Out-Null
$savedProfile = $env:USERPROFILE
$env:USERPROFILE = $scratch
Write-Host "scratch home: $scratch"

try {
    # --- 1. no statusLine yet ------------------------------------------------
    Write-Host "`n1. install into a home with no statusLine"
    Reset-Home
    Write-Text $settings '{"model":"opus"}'
    Run-Install
    $obj = Read-Settings
    Assert (Has-Prop $obj 'statusLine') 'statusLine key added'
    Assert ([string] $obj.statusLine.command -eq $statusCommand) 'statusLine points at the canary'
    Assert ([string] $obj.model -eq 'opus') 'sibling key survived'
    Assert (-not (Test-Path -LiteralPath $chainPath)) 'no chain.txt when there was nothing to adopt'
    Assert (Test-Path -LiteralPath (Join-Path $bannerDir 'claude-os-statusline.js')) 'script copied'
    # The banner and the canary read the repo's .git for the version. A
    # checkout that is not C:\GIT\cli-agent-os must be rewritten into the
    # copies, or the SHA silently disappears (seen on a machine whose git root
    # was not C:\GIT).
    $repoRoot = Split-Path -Parent $here
    $jsText = Read-Text (Join-Path $bannerDir 'claude-os-statusline.js')
    $ps1Text = Read-Text (Join-Path $bannerDir 'claude-os-banner.ps1')
    if ($repoRoot -eq 'C:\GIT\cli-agent-os') {
        Assert ($jsText -match 'C:/GIT/cli-agent-os') 'canary keeps the canonical repo path on a canonical checkout'
    }
    else {
        Assert ($jsText.Contains($repoRoot.Replace('\', '/'))) 'canary repo path localized to this checkout'
        Assert (-not $jsText.Contains('C:/GIT/cli-agent-os')) 'no canonical repo path left in the canary'
        Assert ($ps1Text.Contains($repoRoot)) 'banner repo path localized to this checkout'
        Assert (-not $ps1Text.Contains('C:\GIT\cli-agent-os')) 'no canonical repo path left in the banner'
    }
    Assert ((Read-Text (Join-Path $bannerDir 'art.txt')) -eq (Read-Text (Join-Path $here 'art.txt'))) 'art copied byte-for-byte, not rewritten'

    # The overlay's own art wins when the saved overlay has one.
    $ovDir = Join-Path $scratch 'overlay'
    New-Item -ItemType Directory -Path (Join-Path $ovDir 'banner') -Force | Out-Null
    Write-Text (Join-Path $ovDir 'banner\art.txt') "OVERLAY ART`n"
    Write-Text (Join-Path $claudeDir 'overlay.txt') ($ovDir + "`n")
    Run-Install
    Assert ((Read-Text (Join-Path $bannerDir 'art.txt')) -eq "OVERLAY ART`n") 'overlay art used when the overlay has one'
    Remove-Item -LiteralPath (Join-Path $claudeDir 'overlay.txt') -Force
    Run-Install
    Assert ((Read-Text (Join-Path $bannerDir 'art.txt')) -eq (Read-Text (Join-Path $here 'art.txt'))) 'repo art back without an overlay'

    # --- 2. uninstall from there --------------------------------------------
    Write-Host "`n2. uninstall with nothing to restore"
    Run-Uninstall
    $obj = Read-Settings
    Assert (-not (Has-Prop $obj 'statusLine')) 'statusLine key removed'
    Assert ([string] $obj.model -eq 'opus') 'sibling key still there'
    Assert (-not (Test-Path -LiteralPath $bannerDir)) 'banner folder deleted'

    # --- 3. a foreign statusLine --------------------------------------------
    Write-Host "`n3. install over a status line this machine already had"
    Reset-Home
    Write-Text $settings ('{"model":"opus","statusLine":{"type":"command","command":"' + $foreign.Replace('\', '\\') + '"}}')
    Run-Install
    $obj = Read-Settings
    Assert ([string] $obj.statusLine.command -eq $statusCommand) 'statusLine repointed at the canary'
    Assert ([string] $obj.statusLine.type -eq 'command') 'type kept as command'
    Assert ([string] $obj.model -eq 'opus') 'sibling key survived the adopt'
    Assert (Test-Path -LiteralPath $chainPath) 'chain.txt written'
    Assert ((Read-Text $chainPath).Trim() -eq $foreign) 'chain.txt holds the foreign command'

    # --- 4. install twice ----------------------------------------------------
    Write-Host "`n4. install a second time"
    Run-Install
    $obj = Read-Settings
    Assert ([string] $obj.statusLine.command -eq $statusCommand) 'statusLine unchanged'
    Assert ((Read-Text $chainPath).Trim() -eq $foreign) 'chain.txt still the foreign command, not ourselves'

    # --- 5. uninstall restores ----------------------------------------------
    Write-Host "`n5. uninstall restores what was adopted"
    Run-Uninstall
    $obj = Read-Settings
    Assert (Has-Prop $obj 'statusLine') 'statusLine key kept'
    Assert ([string] $obj.statusLine.command -eq $foreign) 'foreign command restored'
    Assert ([string] $obj.model -eq 'opus') 'sibling key still there'
    Assert (-not (Test-Path -LiteralPath $bannerDir)) 'banner folder deleted'

    # --- 6. a stale chain ----------------------------------------------------
    Write-Host "`n6. stale chain.txt with no statusLine to adopt"
    Reset-Home
    Write-Text $settings '{"model":"opus"}'
    New-Item -ItemType Directory -Path $bannerDir | Out-Null
    Write-Text $chainPath 'echo ghost'
    Run-Install
    Assert (-not (Test-Path -LiteralPath $chainPath)) 'stale chain.txt removed'
    $obj = Read-Settings
    Assert ([string] $obj.statusLine.command -eq $statusCommand) 'statusLine still points at the canary'

    # --- 7. the script chains for real ---------------------------------------
    Write-Host "`n7. the canary script runs the chained command"
    Reset-Home
    New-Item -ItemType Directory -Path $bannerDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $here 'claude-os-statusline.js') -Destination $bannerDir -Force
    Write-Text $chainPath 'node -e "process.stdin.resume();process.stdout.write(''CHAINED LINE'')"'
    $canary = Join-Path $bannerDir 'claude-os-statusline.js'
    $out = '{"model":{"display_name":"Opus 5"}}' | & node $canary
    $text = ($out -join "`n")
    Assert ($text -match 'agent-os') 'canary printed'
    Assert ($text -match 'CHAINED LINE') 'chained output printed'
    Assert (($out | Measure-Object).Count -eq 2) 'two lines: canary then chain'
    Assert ($text -notmatch 'Opus 5') 'model dropped from the canary line when a chain owns it'

    Remove-Item -LiteralPath $chainPath -Force
    $out2 = '{"model":{"display_name":"Opus 5"}}' | & node $canary
    Assert ((($out2 -join "`n") -match 'Opus 5')) 'model back on the canary line with no chain'

    # --- 8. on/off is the block's contents, not the markers ------------------
    Write-Host "`n8. the canary reads what is between the markers"
    $claudeMd = Join-Path $claudeDir 'CLAUDE.md'
    $startMarker = '<!-- claude-os:start -->'
    $endMarker = '<!-- claude-os:end -->'

    Write-Text $claudeMd ($startMarker + "`n# rules`n- a rule`n" + $endMarker + "`n")
    Assert ((('{}' | & node $canary) -join "`n") -match 'agent-os on') 'block with rules reads on'

    # uninstall.ps1 empties the block and keeps the pair, so this is the state
    # a machine is in right after /disable-global-rules.
    Write-Text $claudeMd ($startMarker + "`n" + $endMarker + "`n`n# machine-local text`n")
    Assert ((('{}' | & node $canary) -join "`n") -match 'agent-os OFF') 'emptied block reads OFF'

    Write-Text $claudeMd "# no markers at all`n"
    Assert ((('{}' | & node $canary) -join "`n") -match 'agent-os OFF') 'no markers reads OFF'

    Write-Text $claudeMd ($startMarker + "`n# rules with no end marker`n")
    Assert ((('{}' | & node $canary) -join "`n") -match 'agent-os OFF') 'unterminated block reads OFF'

    # --- 9. the segment config, and the pipeline it replaces -----------------
    Write-Host "`n9. segment config and the retired shell pipeline"
    Reset-Home
    Write-Text $settings '{"model":"opus"}'
    Run-Install
    Assert (Test-Path -LiteralPath $configPath) 'statusline.json seeded on install'
    $cfg = Read-Text $configPath | ConvertFrom-Json
    Assert ($cfg.segments.tokens -eq $true) 'tokens on by default'
    Assert ($cfg.segments.cost -eq $true) 'cost on by default'
    Assert ($cfg.segments.worktree -eq $false) 'worktree off by default'

    # The file is the machine's, not the repo's: seeded once, never rewritten,
    # or every pull would throw away the choices /statusline just made.
    Write-Text $configPath '{"segments":{"tokens":false,"cost":false,"model":true},"width":0}'
    Run-Install
    $cfg = Read-Text $configPath | ConvertFrom-Json
    Assert ($cfg.segments.tokens -eq $false) 'reinstall kept the edited config'

    $canary9 = Join-Path $bannerDir 'claude-os-statusline.js'
    $sample = Read-Text (Join-Path $here 'sample-session.json')
    $line = ($sample | & node $canary9) -join "`n"
    Assert ($line -match 'agent-os') 'canary prints whatever the config says'
    Assert ($line -notmatch 'tokens: in:') 'tokens hidden when the config says off'
    Assert ($line -notmatch '\$1\.23') 'cost hidden when the config says off'
    Assert ($line -match 'Opus 5') 'model still printed when the config says on'

    Write-Text $configPath '{"segments":{"tokens":true,"worktree":true},"width":200}'
    $line = ($sample | & node $canary9) -join "`n"
    Assert ($line -match 'tokens: in:') 'tokens back on when the config says on'
    Assert ($line -match 'worktree:claude-os') 'worktree on when asked for'

    # A malformed config must not cost the status line: it falls back to the
    # defaults, which is what the script does with no config at all.
    Write-Text $configPath '{ this is not json'
    $line = ($sample | & node $canary9) -join "`n"
    Assert ($line -match 'agent-os') 'broken config still prints the canary'
    Assert ($line -match 'tokens: in:') 'broken config falls back to the defaults'

    # The repo's old jq pipeline is replaced, not chained: chaining it would
    # print every segment twice and pay ~28 subprocesses per render.
    Reset-Home
    Write-Text $settings ('{"model":"opus","statusLine":{"type":"command","command":"' + $superseded + '"}}')
    Run-Install
    $obj = Read-Settings
    Assert ([string] $obj.statusLine.command -eq $statusCommand) 'superseded shell line replaced'
    Assert (-not (Test-Path -LiteralPath $chainPath)) 'superseded shell line not chained'

    # A chain.txt left over from before the port is retired on the next install.
    Write-Text $chainPath $superseded
    Run-Install
    Assert (-not (Test-Path -LiteralPath $chainPath)) 'stale superseded chain retired'
}
finally {
    $env:USERPROFILE = $savedProfile
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}

Write-Host ""
Write-Host "passed: $script:passes  failed: $script:fails"
if ($script:fails -gt 0) { exit 1 }
exit 0
