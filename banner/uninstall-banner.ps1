#Requires -Version 5.1
<#
.SYNOPSIS
  Removes everything install-banner.ps1 added.

.DESCRIPTION
  1. Removes the "# claude-os:banner:start" .. "# claude-os:banner:end" block
     from both the PowerShell 7 and the Windows PowerShell 5.1 profiles. If a
     file then holds nothing but whitespace it is deleted, since
     install-banner.ps1 created it.
  2. Puts %USERPROFILE%\.claude\settings.json back, but only when the
     statusLine command is the one we installed. If banner\chain.txt holds the
     command this machine had before, that command is restored; otherwise the
     key is removed. Other keys untouched. The old file is backed up first.
  3. Deletes %USERPROFILE%\.claude\banner\.

  Everything here is regenerable from the repo, so deletion is safe. Backups
  of $PROFILE and settings.json from the install are left in place.

.PARAMETER SkipProfiles
  Skip step 1, for the same reason install-banner.ps1 has the switch: the
  profile paths ignore USERPROFILE, so a scratch-home test would edit the real
  ones. install-banner.test.ps1 passes this; a real uninstall should not.
#>
[CmdletBinding()]
param(
    [switch] $SkipProfiles
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:USERPROFILE '.claude'
$bannerDir = Join-Path $dest 'banner'
$chainPath = Join-Path $bannerDir 'chain.txt'
$settingsPath = Join-Path $dest 'settings.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = New-Object System.Collections.Generic.List[string]
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$statusCommand = 'node "$HOME/.claude/banner/claude-os-statusline.js"'
$blockRegex = '(?s)\r?\n?\r?\n?# claude-os:banner:start.*?# claude-os:banner:end\r?\n?'

function Read-Text([string] $path) { return [System.IO.File]::ReadAllText($path) }
function Write-Text([string] $path, [string] $text) { [System.IO.File]::WriteAllText($path, $text, $utf8NoBom) }
function Test-Prop($obj, [string] $name) {
    if ($null -eq $obj) { return $false }
    return ($null -ne $obj.PSObject.Properties[$name])
}

Write-Host "claude-os banner uninstall"
Write-Host ""

# --- 1. profiles (PowerShell 7 and Windows PowerShell 5.1) -----------------
$docs = [Environment]::GetFolderPath('MyDocuments')
$profiles = @(
    (Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1'),
    (Join-Path $docs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1')
)
foreach ($profilePath in $profiles) {
    if ($SkipProfiles) { $summary.Add("profile   : skipped (-SkipProfiles)"); break }
    $label = Split-Path -Leaf (Split-Path -Parent $profilePath)
    if (Test-Path -LiteralPath $profilePath) {
        $text = Read-Text $profilePath
        $newText = [regex]::Replace($text, $blockRegex, '')
        if ($newText -ne $text) {
            Copy-Item -LiteralPath $profilePath -Destination "$profilePath.bak-$stamp" -Force
            $summary.Add("backed up : $profilePath -> $profilePath.bak-$stamp")
            if ($newText.Trim().Length -eq 0) {
                Remove-Item -LiteralPath $profilePath -Force
                $summary.Add("profile   : $label block removed; file was otherwise empty, deleted")
            }
            else {
                Write-Text $profilePath $newText
                $summary.Add("profile   : $label block removed; other content kept")
            }
        }
        else {
            $summary.Add("profile   : $label no claude-os banner block found")
        }
    }
    else {
        $summary.Add("profile   : $label no file")
    }
}

# --- 2. settings.json statusLine -------------------------------------------
if (Test-Path -LiteralPath $settingsPath) {
    $raw = Read-Text $settingsPath
    if ($PSVersionTable.PSVersion.Major -ge 6) { $obj = $raw | ConvertFrom-Json -Depth 20 }
    else { $obj = $raw | ConvertFrom-Json }
    if (Test-Prop $obj 'statusLine') {
        $cur = ''
        if (Test-Prop $obj.statusLine 'command') { $cur = [string] $obj.statusLine.command }
        if ($cur -eq $statusCommand) {
            # Read the chain before step 3 deletes the folder holding it.
            $prev = ''
            if (Test-Path -LiteralPath $chainPath) { $prev = (Read-Text $chainPath).Trim() }
            if ($prev -ne '') {
                $obj.statusLine = [pscustomobject]@{ type = 'command'; command = $prev }
            }
            else {
                $obj.PSObject.Properties.Remove('statusLine')
            }
            Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
            $summary.Add("backed up : $settingsPath -> $settingsPath.bak-$stamp")
            Write-Text $settingsPath ($obj | ConvertTo-Json -Depth 20)
            if ($prev -ne '') { $summary.Add("statusLine: previous command restored: $prev") }
            else { $summary.Add("statusLine: removed; other keys untouched") }
        }
        else {
            $summary.Add("statusLine: not ours, left alone: $cur")
        }
    }
    else {
        $summary.Add("statusLine: none present")
    }
}

# --- 3. files ---------------------------------------------------------------
if (Test-Path -LiteralPath $bannerDir) {
    Remove-Item -LiteralPath $bannerDir -Recurse -Force
    $summary.Add("files     : $bannerDir deleted")
}
else {
    $summary.Add("files     : $bannerDir not present")
}

Write-Host "Summary"
foreach ($line in $summary) { Write-Host "  $line" }
Write-Host ""
Write-Host "Open a new PowerShell window; 'claude' is the plain executable again."
Write-Host "Running Claude Code sessions keep their status line until restarted."
