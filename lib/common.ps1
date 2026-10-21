# agent-os: helpers shared by install.ps1 and uninstall.ps1 (dot-sourced).
# Anything that turns a repo file into its installed form lives here, so the
# uninstaller's "is this still the file we wrote" comparison uses exactly the
# transform the installer used.
#
# The caller defines $repo, $stamp and $summary before dot-sourcing.

$script:utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# The path the repo text uses for its own checkout. It is rewritten to $repo on
# install so the checkout can live anywhere and under any folder name.
$script:canonicalRepos = @('C:\GIT\cli-agent-os')

# The owner's name when no overlay names one. Rendered wherever the repo text
# says {{OWNER}}, so a sentence reads "until the user sees it".
$script:defaultOwner = 'the user'

# Skills that only make sense inside Claude Code. They are not copied to the
# shared ~/.agents/skills folder or into the Antigravity plugin.
$script:claudeOnlySkills = @('glm-backend', 'statusline', 'workers')

# The line added to a skill's body for agents that ignore Claude Code's
# disable-model-invocation key.
$script:invocationGuard = '> Run this skill only when the user asks for it by name. Never start it on your own initiative.'

function Read-Text([string] $path) {
    return [System.IO.File]::ReadAllText($path)
}

function Write-Text([string] $path, [string] $text) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($path, $text, $script:utf8NoBom)
}

function Backup-File([string] $path) {
    $bak = "$path.bak-$stamp"
    Copy-Item -LiteralPath $path -Destination $bak -Force
    $summary.Add("backed up : $path -> $bak")
    return $bak
}

function Localize-Text([string] $text) {
    # Plain ordinal replace, no regex: neither the canonical path nor $repo may
    # be interpreted (a '$' in a path would otherwise become a group reference).
    foreach ($c in $script:canonicalRepos) {
        if ($repo -eq $c) { continue }
        $text = $text.Replace($c, $repo)
    }
    $ov = Get-OverlayDir
    $text = $text.Replace('{{OVERLAY}}', $(if ($ov) { $ov } else { $repo }))
    return $text.Replace('{{OWNER}}', (Get-OwnerName))
}

# --- overlay ---------------------------------------------------------------
# An overlay is a private folder (usually a private git repo) holding what is
# personal to one owner. install.ps1 -Overlay <dir> saves its path to
# ~/.claude/overlay.txt; install and uninstall both read it from there, so they
# render and compare files the same way. Layout, every part optional:
#   overlay.json        { "owner": "Name", "rules": "owner-rules.md",
#                         "allow": [permission rules], "charters": [...] }
#   <rules file>        appended after RULES.md for every agent
#   machines/<name>.md  machine profiles (looked up before the repo's)
#   skills/<name>/      extra skills; a name the repo already has is skipped

function Get-OverlayFile {
    return Join-Path (Join-Path $env:USERPROFILE '.claude') 'overlay.txt'
}

function Get-OverlayDir {
    $f = Get-OverlayFile
    if (-not (Test-Path -LiteralPath $f)) { return '' }
    $d = (Read-Text $f).Trim()
    if ($d -and (Test-Path -LiteralPath $d -PathType Container)) { return $d }
    return ''
}

function Get-OverlayConfig {
    $d = Get-OverlayDir
    if (-not $d) { return $null }
    $f = Join-Path $d 'overlay.json'
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    return ConvertFrom-JsonCompat (Read-Text $f)
}

function Get-OverlayValue([string] $name) {
    $cfg = Get-OverlayConfig
    if ($null -ne $cfg -and (Test-Prop $cfg $name)) { return $cfg.$name }
    return $null
}

function Get-OwnerName {
    $o = Get-OverlayValue 'owner'
    if ($o) { return [string] $o }
    return $script:defaultOwner
}

function Get-OverlayRulesPath {
    $d = Get-OverlayDir
    if (-not $d) { return '' }
    $name = Get-OverlayValue 'rules'
    if (-not $name) { $name = 'owner-rules.md' }
    $p = Join-Path $d ([string] $name)
    if (Test-Path -LiteralPath $p) { return $p }
    return ''
}

function Get-OverlayAllowRules {
    $a = Get-OverlayValue 'allow'
    if ($null -eq $a) { return @() }
    return @($a | ForEach-Object { [string] $_ })
}

function Get-ChartersText {
    # The charters.json install.ps1 writes next to compact-recharter.js, or ''
    # when the overlay registers none.
    $c = Get-OverlayValue 'charters'
    if ($null -eq $c -or @($c).Count -eq 0) { return '' }
    return (ConvertTo-Json -InputObject @($c) -Depth 20) + "`n"
}

function Get-OverlaySkillsDir {
    $d = Get-OverlayDir
    if (-not $d) { return '' }
    $s = Join-Path $d 'skills'
    if (Test-Path -LiteralPath $s -PathType Container) { return $s }
    return ''
}

function Get-OverlaySkillFiles([bool] $sharedOnly) {
    # Overlay skill files whose skill name the repo does not already have.
    # $sharedOnly drops the Claude-only skills, as for the repo's own.
    $srcDir = Get-OverlaySkillsDir
    if (-not $srcDir) { return @() }
    $repoSkills = @(Get-ChildItem -LiteralPath (Join-Path $repo 'skills') -Directory | ForEach-Object { $_.Name })
    return @(Get-ChildItem -LiteralPath $srcDir -Recurse -File | Where-Object {
        $top = ($_.FullName.Substring($srcDir.Length).TrimStart('\', '/') -split '[\\/]')[0]
        $_.Name -ne '.gitkeep' -and
        ($repoSkills -notcontains $top) -and
        (-not $sharedOnly -or $script:claudeOnlySkills -notcontains $top)
    })
}

function Add-InvocationGuard([string] $text) {
    # Only for SKILL.md text whose frontmatter sets disable-model-invocation.
    $m = [regex]::Match($text, '(?s)\A---\r?\n(.*?)\r?\n---\r?\n')
    if (-not $m.Success) { return $text }
    if ($m.Groups[1].Value -notmatch '(?m)^disable-model-invocation:\s*true\s*$') { return $text }
    if ($text.Contains($script:invocationGuard)) { return $text }
    $at = $m.Index + $m.Length
    return $text.Substring(0, $at) + "`n" + $script:invocationGuard + "`n" + $text.Substring($at)
}

function ConvertFrom-JsonCompat([string] $text) {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return $text | ConvertFrom-Json -Depth 20
    }
    return $text | ConvertFrom-Json
}

function ConvertTo-JsonCompat($obj) {
    return $obj | ConvertTo-Json -Depth 20
}

function Test-Prop($obj, [string] $name) {
    # Safe under Set-StrictMode even when the object has no properties at all
    # (an empty PSCustomObject has no .Name to enumerate).
    if ($null -eq $obj) { return $false }
    return ($null -ne $obj.PSObject.Properties[$name])
}

function Get-HookEntryKey($entry) {
    # An entry is { matcher?, hooks: [ { type, command, ... } ] }. Two entries
    # are the same when their matcher and their ordered command list match.
    $matcher = ''
    if (Test-Prop $entry 'matcher') { $matcher = [string] $entry.matcher }
    $cmds = @()
    if (Test-Prop $entry 'hooks') {
        $cmds = @($entry.hooks | ForEach-Object { [string] $_.command })
    }
    return ($matcher + '::' + ($cmds -join ' || '))
}

function Get-RenderedRules([string] $target) {
    # The installed rules for one agent: its preamble (tool names), then the
    # canonical RULES.md, then the overlay's rules file if there is one, all
    # with the checkout path and placeholders localized.
    # Not targets\claude.md: on Windows that name is a nested CLAUDE.md, which
    # Claude Code loads as project instructions for anything under targets\.
    $pre = Read-Text (Join-Path $repo "targets\$target.preamble.md")
    $rules = Read-Text (Join-Path $repo 'RULES.md')
    $text = $pre.TrimEnd() + "`n`n" + $rules.TrimEnd()
    $ownerRules = Get-OverlayRulesPath
    if ($ownerRules) { $text += "`n`n" + (Read-Text $ownerRules).TrimEnd() }
    return (Localize-Text $text).TrimEnd()
}

function Get-MachineName {
    $f = Join-Path (Join-Path $env:USERPROFILE '.claude') 'machine.txt'
    if (Test-Path -LiteralPath $f) { return (Read-Text $f).Trim() }
    return ''
}

function Get-MachineProfilePath([string] $name) {
    # The overlay's profile wins; the repo ships only a template and the test
    # fixture, but a profile kept in the repo still works without an overlay.
    if (-not $name) { return '' }
    $roots = @()
    $ov = Get-OverlayDir
    if ($ov) { $roots += $ov }
    $roots += $repo
    foreach ($r in $roots) {
        $p = Join-Path (Join-Path $r 'machines') ($name + '.md')
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return ''
}

function Get-InstalledSkillText([System.IO.FileInfo] $file, [bool] $shared) {
    # The text install.ps1 writes for one skill .md file. Claude Code honours
    # disable-model-invocation, so only shared copies get the guard line.
    $t = Localize-Text (Read-Text $file.FullName)
    if ($shared -and $file.Name -ieq 'SKILL.md') { $t = Add-InvocationGuard $t }
    return $t
}

function Get-SharedSkillFiles {
    # Repo skill files that belong in agent-neutral locations.
    $srcDir = Join-Path $repo 'skills'
    return @(Get-ChildItem -LiteralPath $srcDir -Recurse -File | Where-Object {
        $_.Name -ne '.gitkeep' -and
        ($script:claudeOnlySkills -notcontains (($_.FullName.Substring($srcDir.Length).TrimStart('\', '/') -split '[\\/]')[0]))
    })
}

function Get-AgentHookFiles {
    # Hook scripts a non-Claude agent runs (no tests).
    return @(Get-ChildItem -LiteralPath (Join-Path $repo 'hooks') -File -Filter '*.js' | Where-Object { $_.Name -notlike '*.test.js' })
}

function Get-CodexHooksObject {
    # The repo's Claude hooks, re-pointed for Codex: same events, matchers and
    # commands (Codex canonicalizes its shell tool to Bash and aliases
    # apply_patch as Edit|Write), plus commandWindows with the absolute
    # forward-slash path so Windows needs no $HOME expansion.
    $src = ConvertFrom-JsonCompat (Read-Text (Join-Path $repo 'settings.json'))
    $homeFwd = ($env:USERPROFILE -replace '\\', '/')
    foreach ($ev in $src.hooks.PSObject.Properties) {
        foreach ($entry in @($ev.Value)) {
            foreach ($h in @($entry.hooks)) {
                $win = ([string] $h.command).Replace('$HOME', $homeFwd)
                $h | Add-Member -NotePropertyName 'commandWindows' -NotePropertyValue $win -Force
            }
        }
    }
    return [pscustomobject]@{ hooks = $src.hooks }
}

function Get-TomlFragmentLines {
    # key = value lines from targets/codex.config.toml, comments dropped.
    $lines = (Read-Text (Join-Path $repo 'targets\codex.config.toml')) -split "`r?`n"
    return @($lines | Where-Object { $_ -match '^\s*[A-Za-z0-9_]+\s*=' })
}

function Get-AgyHooksObject {
    return [pscustomobject]@{
        'agent-os' = [pscustomobject]@{
            PreToolUse = @(
                [pscustomobject]@{
                    matcher = '*'
                    hooks   = @([pscustomobject]@{ type = 'command'; command = 'node hooks/agy-hook.js PreToolUse'; timeout = 30 })
                }
            )
            Stop       = @(
                [pscustomobject]@{ type = 'command'; command = 'node hooks/agy-hook.js Stop'; timeout = 30 }
            )
        }
    }
}
