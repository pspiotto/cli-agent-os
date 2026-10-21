#Requires -Version 5.1
<#
.SYNOPSIS
  Turns the agent-os user-level layer off for this machine, for every agent.

.DESCRIPTION
  Reverses install.ps1 steps 1 to 3 and 5 to 7 without touching anything the
  layer did not put there. Idempotent. Works under Windows PowerShell 5.1
  and 7.

  1. ~/.claude/CLAUDE.md: the text between <!-- claude-os:start --> and
                    <!-- claude-os:end --> is removed. The marker pair stays,
                    empty, so a later install.ps1 keeps the machine-local text
                    outside it. A file with no markers is left alone and
                    reported. The machine profile import block is removed in
                    the same write; ~/.claude/machine.txt stays so the next
                    install.ps1 puts the import back. Backed up first.
  2. ~/.claude/settings.json: the hook entries and permission rules the repo's
                    settings.json defines are removed. Entries from anything
                    else (wmux, local hooks) and every other key stay.
  3. ~/.claude/hooks, skills, agents: files install.ps1 copied are removed when
                    still identical to what it wrote. A file edited locally is
                    left and reported. The two toggle skills
                    (enable-global-rules, disable-global-rules) always stay so
                    the layer can be turned back on. The overlay's skills and
                    the generated hooks/charters.json go the same way;
                    ~/.claude/overlay.txt stays so the next install finds the
                    overlay again.
  4. Claude plugins: left installed. They are opt-in per session.
  5. ~/.agents/skills: the same rule as step 3 for the shared copies.
  6. Codex: the agent-os block leaves ~/.codex/AGENTS.md (the file is removed
                    if nothing else is in it), the repo's entries leave
                    ~/.codex/hooks.json, and a config.toml key leaves only
                    while it still holds the exact value install.ps1 wrote.
  7. Antigravity: the generated plugin folder
                    ~/.gemini/config/plugins/agent-os is removed (install.ps1
                    regenerates it), and the repo's permission rules leave
                    ~/.gemini/antigravity-cli/settings.json.
  8. Prints a summary.

  New agent sessions start without the layer. A running session keeps what it
  loaded at start.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$dest = Join-Path $env:USERPROFILE '.claude'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = New-Object System.Collections.Generic.List[string]
. (Join-Path $repo 'lib\common.ps1')

# Skills that must survive an uninstall. Paths relative to skills/.
$keepSkills = @('enable-global-rules', 'disable-global-rules')

function Test-SameContent([System.IO.FileInfo] $repoFile, [string] $installedFile, [bool] $shared) {
    # .md files were transformed on install: compare against that form.
    if ($repoFile.Extension -ieq '.md') {
        return ((Get-InstalledSkillText $repoFile $shared) -eq (Read-Text $installedFile))
    }
    $ha = (Get-FileHash -LiteralPath $repoFile.FullName -Algorithm SHA256).Hash
    $hb = (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash
    return ($ha -eq $hb)
}

function Remove-HookEntries($dstHooks, $srcHooks, [string] $label) {
    $removed = 0
    foreach ($eventProp in $srcHooks.PSObject.Properties) {
        $event = $eventProp.Name
        if (-not (Test-Prop $dstHooks $event)) { continue }
        $srcKeys = @(@($eventProp.Value) | ForEach-Object { Get-HookEntryKey $_ })
        $keep = New-Object System.Collections.Generic.List[object]
        foreach ($entry in @($dstHooks.$event)) {
            $key = Get-HookEntryKey $entry
            if ($srcKeys -contains $key) {
                $removed++
                $summary.Add("$label : removed ($event / $key)")
            }
            else {
                $keep.Add($entry)
            }
        }
        if ($keep.Count -eq 0) {
            $dstHooks.PSObject.Properties.Remove($event)
        }
        else {
            $dstHooks.$event = [object[]] $keep.ToArray()
        }
    }
    return $removed
}

function Remove-AllowRules($dstObj, [object[]] $rules, [string] $label) {
    if (-not ((Test-Prop $dstObj 'permissions') -and (Test-Prop $dstObj.permissions 'allow'))) { return 0 }
    $srcRules = @($rules | ForEach-Object { [string] $_ })
    $keepRules = New-Object System.Collections.Generic.List[object]
    $removed = 0
    foreach ($rule in @($dstObj.permissions.allow)) {
        if ($srcRules -contains [string] $rule) {
            $removed++
            $summary.Add("$label : removed ($rule)")
        }
        else {
            $keepRules.Add($rule)
        }
    }
    $dstObj.permissions.allow = [object[]] $keepRules.ToArray()
    return $removed
}

function Remove-AutoModeRules($dstObj, $srcAutoMode, [string] $label) {
    # Takes the repo's prose rules back out of each autoMode list. "$defaults"
    # stays: removing it would make any local rule left behind replace the
    # classifier's built-in list.
    if (-not (Test-Prop $dstObj 'autoMode')) { return 0 }
    $removed = 0
    foreach ($sectionProp in $srcAutoMode.PSObject.Properties) {
        $section = $sectionProp.Name
        if ($sectionProp.Value -isnot [array]) { continue }
        if (-not (Test-Prop $dstObj.autoMode $section)) { continue }
        $srcRules = @($sectionProp.Value | ForEach-Object { [string] $_ } | Where-Object { $_ -ne '$defaults' })
        $keepRules = New-Object System.Collections.Generic.List[object]
        foreach ($rule in @($dstObj.autoMode.$section)) {
            if ($srcRules -contains [string] $rule) {
                $removed++
                $summary.Add("$label : removed ($section)")
            }
            else {
                $keepRules.Add($rule)
            }
        }
        $dstObj.autoMode.$section = [object[]] $keepRules.ToArray()
    }
    return $removed
}

function Remove-CopiedFiles([object[]] $files, [string] $srcDir, [string] $dstDir, [bool] $shared, [string] $label) {
    if (-not (Test-Path -LiteralPath $dstDir)) { return }
    $deleted = 0
    $kept = 0
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($srcDir.Length).TrimStart('\', '/')
        $top = ($rel -split '[\\/]')[0]
        if ($label -match 'skills|shared' -and $keepSkills -contains $top) { $kept++; continue }
        $target = Join-Path $dstDir $rel
        if (-not (Test-Path -LiteralPath $target)) { continue }
        if (Test-SameContent $f $target $shared) {
            Remove-Item -LiteralPath $target -Force
            $deleted++
        }
        else {
            $summary.Add("$($label.PadRight(9)) : differs from what install.ps1 wrote, left in place ($target)")
        }
    }
    # Drop directories the deletions emptied, deepest first. Never $dstDir itself.
    $subdirs = @(Get-ChildItem -LiteralPath $dstDir -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($d in $subdirs) {
        if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -eq 0) {
            Remove-Item -LiteralPath $d.FullName -Force
        }
    }
    $note = "$($label.PadRight(9)) : $deleted file(s) removed from $dstDir"
    if ($kept -gt 0) { $note += " ($kept toggle skill file(s) kept)" }
    $summary.Add($note)
}

# ---------------------------------------------------------------------------
Write-Host "agent-os uninstall"
Write-Host "  repo : $repo"
Write-Host "  shell: PowerShell $($PSVersionTable.PSVersion)"
Write-Host ""

# --- 1. CLAUDE.md -----------------------------------------------------------
$startMarker = '<!-- claude-os:start -->'
$endMarker = '<!-- claude-os:end -->'
$blockRegex = '(?s)<!--\s*claude-os:start\s*-->.*?<!--\s*claude-os:end\s*-->'
$dstClaude = Join-Path $dest 'CLAUDE.md'

if (Test-Path -LiteralPath $dstClaude) {
    $dstText = Read-Text $dstClaude
    $m = [regex]::Match($dstText, $blockRegex)
    if ($m.Success) {
        $emptyBlock = $startMarker + "`n" + $endMarker
        $newText = $dstText.Substring(0, $m.Index) + $emptyBlock + $dstText.Substring($m.Index + $m.Length)
        # The machine profile import is part of the layer; drop it and the
        # blank lines that separate it from the end marker.
        $mRegex = '(?s)(\r?\n)*<!--\s*claude-os-machine:start\s*-->.*?<!--\s*claude-os-machine:end\s*-->'
        $mm = [regex]::Match($newText, $mRegex)
        $machineNote = ''
        if ($mm.Success) {
            $newText = $newText.Substring(0, $mm.Index) + $newText.Substring($mm.Index + $mm.Length)
            $machineNote = '; machine profile import removed'
        }
        if ($dstText -ne $newText) {
            Backup-File $dstClaude | Out-Null
            $removedLines = @($m.Value -split "`r?`n").Count - 2
            Write-Text $dstClaude $newText
            $summary.Add("CLAUDE.md : rules block emptied ($removedLines lines removed; markers and text outside them kept$machineNote)")
        }
        else {
            $summary.Add("CLAUDE.md : already disabled (block is empty)")
        }
    }
    else {
        $summary.Add("CLAUDE.md : no claude-os markers found; left alone (installed by an older install.ps1? run install.ps1 once, then uninstall)")
    }
}
else {
    $summary.Add("CLAUDE.md : not present")
}

# --- 2. settings.json (remove the repo's hook entries only) -----------------
$srcObj = ConvertFrom-JsonCompat (Read-Text (Join-Path $repo 'settings.json'))
$dstSettings = Join-Path $dest 'settings.json'

if (Test-Path -LiteralPath $dstSettings) {
    $dstObj = ConvertFrom-JsonCompat (Read-Text $dstSettings)
    $removed = 0
    if (Test-Prop $dstObj 'hooks') { $removed = Remove-HookEntries $dstObj.hooks $srcObj.hooks 'hook      ' }
    $allowRemoved = 0
    if ((Test-Prop $srcObj 'permissions') -and (Test-Prop $srcObj.permissions 'allow')) {
        $allowRemoved = Remove-AllowRules $dstObj @($srcObj.permissions.allow) 'permission'
    }
    $ovAllow = @(Get-OverlayAllowRules)
    if ($ovAllow.Count -gt 0) {
        $allowRemoved += Remove-AllowRules $dstObj $ovAllow 'permission (overlay)'
    }
    $autoRemoved = 0
    if (Test-Prop $srcObj 'autoMode') {
        $autoRemoved = Remove-AutoModeRules $dstObj $srcObj.autoMode 'autoMode  '
    }
    if ($removed -gt 0 -or $allowRemoved -gt 0 -or $autoRemoved -gt 0) {
        Backup-File $dstSettings | Out-Null
        Write-Text $dstSettings (ConvertTo-JsonCompat $dstObj)
        $summary.Add("settings  : $removed hook entr$(if ($removed -eq 1) { 'y' } else { 'ies' }), $allowRemoved permission rule(s) and $autoRemoved autoMode rule(s) removed; other hooks, rules and keys untouched")
    }
    else {
        $summary.Add("settings  : unchanged (no agent-os hook entries or permission rules present)")
    }
}
else {
    $summary.Add("settings  : not present")
}

# --- 3. hooks/, skills/, agents/ -------------------------------------------
if (Test-Path -LiteralPath $dest) {
    foreach ($dir in @('hooks', 'skills', 'agents')) {
        $srcDir = Join-Path $repo $dir
        if (-not (Test-Path -LiteralPath $srcDir)) { continue }
        $files = @(Get-ChildItem -LiteralPath $srcDir -Recurse -File | Where-Object { $_.Name -ne '.gitkeep' })
        Remove-CopiedFiles $files $srcDir (Join-Path $dest $dir) $false $dir
    }
    $ovSkills = @(Get-OverlaySkillFiles $false)
    if ($ovSkills.Count -gt 0) {
        Remove-CopiedFiles $ovSkills (Get-OverlaySkillsDir) (Join-Path $dest 'skills') $false 'skills (overlay)'
    }
    $chartersFile = Join-Path $dest 'hooks\charters.json'
    if (Test-Path -LiteralPath $chartersFile) {
        Remove-Item -LiteralPath $chartersFile -Force
        $summary.Add("charters  : $chartersFile removed (install.ps1 regenerates it from the overlay)")
    }
}

# --- 4. Plugins -------------------------------------------------------------
$summary.Add("plugins   : left installed (opt-in per session; 'claude plugin uninstall <id>' removes one)")

# --- 5. shared skills --------------------------------------------------------
$sharedSkills = Join-Path (Join-Path $env:USERPROFILE '.agents') 'skills'
Remove-CopiedFiles (Get-SharedSkillFiles) (Join-Path $repo 'skills') $sharedSkills $true 'shared'
$ovShared = @(Get-OverlaySkillFiles $true)
if ($ovShared.Count -gt 0) {
    Remove-CopiedFiles $ovShared (Get-OverlaySkillsDir) $sharedSkills $true 'shared (overlay)'
}

# --- 6. Codex ----------------------------------------------------------------
$codexHome = Join-Path $env:USERPROFILE '.codex'
$codexAgents = Join-Path $codexHome 'AGENTS.md'
if (Test-Path -LiteralPath $codexAgents) {
    $t = Read-Text $codexAgents
    $m = [regex]::Match($t, '(?s)<!--\s*agent-os:start\s*-->.*?<!--\s*agent-os:end\s*-->(\r?\n)*')
    if ($m.Success) {
        Backup-File $codexAgents | Out-Null
        $rest = $t.Substring(0, $m.Index) + $t.Substring($m.Index + $m.Length)
        if ($rest.Trim() -eq '') {
            Remove-Item -LiteralPath $codexAgents -Force
            $summary.Add("codex     : AGENTS.md removed (it held only the agent-os block)")
        }
        else {
            Write-Text $codexAgents $rest
            $summary.Add("codex     : agent-os block removed from AGENTS.md; other text kept")
        }
    }
    else {
        $summary.Add("codex     : AGENTS.md has no agent-os block")
    }
}
$codexHooks = Join-Path $codexHome 'hooks.json'
if (Test-Path -LiteralPath $codexHooks) {
    $cObj = ConvertFrom-JsonCompat (Read-Text $codexHooks)
    $removed = 0
    if (Test-Prop $cObj 'hooks') { $removed = Remove-HookEntries $cObj.hooks (Get-CodexHooksObject).hooks 'codex hook' }
    if ($removed -gt 0) {
        Backup-File $codexHooks | Out-Null
        if (@($cObj.hooks.PSObject.Properties).Count -eq 0 -and @($cObj.PSObject.Properties).Count -eq 1) {
            Remove-Item -LiteralPath $codexHooks -Force
            $summary.Add("codex     : hooks.json removed ($removed entries; nothing else was in it)")
        }
        else {
            Write-Text $codexHooks (ConvertTo-JsonCompat $cObj)
            $summary.Add("codex     : $removed hook entries removed from hooks.json; others kept")
        }
    }
}
$codexConfig = Join-Path $codexHome 'config.toml'
if (Test-Path -LiteralPath $codexConfig) {
    $cfg = Read-Text $codexConfig
    $lines = @($cfg -split "`r?`n")
    $ours = @(Get-TomlFragmentLines | ForEach-Object { $_.Trim() })
    $keepLines = @($lines | Where-Object { $ours -notcontains $_.Trim() })
    if ($keepLines.Count -ne $lines.Count) {
        Backup-File $codexConfig | Out-Null
        Write-Text $codexConfig ($keepLines -join "`n")
        $summary.Add("codex     : $($lines.Count - $keepLines.Count) config.toml key(s) removed (only lines still holding install.ps1's exact value)")
    }
}

# --- 7. Antigravity ----------------------------------------------------------
$pluginDir = Join-Path $env:USERPROFILE '.gemini\config\plugins\agent-os'
if (Test-Path -LiteralPath $pluginDir) {
    Remove-Item -LiteralPath $pluginDir -Recurse -Force
    $summary.Add("agy       : plugin folder removed ($pluginDir; install.ps1 regenerates it)")
}
$agySettings = Join-Path $env:USERPROFILE '.gemini\antigravity-cli\settings.json'
if (Test-Path -LiteralPath $agySettings) {
    $aObj = ConvertFrom-JsonCompat (Read-Text $agySettings)
    $perm = ConvertFrom-JsonCompat (Read-Text (Join-Path $repo 'targets\agy.permissions.json'))
    $pRemoved = Remove-AllowRules $aObj @($perm.permissions.allow) 'agy perm  '
    if ($pRemoved -gt 0) {
        Backup-File $agySettings | Out-Null
        Write-Text $agySettings (ConvertTo-JsonCompat $aObj)
    }
}

# --- 8. Summary -------------------------------------------------------------
Write-Host "Summary"
foreach ($line in $summary) { Write-Host "  $line" }
Write-Host ""
Write-Host "Done. New agent sessions start without the layer. /enable-global-rules or install.ps1 turns it back on."
