#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the agent-os user-level layer (rules, machine profile, hooks,
  skills, permissions) for each coding agent on this machine.

.DESCRIPTION
  Idempotent; safe to run after every `git pull`. Works under Windows
  PowerShell 5.1 and PowerShell 7. The canonical rules are RULES.md; each
  agent gets them with its own preamble (targets/<agent>.preamble.md) naming its tools.

  Claude Code (always), into %USERPROFILE%\.claude:
  1. CLAUDE.md    : preamble + RULES.md written between <!-- claude-os:start -->
                    and <!-- claude-os:end --> (the marker keeps its old name
                    for one release: the banner canary and status line on
                    every machine key on it). If the destination already has
                    that marker pair, only the block is replaced and every
                    line outside it is kept. A file with no markers is a first
                    install: it is backed up and replaced, except that a
                    hand-written <!-- local:start --> ... <!-- local:end -->
                    block and wmux's <!-- wmux:start --> ... <!-- wmux:end -->
                    section are preserved and re-appended.
  1b. machine profile: when a machine name is known (-Machine now, or
                    ~/.claude/machine.txt from an earlier run) and
                    machines/<name>.md exists in the repo, an @import of that
                    file is kept right after the end marker between
                    <!-- claude-os-machine:start --> and
                    <!-- claude-os-machine:end -->.
  2. settings.json: the repo's "hooks" key is deep-merged into the existing
                    file (entries appended per event, duplicates skipped), and
                    the repo's "permissions.allow" rules are appended when
                    missing. Every other key is left alone. Backed up first.
  3. hooks/, skills/, agents/: copied over. Never mirrors, never deletes local
                    extras.
  4. Plugins       : each entry in $plugins below is installed through the
                    `claude plugin` CLI if not already enabled.

  Shared (always):
  5. ~/.agents/skills: the skills every non-Claude agent reads (Codex,
                    DeepCode, Gemini, Copilot, Cursor, OpenCode). Claude Code
                    2.1.286 does not read this folder (H2 in
                    docs/agent-os-spike.md), hence step 3 as well. Claude-only
                    skills are skipped; skills that rely on
                    disable-model-invocation get a "only when asked by name"
                    line, because other agents ignore that key.

  Codex CLI (-Agents codex, or auto when ~/.codex exists):
  6a. ~/.codex/AGENTS.md: preamble + RULES.md + the machine profile inlined
                    (Codex has no @import) between <!-- agent-os:start --> and
                    <!-- agent-os:end -->. Text outside the block is kept.
  6b. ~/.codex/hooks.json: the same hook entries as settings.json, with a
                    commandWindows form of each command; merged like step 2.
                    Codex skips new or changed hooks until they are trusted
                    with /hooks in its TUI, so the summary says when to do it.
  6c. ~/.codex/config.toml: the top-level keys in targets/codex.config.toml
                    are added when absent (project CLAUDE.md fallback, larger
                    project-doc cap). A value already there wins.

  Antigravity CLI (-Agents agy, or auto when ~/.gemini/antigravity-cli exists):
  7a. ~/.gemini/config/plugins/agent-os/: plugin.json, rules/AGENTS.md
                    (preamble + RULES.md), rules/machine-profile.md (agy caps
                    each rule file at 24,000 bytes and the two together pass
                    it), hooks.json with hooks/agy-hook.js adapting the Claude
                    hooks, and the shared skills. The folder is generated:
                    every file in it is rewritten on each run.
  7b. ~/.gemini/antigravity-cli/settings.json: permissions.allow rules from
                    targets/agy.permissions.json appended when missing.

  8. Prints a summary.

  Nothing machine-specific or personal lives in this repo; paths derive from
  $env:USERPROFILE at run time. The repo text names its own checkout as
  C:\GIT\cli-agent-os; every copy of that literal in rules and skill .md files
  is rewritten to this script's actual folder, {{OWNER}} to the overlay's
  owner name (default "the user") and {{OVERLAY}} to the overlay folder (this
  repo when there is none).

  Overlay (-Overlay, remembered in ~/.claude/overlay.txt): a private folder
  with what is personal to one owner. Its overlay.json names the owner, its
  rules file (default owner-rules.md) is appended after RULES.md, its
  machines/ profiles are found before the repo's, its skills/ are installed
  beside the repo's (a name the repo has is skipped), its "allow" rules join
  step 2, and its "charters" become ~/.claude/hooks/charters.json for
  compact-recharter.js. See lib/common.ps1 for the layout.

  uninstall.ps1 reverses steps 1 to 3 and 5 to 7.

.PARAMETER SkipPlugins
  Skip step 4. Used by install.test.ps1, which points USERPROFILE at a
  scratch folder and must not let the claude CLI touch the real settings.

.PARAMETER Machine
  This machine's discipline name (main-desktop, home-server, dba, data-eng).
  Saved to ~/.claude/machine.txt so later runs remember it.

.PARAMETER Agents
  Which non-Claude agents to install for: codex, agy (comma list or array).
  Claude Code and the shared skills are always installed. Default: every
  agent whose home folder exists on this machine.

.PARAMETER Overlay
  The owner's private overlay folder. Saved to ~/.claude/overlay.txt so later
  runs remember it. 'none' forgets the saved one.
#>
[CmdletBinding()]
param(
    [switch] $SkipPlugins,
    [string] $Machine,
    [string[]] $Agents,
    [string] $Overlay
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$dest = Join-Path $env:USERPROFILE '.claude'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = New-Object System.Collections.Generic.List[string]
. (Join-Path $repo 'lib\common.ps1')

# Plugins that belong on every machine. id is what enabledPlugins records.
$plugins = @(
    @{ id = 'i-have-adhd@i-have-adhd'; marketplace = 'ayghri/i-have-adhd'; install = 'i-have-adhd@i-have-adhd' }
)

$codexHome = Join-Path $env:USERPROFILE '.codex'
$geminiHome = Join-Path $env:USERPROFILE '.gemini'
$agyCliHome = Join-Path $geminiHome 'antigravity-cli'

if ($null -eq $Agents -or $Agents.Count -eq 0) {
    $Agents = @()
    if (Test-Path -LiteralPath $codexHome) { $Agents += 'codex' }
    if (Test-Path -LiteralPath $agyCliHome) { $Agents += 'agy' }
}
else {
    # 'claude' is accepted and ignored: Claude Code is always installed.
    $Agents = @($Agents | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -and $_ -ne 'claude' })
}
foreach ($a in $Agents) {
    if (@('codex', 'agy') -notcontains $a) { throw "Unknown agent '$a'. Known: codex, agy (Claude Code is always installed)." }
}

function Merge-HookEntries($dstHooks, $srcHooks, [string] $label) {
    # Appends each src entry to dst per event unless an entry with the same key
    # is already there. Returns the number added.
    $added = 0
    foreach ($eventProp in $srcHooks.PSObject.Properties) {
        $event = $eventProp.Name
        if (-not (Test-Prop $dstHooks $event)) {
            $dstHooks | Add-Member -NotePropertyName $event -NotePropertyValue @()
        }
        $existing = @($dstHooks.$event)
        $existingKeys = @($existing | ForEach-Object { Get-HookEntryKey $_ })
        foreach ($entry in @($eventProp.Value)) {
            $key = Get-HookEntryKey $entry
            if ($existingKeys -contains $key) {
                $summary.Add("$label : already present, skipped ($event / $key)")
            }
            else {
                $existing += $entry
                $existingKeys += $key
                $added++
                $summary.Add("$label : merged ($event / $key)")
            }
        }
        $dstHooks.$event = [object[]] $existing
    }
    return $added
}

function Merge-AllowRules($dstObj, [object[]] $rules, [string] $label) {
    if (-not (Test-Prop $dstObj 'permissions')) {
        $dstObj | Add-Member -NotePropertyName 'permissions' -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not (Test-Prop $dstObj.permissions 'allow')) {
        $dstObj.permissions | Add-Member -NotePropertyName 'allow' -NotePropertyValue @()
    }
    $allow = @(@($dstObj.permissions.allow) | ForEach-Object { [string] $_ })
    $added = 0
    foreach ($rule in $rules) {
        $ruleText = [string] $rule
        if ($allow -contains $ruleText) {
            $summary.Add("$label : already present, skipped ($ruleText)")
        }
        else {
            $allow += $ruleText
            $added++
            $summary.Add("$label : allowed ($ruleText)")
        }
    }
    $dstObj.permissions.allow = [object[]] $allow
    return $added
}

function Set-MarkerBlock([string] $path, [string] $tag, [string] $body) {
    # Writes <!-- tag:start --> body <!-- tag:end --> into $path: replaced in
    # place when present, otherwise put first with any existing text after it.
    $start = "<!-- ${tag}:start -->"
    $end = "<!-- ${tag}:end -->"
    $block = $start + "`n" + $body.TrimEnd() + "`n" + $end
    $old = ''
    if (Test-Path -LiteralPath $path) { $old = Read-Text $path }
    $m = [regex]::Match($old, "(?s)<!--\s*$([regex]::Escape($tag)):start\s*-->.*?<!--\s*$([regex]::Escape($tag)):end\s*-->")
    if ($m.Success) {
        $new = $old.Substring(0, $m.Index) + $block + $old.Substring($m.Index + $m.Length)
    }
    elseif ($old.Trim() -eq '') {
        $new = $block + "`n"
    }
    else {
        $new = $block + "`n`n" + $old
    }
    if ($new -eq $old) { return 'unchanged' }
    if (Test-Path -LiteralPath $path) { Backup-File $path | Out-Null }
    Write-Text $path $new
    if ($m.Success) { return 'block replaced; text outside the markers kept' }
    return 'block written'
}

function Copy-Files([object[]] $files, [string] $srcDir, [string] $dstDir, [bool] $shared) {
    $copied = 0
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($srcDir.Length).TrimStart('\', '/')
        $target = Join-Path $dstDir $rel
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        if ($f.Extension -ieq '.md') {
            Write-Text $target (Get-InstalledSkillText $f $shared)
        }
        else {
            Copy-Item -LiteralPath $f.FullName -Destination $target -Force
        }
        $copied++
    }
    return $copied
}

# ---------------------------------------------------------------------------
if ($Overlay) {
    $overlayFile = Get-OverlayFile
    if ($Overlay -eq 'none') {
        if (Test-Path -LiteralPath $overlayFile) { Remove-Item -LiteralPath $overlayFile -Force }
        $summary.Add("overlay   : forgotten (no overlay)")
    }
    else {
        if (-not (Test-Path -LiteralPath $Overlay -PathType Container)) { throw "Overlay folder '$Overlay' does not exist." }
        $full = (Resolve-Path -LiteralPath $Overlay).ProviderPath.TrimEnd('\')
        Write-Text $overlayFile ($full + "`n")
        $summary.Add("overlay   : path saved to $overlayFile ($full)")
    }
}
$overlayDir = Get-OverlayDir

Write-Host "agent-os install"
Write-Host "  repo  : $repo"
Write-Host "  overlay: $(if ($overlayDir) { "$overlayDir (owner: $(Get-OwnerName))" } else { 'none' })"
Write-Host "  agents: claude$(if ($Agents.Count) { ', ' + ($Agents -join ', ') })"
Write-Host "  shell : PowerShell $($PSVersionTable.PSVersion)"
Write-Host ""

if (-not (Test-Path -LiteralPath $dest)) {
    New-Item -ItemType Directory -Path $dest | Out-Null
    $summary.Add("created   : $dest")
}

# --- 1. CLAUDE.md -----------------------------------------------------------
# The repo content lives between the claude-os markers. Text outside them is
# machine-local and survives every install and uninstall. uninstall.ps1 leaves
# the pair in place but empty, which is how a later install knows to keep the
# local text instead of treating the file as a first install.
$startMarker = '<!-- claude-os:start -->'
$endMarker = '<!-- claude-os:end -->'
$blockRegex = '(?s)<!--\s*claude-os:start\s*-->.*?<!--\s*claude-os:end\s*-->'
$dstClaude = Join-Path $dest 'CLAUDE.md'
$block = $startMarker + "`n" + (Get-RenderedRules 'claude') + "`n" + $endMarker
$claudeBackedUp = $false

if (Test-Path -LiteralPath $dstClaude) {
    $dstText = Read-Text $dstClaude
    $m = [regex]::Match($dstText, $blockRegex)
    if ($m.Success) {
        # Splice the new block over the old one; no regex replacement string,
        # so '$' characters in the rules never get interpreted as group refs.
        $newText = $dstText.Substring(0, $m.Index) + $block + $dstText.Substring($m.Index + $m.Length)
        $how = 'block replaced; text outside the markers kept'
    }
    else {
        # First install (or a file from an install.ps1 older than the
        # markers). Blocks that belong to this machine, not to the repo,
        # survive the replace; everything else is dropped and the backup
        # keeps it.
        $kept = @()
        $keptNames = @()
        foreach ($tag in @('local', 'wmux')) {
            $k = [regex]::Match($dstText, "(?s)<!--\s*${tag}:start.*?<!--\s*${tag}:end\s*-->")
            if ($k.Success) {
                $kept += $k.Value
                $keptNames += $tag
            }
        }
        $newText = $block + "`n"
        if ($kept.Count -gt 0) {
            $newText = $block + "`n`n" + ($kept -join "`n`n") + "`n"
        }
        $how = 'no markers found, file replaced'
        if ($kept.Count -gt 0) { $how += '; preserved block(s): ' + ($keptNames -join ', ') }
    }

    if ($dstText -ne $newText) {
        Backup-File $dstClaude | Out-Null
        $claudeBackedUp = $true
        $oldLines = $dstText -split "`r?`n"
        $newLines = $newText -split "`r?`n"
        $diff = @(Compare-Object -ReferenceObject $oldLines -DifferenceObject $newLines)
        $added = @($diff | Where-Object { $_.SideIndicator -eq '=>' }).Count
        $removed = @($diff | Where-Object { $_.SideIndicator -eq '<=' }).Count
        Write-Text $dstClaude $newText
        $summary.Add("CLAUDE.md : $how (+$added / -$removed lines)")
    }
    else {
        $summary.Add("CLAUDE.md : unchanged")
    }
}
else {
    Write-Text $dstClaude ($block + "`n")
    $summary.Add("CLAUDE.md : written (no previous file)")
}

# --- 1b. machine profile import --------------------------------------------
$machineFile = Join-Path $dest 'machine.txt'
if ($Machine) {
    Write-Text $machineFile ($Machine.Trim() + "`n")
    $summary.Add("machine   : name saved to $machineFile ($($Machine.Trim()))")
}
$machineName = Get-MachineName
$profilePath = Get-MachineProfilePath $machineName
$mStart = '<!-- claude-os-machine:start -->'
$mEnd = '<!-- claude-os-machine:end -->'
$mRegex = '(?s)<!--\s*claude-os-machine:start\s*-->.*?<!--\s*claude-os-machine:end\s*-->'

if ($machineName -eq '') {
    $summary.Add("machine   : no name set; run install.ps1 -Machine <name> to import machines/<name>.md")
}
elseif ($profilePath -eq '') {
    $summary.Add("machine   : '$machineName' has no profile in $(Join-Path $repo 'machines'); nothing imported")
}
else {
    $importPath = $profilePath -replace '\\', '/'
    $mBlock = $mStart + "`n# Machine profile: $machineName`n@" + $importPath + "`n" + $mEnd
    $cur = Read-Text $dstClaude
    $mm = [regex]::Match($cur, $mRegex)
    if ($mm.Success) {
        $new = $cur.Substring(0, $mm.Index) + $mBlock + $cur.Substring($mm.Index + $mm.Length)
    }
    else {
        $endIdx = $cur.IndexOf($endMarker)
        if ($endIdx -lt 0) { throw "claude-os end marker missing from $dstClaude after step 1" }
        $insertAt = $endIdx + $endMarker.Length
        $new = $cur.Substring(0, $insertAt) + "`n`n" + $mBlock + $cur.Substring($insertAt)
    }
    if ($cur -ne $new) {
        if (-not $claudeBackedUp) { Backup-File $dstClaude | Out-Null; $claudeBackedUp = $true }
        Write-Text $dstClaude $new
        $summary.Add("machine   : profile import written ($machineName -> $importPath)")
    }
    else {
        $summary.Add("machine   : profile import unchanged ($machineName)")
    }
}

# --- 2. settings.json (merge hooks and permissions.allow) ------------------
$srcSettings = Join-Path $repo 'settings.json'
$dstSettings = Join-Path $dest 'settings.json'
$srcObj = ConvertFrom-JsonCompat (Read-Text $srcSettings)

if (Test-Path -LiteralPath $dstSettings) {
    $dstObj = ConvertFrom-JsonCompat (Read-Text $dstSettings)
    if (-not (Test-Prop $dstObj 'hooks')) {
        $dstObj | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
    }
    $merged = Merge-HookEntries $dstObj.hooks $srcObj.hooks 'hook      '
    # permissions.allow: the repo's allow rules are appended when missing, so a
    # command the auto-mode classifier keeps refusing (the release publish,
    # three times so far) is pre-approved on every machine.
    $allowAdded = 0
    if ((Test-Prop $srcObj 'permissions') -and (Test-Prop $srcObj.permissions 'allow')) {
        $allowAdded = Merge-AllowRules $dstObj @($srcObj.permissions.allow) 'permission'
    }
    $ovAllow = @(Get-OverlayAllowRules)
    if ($ovAllow.Count -gt 0) {
        $allowAdded += Merge-AllowRules $dstObj $ovAllow 'permission (overlay)'
    }
    if ($merged -gt 0 -or $allowAdded -gt 0) {
        Backup-File $dstSettings | Out-Null
        Write-Text $dstSettings (ConvertTo-JsonCompat $dstObj)
        $summary.Add("settings  : $merged hook entr$(if ($merged -eq 1) { 'y' } else { 'ies' }) and $allowAdded permission rule(s) added; other keys untouched")
    }
    else {
        $summary.Add("settings  : unchanged (every hook entry and permission rule already present)")
    }
}
else {
    $ovAllow = @(Get-OverlayAllowRules)
    if ($ovAllow.Count -gt 0) {
        $added = Merge-AllowRules $srcObj $ovAllow 'permission (overlay)'
        Write-Text $dstSettings (ConvertTo-JsonCompat $srcObj)
        $summary.Add("settings  : written from the repo plus $added overlay permission rule(s) (no previous file)")
    }
    else {
        Copy-Item -LiteralPath $srcSettings -Destination $dstSettings
        $summary.Add("settings  : copied (no previous file)")
    }
}

# --- 3. hooks/, skills/, agents/ -------------------------------------------
foreach ($dir in @('hooks', 'skills', 'agents')) {
    $srcDir = Join-Path $repo $dir
    $dstDir = Join-Path $dest $dir
    if (-not (Test-Path -LiteralPath $srcDir)) { continue }
    if (-not (Test-Path -LiteralPath $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir | Out-Null
    }
    $files = @(Get-ChildItem -LiteralPath $srcDir -Recurse -File | Where-Object { $_.Name -ne '.gitkeep' })
    $copied = Copy-Files $files $srcDir $dstDir $false
    $summary.Add("$($dir.PadRight(9)) : $copied file(s) copied to $dstDir (local extras kept)")
}
$ovSkills = @(Get-OverlaySkillFiles $false)
if ($ovSkills.Count -gt 0) {
    $copied = Copy-Files $ovSkills (Get-OverlaySkillsDir) (Join-Path $dest 'skills') $false
    $summary.Add("skills    : $copied overlay skill file(s) copied")
}
# charters.json is generated from the overlay; nothing else writes it.
$chartersFile = Join-Path $dest 'hooks\charters.json'
$chartersText = Get-ChartersText
if ($chartersText) {
    Write-Text $chartersFile $chartersText
    $summary.Add("charters  : $chartersFile written from the overlay")
}
elseif (Test-Path -LiteralPath $chartersFile) {
    Remove-Item -LiteralPath $chartersFile -Force
    $summary.Add("charters  : $chartersFile removed (the overlay registers none)")
}

# --- 4. Plugins -------------------------------------------------------------
# Runs after the settings merge so the claude CLI edits the final file.
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($SkipPlugins) {
    $summary.Add("plugins   : skipped (-SkipPlugins)")
}
elseif ($null -eq $claudeCmd) {
    $summary.Add("plugins   : 'claude' not found on PATH; skipped ($($plugins.Count) plugin(s) to install by hand)")
}
else {
    $enabled = @{}
    if (Test-Path -LiteralPath $dstSettings) {
        $cur = ConvertFrom-JsonCompat (Read-Text $dstSettings)
        if (Test-Prop $cur 'enabledPlugins') {
            foreach ($p in $cur.enabledPlugins.PSObject.Properties) { $enabled[$p.Name] = [bool] $p.Value }
        }
    }
    foreach ($plugin in $plugins) {
        if ($enabled.ContainsKey($plugin.id) -and $enabled[$plugin.id]) {
            $summary.Add("plugin    : already enabled, skipped ($($plugin.id))")
            continue
        }
        $out1 = & $claudeCmd.Source plugin marketplace add $plugin.marketplace 2>&1
        $rc1 = $LASTEXITCODE
        $out2 = & $claudeCmd.Source plugin install $plugin.install 2>&1
        $rc2 = $LASTEXITCODE
        if ($rc1 -eq 0 -and $rc2 -eq 0) {
            $summary.Add("plugin    : installed ($($plugin.id))")
        }
        else {
            $summary.Add("plugin    : FAILED ($($plugin.id)); marketplace add exit $rc1, install exit $rc2")
            $summary.Add("            " + (($out1 + $out2 | Out-String).Trim() -replace "`r?`n", ' | '))
        }
    }
}

# --- 5. shared skills (~/.agents/skills) ------------------------------------
$sharedSkills = Join-Path (Join-Path $env:USERPROFILE '.agents') 'skills'
$copied = Copy-Files (Get-SharedSkillFiles) (Join-Path $repo 'skills') $sharedSkills $true
$ovShared = @(Get-OverlaySkillFiles $true)
if ($ovShared.Count -gt 0) { $copied += Copy-Files $ovShared (Get-OverlaySkillsDir) $sharedSkills $true }
$summary.Add("shared    : $copied skill file(s) copied to $sharedSkills (Claude-only skills skipped: $($script:claudeOnlySkills -join ', '))")

# --- 6. Codex CLI -----------------------------------------------------------
if ($Agents -contains 'codex') {
    if (-not (Test-Path -LiteralPath $codexHome)) { New-Item -ItemType Directory -Path $codexHome | Out-Null }

    # 6a. rules + inlined machine profile
    $body = Get-RenderedRules 'codex'
    if ($profilePath -ne '') {
        $body += "`n`n# Machine profile: $machineName`n`n" + (Localize-Text (Read-Text $profilePath)).TrimEnd()
    }
    $codexAgents = Join-Path $codexHome 'AGENTS.md'
    $how = Set-MarkerBlock $codexAgents 'agent-os' $body
    $bytes = [System.Text.Encoding]::UTF8.GetByteCount($body)
    $summary.Add("codex     : AGENTS.md $how ($bytes bytes$(if ($profilePath) { ", profile '$machineName' inlined" } else { ', no machine profile' }))")

    # 6b. hooks.json
    $codexHooks = Join-Path $codexHome 'hooks.json'
    $srcHooks = (Get-CodexHooksObject).hooks
    if (Test-Path -LiteralPath $codexHooks) {
        $cObj = ConvertFrom-JsonCompat (Read-Text $codexHooks)
        if (-not (Test-Prop $cObj 'hooks')) { $cObj | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{}) }
        $added = Merge-HookEntries $cObj.hooks $srcHooks 'codex hook'
        if ($added -gt 0) {
            Backup-File $codexHooks | Out-Null
            Write-Text $codexHooks (ConvertTo-JsonCompat $cObj)
        }
    }
    else {
        $added = 0
        foreach ($ev in $srcHooks.PSObject.Properties) { $added += @($ev.Value).Count }
        Write-Text $codexHooks (ConvertTo-JsonCompat ([pscustomobject]@{ hooks = $srcHooks }))
    }
    if ($added -gt 0) {
        $summary.Add("codex     : $added hook entr$(if ($added -eq 1) { 'y' } else { 'ies' }) written to $codexHooks. ACTION: open codex, run /hooks and trust them; Codex skips untrusted hooks silently")
    }
    else {
        $summary.Add("codex     : hooks.json unchanged")
    }

    # 6c. config.toml top-level keys
    $codexConfig = Join-Path $codexHome 'config.toml'
    $cfg = ''
    if (Test-Path -LiteralPath $codexConfig) { $cfg = Read-Text $codexConfig }
    $firstTable = [regex]::Match($cfg, '(?m)^\s*\[')
    $topLevel = if ($firstTable.Success) { $cfg.Substring(0, $firstTable.Index) } else { $cfg }
    $missing = @()
    foreach ($line in (Get-TomlFragmentLines)) {
        $key = ($line -split '=')[0].Trim()
        if ($topLevel -match "(?m)^\s*$([regex]::Escape($key))\s*=") {
            $summary.Add("codex     : config.toml already sets $key; left as is")
        }
        else {
            $missing += $line.Trim()
        }
    }
    if ($missing.Count -gt 0) {
        if (Test-Path -LiteralPath $codexConfig) { Backup-File $codexConfig | Out-Null }
        # Top-level keys must come before the first [table]; put them first.
        Write-Text $codexConfig (($missing -join "`n") + "`n" + $cfg)
        $summary.Add("codex     : config.toml keys added: " + (($missing | ForEach-Object { ($_ -split '=')[0].Trim() }) -join ', '))
    }
    $summary.Add("codex     : skills come from $sharedSkills (step 5); Codex has no per-command allowlist, so no permissions are written")
}
else {
    $summary.Add("codex     : skipped (no ~/.codex; pass -Agents codex to force)")
}

# --- 7. Antigravity CLI (agy) -----------------------------------------------
if ($Agents -contains 'agy') {
    $pluginDir = Join-Path $geminiHome 'config\plugins\agent-os'
    Write-Text (Join-Path $pluginDir 'plugin.json') (ConvertTo-JsonCompat ([pscustomobject]@{
        name        = 'agent-os'
        description = "agent-os layer: global rules, machine profile, guard hooks and shared skills. Generated by install.ps1 from the cli-agent-os repo; edit the repo, not this folder."
    }))
    $rules = Get-RenderedRules 'agy'
    Write-Text (Join-Path $pluginDir 'rules\AGENTS.md') ($rules + "`n")
    $ruleBytes = [System.Text.Encoding]::UTF8.GetByteCount($rules)
    $profFile = Join-Path $pluginDir 'rules\machine-profile.md'
    $profNote = 'no machine profile'
    if ($profilePath -ne '') {
        $profText = "# Machine profile: $machineName`n`n" + (Localize-Text (Read-Text $profilePath)).TrimEnd()
        Write-Text $profFile ($profText + "`n")
        $profNote = "profile '$machineName' $([System.Text.Encoding]::UTF8.GetByteCount($profText)) bytes"
    }
    elseif (Test-Path -LiteralPath $profFile) {
        Remove-Item -LiteralPath $profFile -Force
    }
    if ($ruleBytes -gt 24000) {
        $summary.Add("agy       : WARNING rules/AGENTS.md is $ruleBytes bytes; agy truncates rule files past 24,000 bytes")
    }
    Write-Text (Join-Path $pluginDir 'hooks.json') (ConvertTo-JsonCompat (Get-AgyHooksObject))
    $hookCount = Copy-Files (Get-AgentHookFiles) (Join-Path $repo 'hooks') (Join-Path $pluginDir 'hooks') $true
    $skillCount = Copy-Files (Get-SharedSkillFiles) (Join-Path $repo 'skills') (Join-Path $pluginDir 'skills') $true
    if ($ovShared.Count -gt 0) { $skillCount += Copy-Files $ovShared (Get-OverlaySkillsDir) (Join-Path $pluginDir 'skills') $true }
    $summary.Add("agy       : plugin written to $pluginDir (rules $ruleBytes bytes, $profNote, $hookCount hook script(s), $skillCount skill file(s)); agy loads a new plugin folder on its next start")

    # 7b. permissions
    $agySettings = Join-Path $agyCliHome 'settings.json'
    $perm = ConvertFrom-JsonCompat (Read-Text (Join-Path $repo 'targets\agy.permissions.json'))
    if (Test-Path -LiteralPath $agySettings) {
        $aObj = ConvertFrom-JsonCompat (Read-Text $agySettings)
    }
    else {
        $aObj = [pscustomobject]@{}
    }
    $pAdded = Merge-AllowRules $aObj @($perm.permissions.allow) 'agy perm  '
    if ($pAdded -gt 0) {
        if (Test-Path -LiteralPath $agySettings) { Backup-File $agySettings | Out-Null }
        Write-Text $agySettings (ConvertTo-JsonCompat $aObj)
    }
    $summary.Add("agy       : $pAdded permission rule(s) added to $agySettings")
}
else {
    $summary.Add("agy       : skipped (no ~/.gemini/antigravity-cli; pass -Agents agy to force)")
}

# --- 8. Summary -------------------------------------------------------------
Write-Host "Summary"
foreach ($line in $summary) { Write-Host "  $line" }
Write-Host ""
# Codex and agy hold inlined copies of RULES.md and the machine profile, so
# they only see edits made before this run. Say so every time.
if ($summary | Where-Object { $_ -match '^(codex     : AGENTS\.md|agy       : plugin written)' }) {
    Write-Host "NOTE: Codex and agy got RULES.md and the machine profile inlined as of now."
    Write-Host "      Any later edit to either (or a git pull that brings one) needs install.ps1 again;"
    Write-Host "      Claude Code's @import picks edits up on its own."
    if ($summary | Where-Object { $_ -match '^codex     : \d+ hook entries written' }) {
        Write-Host "      Codex hooks.json changed this run: re-trust the hooks in Codex /hooks, or Codex skips them silently."
    }
    Write-Host ""
}
Write-Host "Done. New agent sessions pick up the layer; start a new session to be sure."
