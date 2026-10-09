#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the claude-os startup banner and status line canary. Opt-in and
  separate from install.ps1; uninstall-banner.ps1 reverses every step.

.DESCRIPTION
  1. Copies art.txt (the overlay's banner\art.txt when an overlay is saved in
     ~/.claude/overlay.txt and has one), claude-os-banner.ps1 and
     claude-os-statusline.js to
     %USERPROFILE%\.claude\banner\, and seeds statusline.json there with the
     default segment set if it is not already present. That file is the
     machine's own (the /statusline skill writes it), so a reinstall never
     overwrites it.
  2. Adds a marker block to the CurrentUserCurrentHost profile of BOTH
     PowerShell 7 (Documents\PowerShell) and Windows PowerShell 5.1
     (Documents\WindowsPowerShell), created if missing. wmux panes run
     powershell.exe, a plain terminal usually runs pwsh, and each host reads
     only its own file. The block dot-sources claude-os-banner.ps1. An
     existing block is replaced; text outside it is kept.
  3. Adds a "statusLine" key to %USERPROFILE%\.claude\settings.json pointing at
     the status line script. If a statusLine that is not ours already exists,
     its command is recorded in banner\chain.txt and the key is repointed here:
     the canary then prints on top and the recorded command runs underneath it
     with the same stdin, so nothing is lost. uninstall-banner.ps1 puts the
     recorded command back. The old file is backed up first.

.PARAMETER SkipProfiles
  Skip step 2. The profile paths come from the Documents folder, which no
  environment variable moves, so a test run pointing USERPROFILE at a scratch
  folder would still write the real profiles. install-banner.test.ps1 passes
  this; a real install should not.

  Revert: .\uninstall-banner.ps1
#>
[CmdletBinding()]
param(
    [switch] $SkipProfiles
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$dest = Join-Path $env:USERPROFILE '.claude'
$bannerDir = Join-Path $dest 'banner'
$chainPath = Join-Path $bannerDir 'chain.txt'
$configPath = Join-Path $bannerDir 'statusline.json'
$settingsPath = Join-Path $dest 'settings.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = New-Object System.Collections.Generic.List[string]
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$startMarker = '# claude-os:banner:start'
$endMarker = '# claude-os:banner:end'
$statusCommand = 'node "$HOME/.claude/banner/claude-os-statusline.js"'

# Seeded once into banner\statusline.json and never overwritten after that, so
# a machine's /statusline choices survive every pull and reinstall. Keep in
# step with DEFAULTS in claude-os-statusline.js and the table in
# skills/statusline/SKILL.md.
$defaultSegments = [ordered]@{
    sha      = $true
    vim      = $false
    agent    = $false
    session  = $false
    model    = $true
    glm      = $true
    style    = $false
    worktree = $false
    dir      = $false
    context  = $true
    tokens   = $true
    cost     = $true
    limits   = $true
}

# statusline-command.sh is this repo's old jq shell pipeline. The status line
# renders those segments itself now, in one process, so chaining it would print
# everything twice and pay about a second of subprocesses on every render.
function Test-Superseded([string] $cmd) {
    return ($cmd -like '*statusline-command.sh*')
}

function Read-Text([string] $path) { return [System.IO.File]::ReadAllText($path) }
function Write-Text([string] $path, [string] $text) { [System.IO.File]::WriteAllText($path, $text, $utf8NoBom) }

# The repo names its own checkout as C:\GIT\cli-agent-os (the convention). The
# banner and the status line read that path to find .git for the version
# (r<count> <date>), so a clone anywhere else silently loses it. Rewrite both spellings to this
# checkout on the way in, the same way install.ps1 does for its .md files.
$repoRoot = Split-Path -Parent $here
$canonicalRepo = 'C:\GIT\cli-agent-os'

# The owner's own art, if the saved overlay has one (same file install.ps1 reads).
function Get-ArtSource {
    $ovFile = Join-Path $dest 'overlay.txt'
    if (Test-Path -LiteralPath $ovFile) {
        $ov = ([System.IO.File]::ReadAllText($ovFile)).Trim()
        if ($ov) {
            $ovArt = Join-Path $ov 'banner\art.txt'
            if (Test-Path -LiteralPath $ovArt) { return $ovArt }
        }
    }
    return (Join-Path $here 'art.txt')
}
function Localize-Text([string] $text) {
    if ($repoRoot -eq $canonicalRepo) { return $text }
    # Plain ordinal replaces, no regex: a '$' in a path must not become a
    # group reference. Both spellings, since the .ps1 uses backslashes and the
    # .js uses forward slashes.
    $text = $text.Replace($canonicalRepo, $repoRoot)
    return $text.Replace($canonicalRepo.Replace('\', '/'), $repoRoot.Replace('\', '/'))
}
function Test-Prop($obj, [string] $name) {
    if ($null -eq $obj) { return $false }
    return ($null -ne $obj.PSObject.Properties[$name])
}

# Both hosts' CurrentUserCurrentHost profiles. $PROFILE only names the one for
# the shell running this script, so build both from the Documents folder.
$docs = [Environment]::GetFolderPath('MyDocuments')
$profiles = @(
    (Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1'),
    (Join-Path $docs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1')
)

Write-Host "claude-os banner install"
if ($SkipProfiles) { $summary.Add("profile   : skipped (-SkipProfiles)") }
Write-Host "  profiles: $($profiles -join ', ')"
Write-Host "  dest    : $bannerDir"
Write-Host ""

# --- 1. files ---------------------------------------------------------------
if (-not (Test-Path -LiteralPath $bannerDir)) {
    New-Item -ItemType Directory -Path $bannerDir | Out-Null
}
$artSource = Get-ArtSource
foreach ($name in @('art.txt', 'claude-os-banner.ps1', 'claude-os-statusline.js')) {
    $src = Join-Path $here $name
    $dst = Join-Path $bannerDir $name
    if ($name -eq 'art.txt') {
        # Art: copy the bytes, never rewrite them.
        Copy-Item -LiteralPath $artSource -Destination $dst -Force
    }
    else {
        Write-Text $dst (Localize-Text (Read-Text $src))
    }
}
$note = "files     : 3 copied to $bannerDir"
if ($repoRoot -ne $canonicalRepo) { $note += "; repo path rewritten to $repoRoot" }
if ($artSource -ne (Join-Path $here 'art.txt')) { $note += "; art from the overlay ($artSource)" }
$summary.Add($note)

# --- 1b. segment config -----------------------------------------------------
# The status line reads this on every render; /statusline writes it. It belongs
# to the machine, not to the repo, so it is seeded once and left alone after.
# A missing file is not fatal either way: the script falls back to the same
# defaults it is seeded with.
if (Test-Path -LiteralPath $configPath) {
    $summary.Add("config    : $configPath kept (segment choices preserved)")
}
else {
    $configJson = [pscustomobject]@{
        segments = [pscustomobject] $defaultSegments
        width    = 0
    } | ConvertTo-Json -Depth 5
    Write-Text $configPath $configJson
    $summary.Add("config    : $configPath seeded with the default segments")
}

# --- 2. $PROFILE block -----------------------------------------------------
$block = @(
    $startMarker,
    ('# Installed by ' + (Join-Path $here 'install-banner.ps1') + '. Remove with uninstall-banner.ps1.'),
    ('. "' + (Join-Path $bannerDir 'claude-os-banner.ps1') + '"'),
    $endMarker
) -join "`r`n"
$blockRegex = '(?s)# claude-os:banner:start.*?# claude-os:banner:end'

foreach ($profilePath in $profiles) {
    if ($SkipProfiles) { break }
    $label = Split-Path -Leaf (Split-Path -Parent $profilePath)
    $profileDir = Split-Path -Parent $profilePath
    if (-not (Test-Path -LiteralPath $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir | Out-Null
    }
    if (Test-Path -LiteralPath $profilePath) {
        $text = Read-Text $profilePath
        $m = [regex]::Match($text, $blockRegex)
        if ($m.Success) {
            $newText = $text.Substring(0, $m.Index) + $block + $text.Substring($m.Index + $m.Length)
            $how = 'block replaced'
        }
        else {
            $newText = $text.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
            $how = 'block appended'
        }
        if ($newText -ne $text) {
            Copy-Item -LiteralPath $profilePath -Destination "$profilePath.bak-$stamp" -Force
            $summary.Add("backed up : $profilePath -> $profilePath.bak-$stamp")
            Write-Text $profilePath $newText
            $summary.Add("profile   : $label $how")
        }
        else {
            $summary.Add("profile   : $label unchanged")
        }
    }
    else {
        Write-Text $profilePath ($block + "`r`n")
        $summary.Add("profile   : $label created (no previous file); uninstall deletes it again")
    }
}

# --- 3. settings.json statusLine -------------------------------------------
if (Test-Path -LiteralPath $settingsPath) {
    $raw = Read-Text $settingsPath
    if ($PSVersionTable.PSVersion.Major -ge 6) { $obj = $raw | ConvertFrom-Json -Depth 20 }
    else { $obj = $raw | ConvertFrom-Json }

    if (Test-Prop $obj 'statusLine') {
        $cur = ''
        if (Test-Prop $obj.statusLine 'command') { $cur = [string] $obj.statusLine.command }
        if ($cur -eq $statusCommand) {
            if (Test-Path -LiteralPath $chainPath) {
                $chained = (Read-Text $chainPath).Trim()
                if (Test-Superseded $chained) {
                    Remove-Item -LiteralPath $chainPath -Force
                    $summary.Add("statusLine: already ours, unchanged")
                    $summary.Add("chain     : retired $chained; those segments are built in now")
                }
                else {
                    $summary.Add("statusLine: already ours, unchanged; still chaining $chained")
                }
            }
            else {
                $summary.Add("statusLine: already ours, unchanged")
            }
        }
        elseif ($cur -eq '') {
            # A statusLine with no command is nothing we know how to chain.
            $summary.Add("statusLine: exists but has no command, left alone")
        }
        elseif (Test-Superseded $cur) {
            # This machine was running the old shell pipeline. Take the key
            # without chaining it: the same segments now render here in one
            # process. Nothing is lost, so nothing is recorded to restore.
            if (Test-Path -LiteralPath $chainPath) { Remove-Item -LiteralPath $chainPath -Force }
            $obj.statusLine = [pscustomobject]@{ type = 'command'; command = $statusCommand }
            Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
            $summary.Add("backed up : $settingsPath -> $settingsPath.bak-$stamp")
            Write-Text $settingsPath ($obj | ConvertTo-Json -Depth 20)
            $summary.Add("statusLine: replaced the shell status line, not chained: $cur")
            $summary.Add("chain     : none; those segments are built in now, one process instead of ~28")
        }
        else {
            # Adopt it rather than stand down: record the command, point the key
            # here, and the canary script runs the recorded one underneath.
            Write-Text $chainPath ($cur + "`r`n")
            $obj.statusLine = [pscustomobject]@{ type = 'command'; command = $statusCommand }
            Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
            $summary.Add("backed up : $settingsPath -> $settingsPath.bak-$stamp")
            Write-Text $settingsPath ($obj | ConvertTo-Json -Depth 20)
            $summary.Add("statusLine: adopted; canary on top, chained below: $cur")
            $summary.Add("chain     : recorded in $chainPath; uninstall restores it")
        }
    }
    else {
        # No statusLine to adopt, so any chain.txt left over from an earlier
        # install would point at a command this machine no longer uses.
        if (Test-Path -LiteralPath $chainPath) {
            Remove-Item -LiteralPath $chainPath -Force
            $summary.Add("chain     : stale $chainPath removed, nothing to chain")
        }
        $obj | Add-Member -NotePropertyName 'statusLine' -NotePropertyValue ([pscustomobject]@{
            type    = 'command'
            command = $statusCommand
        })
        Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
        $summary.Add("backed up : $settingsPath -> $settingsPath.bak-$stamp")
        Write-Text $settingsPath ($obj | ConvertTo-Json -Depth 20)
        $summary.Add("statusLine: added; other keys untouched")
    }
}
else {
    if (Test-Path -LiteralPath $chainPath) {
        Remove-Item -LiteralPath $chainPath -Force
        $summary.Add("chain     : stale $chainPath removed, nothing to chain")
    }
    Write-Text $settingsPath (([pscustomobject]@{
        statusLine = [pscustomobject]@{ type = 'command'; command = $statusCommand }
    }) | ConvertTo-Json -Depth 20)
    $summary.Add("statusLine: settings.json created with statusLine only")
}

Write-Host "Summary"
foreach ($line in $summary) { Write-Host "  $line" }
Write-Host ""
Write-Host "Open a new PowerShell window or wmux pane and run 'claude' to see the banner."
Write-Host "The status line appears in new Claude Code sessions."
