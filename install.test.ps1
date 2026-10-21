#Requires -Version 5.1
<#
.SYNOPSIS
  Exercises install.ps1 and uninstall.ps1 against a scratch home folder.

.DESCRIPTION
  Points USERPROFILE at a temp folder for the duration of the run, so the real
  ~/.claude is never touched, then walks the toggle round trip:

    1. fresh install into an empty home
    2. reinstall with machine-local text, a wmux block and a wmux hook present
    3. uninstall: block emptied, local text and wmux kept, guard hook gone,
       guard file gone, toggle skills kept
    4. reinstall after uninstall: rules back, local text still there
    5. legacy file with no markers: backed up and replaced, wmux kept
    6. uninstall twice in a row: second run is a no-op and does not error
    7. machine profile import: nothing without a name, block written once
       with -Machine, remembered across runs, removed by uninstall, back on
       reinstall, unknown name leaves things alone
    8. Codex and Antigravity targets: rules block, inlined profile, hooks,
       config keys, plugin folder and permissions written once, idempotent,
       user text and user values kept, all of it reversed by uninstall
    9. shared skills in ~/.agents/skills: Claude-only skills skipped, the
       invocation guard added to shared copies only
   10. overlay: owner rules appended, {{OWNER}} and {{OVERLAY}} rendered,
       overlay profile, allow rules, skills and charters installed once,
       remembered, reversed by uninstall, forgotten with -Overlay none

  Exit code 0 when every check passes, 1 otherwise.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-os-test-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$claudeDir = Join-Path $scratch '.claude'
$claudeMd = Join-Path $claudeDir 'CLAUDE.md'
$settings = Join-Path $claudeDir 'settings.json'
$guardJs = Join-Path $claudeDir 'hooks\no-shell-edits.js'
$enableSkill = Join-Path $claudeDir 'skills\enable-global-rules\SKILL.md'
$disableSkill = Join-Path $claudeDir 'skills\disable-global-rules\SKILL.md'
$fixture = Join-Path $repo 'machines\_test-fixture.md'

$script:fails = 0
$script:passes = 0

function Assert([bool] $cond, [string] $name) {
    if ($cond) { $script:passes++; Write-Host "  PASS  $name" }
    else { $script:fails++; Write-Host "  FAIL  $name" }
}

function Count-Matches([string] $text, [string] $pattern) {
    return ([regex]::Matches($text, $pattern)).Count
}

function Read-Text([string] $path) { return [System.IO.File]::ReadAllText($path) }
function Write-Text([string] $path, [string] $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Run-Install { & (Join-Path $repo 'install.ps1') -SkipPlugins | Out-Null }
function Run-Uninstall { & (Join-Path $repo 'uninstall.ps1') | Out-Null }

$rulesSentinel = "# Global rules for coding agents"
$localText = "# Machine-local rule`n`nThis line is not from the repo and must survive.`n"
$wmuxBlock = "<!-- wmux:start -->`nwmux managed text`n<!-- wmux:end -->"
$guardPattern = 'no-shell-edits\.js'
$emDashPattern = 'no-em-dash\.js'
$notesPattern = 'notes-stop\.js'
$notesJs = Join-Path $claudeDir 'hooks\notes-stop.js'
$claimsPattern = 'claims-stop\.js'
$claimsJs = Join-Path $claudeDir 'hooks\claims-stop.js'
# One pattern for the pair of publish rules in settings.json: the exact one and
# the prefix one share this text, so "present once" means the pair, not each.
$allowPattern = 'Bash\(npm run publish:release:\*\)'
$localAllowRule = 'Bash(local-only-tool:*)'
$autoModePattern = 'orchestrating or head session carries'
$localBlock = "<!-- local:start -->`n@import C:/local/machine-notes.md`n<!-- local:end -->"
$startPattern = '<!--\s*claude-os:start\s*-->'
$emptyPairPattern = '(?s)<!--\s*claude-os:start\s*-->\s*<!--\s*claude-os:end\s*-->'

New-Item -ItemType Directory -Path $scratch | Out-Null
$savedProfile = $env:USERPROFILE
$env:USERPROFILE = $scratch
Write-Host "scratch home: $scratch"

try {
    # --- 1. fresh install ---------------------------------------------------
    Write-Host "1. fresh install"
    Run-Install
    $t = Read-Text $claudeMd
    Assert ($t.Contains($rulesSentinel)) 'rules present'
    Assert ((Count-Matches $t $startPattern) -eq 1) 'exactly one start marker'
    Assert ($t.TrimStart().StartsWith('<!-- claude-os:start -->')) 'file begins with start marker'
    Assert ($t.TrimEnd().EndsWith('<!-- claude-os:end -->')) 'file ends with end marker'
    $s = Read-Text $settings
    Assert ((Count-Matches $s $guardPattern) -eq 1) 'guard hook entry present once'
    Assert ((Count-Matches $s $emDashPattern) -eq 1) 'em-dash hook entry present once'
    Assert (Test-Path -LiteralPath $guardJs) 'guard script copied'
    Assert (Test-Path -LiteralPath $enableSkill) 'enable skill copied'
    Assert (Test-Path -LiteralPath $disableSkill) 'disable skill copied'
    # The repo text names itself C:\GIT\cli-agent-os; the install must point the
    # rules and both skills at the folder this test actually runs from.
    # Case-insensitive, like install.ps1's own check: a checkout at C:\git is the
    # canonical folder on Windows, so the installer leaves C:\GIT spelled as is.
    $ic = [System.StringComparison]::OrdinalIgnoreCase
    Assert ($t.IndexOf($repo, $ic) -ge 0) 'CLAUDE.md names the real checkout path'
    Assert ((Read-Text $enableSkill).IndexOf("$repo\install.ps1", $ic) -ge 0) 'enable skill calls install.ps1 in the real checkout'
    Assert ((Read-Text $disableSkill).IndexOf("$repo\uninstall.ps1", $ic) -ge 0) 'disable skill calls uninstall.ps1 in the real checkout'
    if ($repo -ne 'C:\GIT\cli-agent-os') {
        Assert (-not (Read-Text $enableSkill).Contains('C:\GIT\cli-agent-os')) 'canonical path fully rewritten in the skill'
    }
    Assert (-not $t.Contains('{{OWNER}}') -and -not $t.Contains('{{OVERLAY}}')) 'no placeholder left in CLAUDE.md'
    Assert ($t.Contains('until the user sees it')) 'owner placeholder falls back to "the user"'
    Assert (Test-Path -LiteralPath (Join-Path $claudeDir 'hooks\no-em-dash.js')) 'em-dash hook script copied'
    Assert ((Count-Matches $s $notesPattern) -eq 1) 'notes Stop hook entry present once'
    Assert (Test-Path -LiteralPath $notesJs) 'notes Stop hook script copied'
    Assert ((Count-Matches $s $claimsPattern) -eq 1) 'claims Stop hook entry present once'
    Assert (Test-Path -LiteralPath $claimsJs) 'claims Stop hook script copied'
    Assert ((Count-Matches $s $allowPattern) -eq 1) 'publish allow rule present once'
    Assert ((Count-Matches $s $autoModePattern) -eq 1) 'autoMode relay rule present once'

    # --- 2. reinstall with local extras -------------------------------------
    Write-Host "2. reinstall with local text, wmux block, wmux hook, local allow rule"
    Write-Text $claudeMd ((Read-Text $claudeMd).TrimEnd() + "`n`n" + $localText + "`n" + $wmuxBlock + "`n")
    $obj = (Read-Text $settings) | ConvertFrom-Json
    $wmuxEntry = [pscustomobject]@{ matcher = 'Bash'; hooks = @([pscustomobject]@{ type = 'command'; command = 'node wmux-hook.js Bash' }) }
    $obj.hooks.PreToolUse = [object[]] (@($obj.hooks.PreToolUse) + $wmuxEntry)
    $obj | Add-Member -NotePropertyName 'model' -NotePropertyValue 'keep-me'
    $obj.permissions.allow = [object[]] (@($obj.permissions.allow) + $localAllowRule)
    Write-Text $settings ($obj | ConvertTo-Json -Depth 20)
    Run-Install
    $t = Read-Text $claudeMd
    Assert ($t.Contains($rulesSentinel)) 'rules still present'
    Assert ($t.Contains('This line is not from the repo')) 'local text kept'
    Assert ($t.Contains('wmux managed text')) 'wmux block kept'
    Assert ((Count-Matches $t $startPattern) -eq 1) 'still exactly one start marker'
    $s = Read-Text $settings
    Assert ((Count-Matches $s $guardPattern) -eq 1) 'guard hook entry not duplicated'
    Assert ($s.Contains('wmux-hook.js')) 'wmux hook kept'
    Assert ($s.Contains('keep-me')) 'other settings keys kept'
    Assert ((Count-Matches $s $allowPattern) -eq 1) 'publish allow rule not duplicated'
    Assert ($s.Contains($localAllowRule)) 'local allow rule kept'
    Assert ((Count-Matches $s $autoModePattern) -eq 1) 'autoMode relay rule not duplicated'

    # --- 3. uninstall -------------------------------------------------------
    Write-Host "3. uninstall"
    Run-Uninstall
    $t = Read-Text $claudeMd
    Assert (-not $t.Contains($rulesSentinel)) 'rules removed'
    Assert ((Count-Matches $t $emptyPairPattern) -eq 1) 'empty marker pair left behind'
    Assert ($t.Contains('This line is not from the repo')) 'local text kept after uninstall'
    Assert ($t.Contains('wmux managed text')) 'wmux block kept after uninstall'
    $s = Read-Text $settings
    Assert ((Count-Matches $s $guardPattern) -eq 0) 'guard hook entry removed'
    Assert ((Count-Matches $s $emDashPattern) -eq 0) 'em-dash hook entry removed'
    Assert ((Count-Matches $s $notesPattern) -eq 0) 'notes Stop hook entry removed'
    Assert (-not (Test-Path -LiteralPath $notesJs)) 'notes Stop hook script removed'
    Assert ((Count-Matches $s $claimsPattern) -eq 0) 'claims Stop hook entry removed'
    Assert (-not (Test-Path -LiteralPath $claimsJs)) 'claims Stop hook script removed'
    Assert ($s.Contains('wmux-hook.js')) 'wmux hook kept after uninstall'
    Assert ($s.Contains('keep-me')) 'other settings keys kept after uninstall'
    Assert ((Count-Matches $s $allowPattern) -eq 0) 'publish allow rule removed'
    Assert ($s.Contains($localAllowRule)) 'local allow rule kept after uninstall'
    Assert ((Count-Matches $s $autoModePattern) -eq 0) 'autoMode relay rule removed'
    Assert ($s.Contains('$defaults')) 'autoMode $defaults kept after uninstall'
    Assert (-not (Test-Path -LiteralPath $guardJs)) 'guard script removed'
    Assert (-not (Test-Path -LiteralPath (Join-Path $claudeDir 'hooks\no-em-dash.js'))) 'em-dash hook script removed'
    Assert (Test-Path -LiteralPath $enableSkill) 'enable skill kept'
    Assert (Test-Path -LiteralPath $disableSkill) 'disable skill kept'
    $baks = @(Get-ChildItem -LiteralPath $claudeDir -Filter 'CLAUDE.md.bak-*')
    Assert ($baks.Count -ge 1) 'CLAUDE.md backed up before uninstall'

    # --- 4. reinstall after uninstall ---------------------------------------
    Write-Host "4. reinstall after uninstall"
    Run-Install
    $t = Read-Text $claudeMd
    Assert ($t.Contains($rulesSentinel)) 'rules back'
    Assert ($t.Contains('This line is not from the repo')) 'local text kept across the round trip'
    Assert ($t.Contains('wmux managed text')) 'wmux block kept across the round trip'
    Assert ((Count-Matches $t $startPattern) -eq 1) 'one start marker after round trip'
    $s = Read-Text $settings
    Assert ((Count-Matches $s $guardPattern) -eq 1) 'guard hook entry back once'
    Assert ($s.Contains('wmux-hook.js')) 'wmux hook still there'
    Assert (Test-Path -LiteralPath $guardJs) 'guard script back'
    Assert ((Count-Matches $s $allowPattern) -eq 1) 'publish allow rule back once'
    Assert ($s.Contains($localAllowRule)) 'local allow rule kept across the round trip'
    Assert ((Count-Matches $s $autoModePattern) -eq 1) 'autoMode relay rule back once'
    Assert ((Count-Matches $s '\$defaults') -eq 1) 'autoMode $defaults not duplicated'

    # --- 5. legacy file without markers -------------------------------------
    Write-Host "5. legacy CLAUDE.md with no markers"
    Write-Text $claudeMd ("# Old rules from before claude-os`n`nold line`n`n" + $localBlock + "`n`n" + $wmuxBlock + "`n")
    $before = @(Get-ChildItem -LiteralPath $claudeDir -Filter 'CLAUDE.md.bak-*').Count
    Start-Sleep -Seconds 1
    Run-Install
    $t = Read-Text $claudeMd
    Assert ($t.Contains($rulesSentinel)) 'rules written over legacy file'
    Assert (-not $t.Contains('old line')) 'legacy text replaced (first-install semantics)'
    Assert ($t.Contains('@import C:/local/machine-notes.md')) 'local block preserved from legacy file'
    Assert ($t.Contains('wmux managed text')) 'wmux block preserved from legacy file'
    Assert ($t.IndexOf('claude-os:end') -lt $t.IndexOf('local:start')) 'local block sits after the rules'
    Assert ($t.IndexOf('local:end') -lt $t.IndexOf('wmux:start')) 'wmux block sits after the local block'
    Assert ((Count-Matches $t $startPattern) -eq 1) 'markers added to legacy file'
    $after = @(Get-ChildItem -LiteralPath $claudeDir -Filter 'CLAUDE.md.bak-*').Count
    Assert ($after -gt $before) 'legacy file backed up'

    # --- 6. uninstall twice -------------------------------------------------
    Write-Host "6. uninstall twice"
    Run-Uninstall
    $t1 = Read-Text $claudeMd
    $s1 = Read-Text $settings
    Run-Uninstall
    Assert ((Read-Text $claudeMd) -eq $t1) 'second uninstall leaves CLAUDE.md unchanged'
    Assert ((Read-Text $settings) -eq $s1) 'second uninstall leaves settings unchanged'

    # --- 7. machine profile import ------------------------------------------
    Write-Host "7. machine profile import"
    Write-Text $fixture "# test fixture profile`n"
    Run-Install
    $t = Read-Text $claudeMd
    Assert (-not $t.Contains('claude-os-machine:start')) 'no machine block without a name'
    & (Join-Path $repo 'install.ps1') -SkipPlugins -Machine '_test-fixture' | Out-Null
    $t = Read-Text $claudeMd
    Assert ((Count-Matches $t 'claude-os-machine:start') -eq 1) 'machine block written once'
    Assert ($t.Contains('@' + ($fixture -replace '\\', '/'))) 'import points at the repo profile'
    Assert ($t.IndexOf('claude-os:end') -lt $t.IndexOf('claude-os-machine:start')) 'machine block sits after the rules'
    Assert ($t.IndexOf('claude-os-machine:end') -lt $t.IndexOf('wmux:start')) 'machine block sits before the wmux block'
    Assert ((Read-Text (Join-Path $claudeDir 'machine.txt')).Trim() -eq '_test-fixture') 'machine name remembered'
    Run-Install
    $t = Read-Text $claudeMd
    Assert ((Count-Matches $t 'claude-os-machine:start') -eq 1) 'machine block not duplicated on reinstall'
    Run-Uninstall
    $t = Read-Text $claudeMd
    Assert (-not $t.Contains('claude-os-machine:start')) 'machine block removed on uninstall'
    Assert ($t.Contains('wmux managed text')) 'wmux block kept after machine removal'
    Assert ($t.Contains('@import C:/local/machine-notes.md')) 'local block kept after machine removal'
    Run-Install
    $t = Read-Text $claudeMd
    Assert ((Count-Matches $t 'claude-os-machine:start') -eq 1) 'machine block back after reinstall from the saved name'
    & (Join-Path $repo 'install.ps1') -SkipPlugins -Machine 'no-such-machine' | Out-Null
    $t = Read-Text $claudeMd
    Assert ((Count-Matches $t 'claude-os-machine:start') -eq 1) 'unknown machine name leaves the existing block alone'
    # Leave the saved name on the fixture for section 8.
    & (Join-Path $repo 'install.ps1') -SkipPlugins -Machine '_test-fixture' | Out-Null

    # --- 8. Codex and Antigravity -------------------------------------------
    Write-Host "8. Codex and Antigravity targets"
    $codexDir = Join-Path $scratch '.codex'
    $codexAgents = Join-Path $codexDir 'AGENTS.md'
    $codexHooks = Join-Path $codexDir 'hooks.json'
    $codexConfig = Join-Path $codexDir 'config.toml'
    $agyCli = Join-Path $scratch '.gemini\antigravity-cli'
    $agySettings = Join-Path $agyCli 'settings.json'
    $plugin = Join-Path $scratch '.gemini\config\plugins\agent-os'
    New-Item -ItemType Directory -Path $codexDir, $agyCli -Force | Out-Null
    Write-Text $codexAgents "# My own Codex notes`n`nkeep this line`n"
    Write-Text $codexConfig "model = `"gpt-test`"`nproject_doc_max_bytes = 50000`n`n[features]`njs_repl = false`n"
    Write-Text $agySettings "{`n  `"colorScheme`": `"tokyo night`"`n}`n"

    & (Join-Path $repo 'install.ps1') -SkipPlugins -Agents 'claude,codex,agy' | Out-Null
    $t = Read-Text $codexAgents
    Assert ((Count-Matches $t 'agent-os:start') -eq 1) 'codex: one agent-os block'
    Assert ($t.Contains($rulesSentinel)) 'codex: rules present'
    Assert ($t.Contains('This copy is for **Codex CLI**')) 'codex: codex preamble present'
    Assert ($t.Contains('# test fixture profile')) 'codex: machine profile inlined'
    Assert ($t.Contains('keep this line')) 'codex: user text kept'
    $h = Read-Text $codexHooks
    Assert ((Count-Matches $h 'no-shell-edits\.js') -eq 2) 'codex: guard hook has command and commandWindows'
    Assert ($h.Contains('commandWindows')) 'codex: commandWindows written'
    Assert ($h.Contains(($scratch -replace '\\', '/') + '/.claude/hooks/claims-stop.js')) 'codex: commandWindows uses the absolute home path'
    $c = Read-Text $codexConfig
    Assert ($c.Contains('project_doc_fallback_filenames = ["CLAUDE.md"]')) 'codex: fallback filename key added'
    Assert ((Count-Matches $c 'project_doc_max_bytes') -eq 1) 'codex: a user-set key is not duplicated'
    Assert ($c.Contains('project_doc_max_bytes = 50000')) 'codex: the user value wins'
    Assert ($c.IndexOf('project_doc_fallback_filenames') -lt $c.IndexOf('[features]')) 'codex: added key sits before the first table'
    Assert ($c.Contains('model = "gpt-test"')) 'codex: other config kept'
    Assert (Test-Path -LiteralPath (Join-Path $plugin 'plugin.json')) 'agy: plugin.json written'
    $ar = Read-Text (Join-Path $plugin 'rules\AGENTS.md')
    Assert ($ar.Contains('This copy is for **Antigravity CLI (agy)**') -and $ar.Contains($rulesSentinel)) 'agy: rules with agy preamble'
    Assert ([System.Text.Encoding]::UTF8.GetByteCount($ar) -le 24000) 'agy: rules file under the 24,000-byte cap'
    Assert ((Read-Text (Join-Path $plugin 'rules\machine-profile.md')).Contains('# test fixture profile')) 'agy: machine profile rule file'
    Assert ((Read-Text (Join-Path $plugin 'hooks.json')).Contains('agy-hook.js PreToolUse')) 'agy: hooks.json wires the adapter'
    Assert (Test-Path -LiteralPath (Join-Path $plugin 'hooks\agy-hook.js')) 'agy: adapter copied'
    Assert (Test-Path -LiteralPath (Join-Path $plugin 'hooks\transcript.js')) 'agy: adapter dependencies copied'
    Assert (-not (Test-Path -LiteralPath (Join-Path $plugin 'hooks\agy-hook.test.js'))) 'agy: tests not copied'
    Assert (Test-Path -LiteralPath (Join-Path $plugin 'skills\commit-tickets\SKILL.md')) 'agy: shared skill copied'
    Assert (-not (Test-Path -LiteralPath (Join-Path $plugin 'skills\glm-backend'))) 'agy: Claude-only skill skipped'
    $as = Read-Text $agySettings
    Assert ($as.Contains('command(npm run publish:release)')) 'agy: permission rule added'
    Assert ($as.Contains('tokyo night')) 'agy: other settings kept'

    & (Join-Path $repo 'install.ps1') -SkipPlugins -Agents 'codex,agy' | Out-Null
    Assert ((Count-Matches (Read-Text $codexAgents) 'agent-os:start') -eq 1) 'codex: block not duplicated on reinstall'
    Assert ((Count-Matches (Read-Text $codexHooks) 'no-shell-edits\.js') -eq 2) 'codex: hooks not duplicated on reinstall'
    Assert ((Count-Matches (Read-Text $codexConfig) 'project_doc_fallback_filenames') -eq 1) 'codex: config key not duplicated on reinstall'
    Assert ((Count-Matches (Read-Text $agySettings) 'npm run publish:release') -eq 1) 'agy: permission not duplicated on reinstall'

    # --- 9. shared skills ---------------------------------------------------
    Write-Host "9. shared skills"
    $shared = Join-Path $scratch '.agents\skills'
    $sharedCommit = Read-Text (Join-Path $shared 'commit-tickets\SKILL.md')
    $claudeCommit = Read-Text (Join-Path $claudeDir 'skills\commit-tickets\SKILL.md')
    Assert ($sharedCommit.Contains('Run this skill only when the user asks for it by name')) 'shared: guard added to a disable-model-invocation skill'
    Assert (-not $claudeCommit.Contains('Run this skill only when the user asks for it by name')) 'claude: its own copy has no guard'
    Assert (-not (Read-Text (Join-Path $shared 'promote\SKILL.md')).Contains('Run this skill only when')) 'shared: no guard on a model-invocable skill'
    Assert (-not (Test-Path -LiteralPath (Join-Path $shared 'statusline'))) 'shared: Claude-only skill skipped'

    Write-Host "8/9. uninstall reverses the agent targets"
    Run-Uninstall
    $t = Read-Text $codexAgents
    Assert (-not $t.Contains('agent-os:start')) 'codex: block removed'
    Assert ($t.Contains('keep this line')) 'codex: user text kept after uninstall'
    Assert (-not (Test-Path -LiteralPath $codexHooks)) 'codex: hooks.json removed (held only ours)'
    $c = Read-Text $codexConfig
    Assert (-not $c.Contains('project_doc_fallback_filenames')) 'codex: added key removed'
    Assert ($c.Contains('project_doc_max_bytes = 50000')) 'codex: user-set key kept'
    Assert ($c.Contains('model = "gpt-test"') -and $c.Contains('[features]')) 'codex: other config kept after uninstall'
    Assert (-not (Test-Path -LiteralPath $plugin)) 'agy: plugin folder removed'
    $as = Read-Text $agySettings
    Assert (-not $as.Contains('publish:release')) 'agy: permission removed'
    Assert ($as.Contains('tokyo night')) 'agy: other settings kept after uninstall'
    Assert (-not (Test-Path -LiteralPath (Join-Path $shared 'commit-tickets'))) 'shared: skill removed'
    Assert (Test-Path -LiteralPath (Join-Path $shared 'enable-global-rules\SKILL.md')) 'shared: toggle skill kept'

    # --- 10. overlay --------------------------------------------------------
    Write-Host "10. overlay"
    $ov = Join-Path $scratch 'overlay'
    New-Item -ItemType Directory -Path (Join-Path $ov 'machines'), (Join-Path $ov 'skills\ov-skill'), (Join-Path $ov 'skills\promote') -Force | Out-Null
    $ovRule = 'Bash(overlay-only-tool:*)'
    $ovRuleLower = 'Bash(node C:/git/case-tool.mjs:*)'
    $ovRuleUpper = 'Bash(node C:/GIT/case-tool.mjs:*)'
    Write-Text (Join-Path $ov 'overlay.json') (@{
        owner    = 'Testowner'
        allow    = @($ovRule, $ovRuleLower, $ovRuleUpper)
        charters = @(@{ exact = @('C:/charter-root'); files = @('C:/charter-root/CHARTER.md'); note = 'test charter' })
    } | ConvertTo-Json -Depth 5)
    Write-Text (Join-Path $ov 'owner-rules.md') "# Owner rules sentinel`n`nOnly in the overlay.`n"
    Write-Text (Join-Path $ov 'machines\_ov-machine.md') "# overlay machine profile`n"
    Write-Text (Join-Path $ov 'skills\ov-skill\SKILL.md') "---`nname: ov-skill`ndescription: test`n---`n`nHello {{OWNER}}.`n"
    Write-Text (Join-Path $ov 'skills\promote\SKILL.md') "overlay shadow copy`n"
    $chartersFile = Join-Path $claudeDir 'hooks\charters.json'
    $ovSkill = Join-Path $claudeDir 'skills\ov-skill\SKILL.md'

    & (Join-Path $repo 'install.ps1') -SkipPlugins -Overlay $ov -Machine '_ov-machine' | Out-Null
    $t = Read-Text $claudeMd
    Assert ($t.Contains('# Owner rules sentinel')) 'overlay: owner rules in CLAUDE.md'
    Assert ($t.IndexOf($rulesSentinel) -lt $t.IndexOf('# Owner rules sentinel')) 'overlay: owner rules come after the public rules'
    Assert ($t.IndexOf('# Owner rules sentinel') -lt $t.IndexOf('claude-os:end')) 'overlay: owner rules inside the managed block'
    Assert ($t.Contains('until Testowner sees it')) 'overlay: owner name rendered'
    Assert ($t.Contains("$ov\machines\<name>.md")) 'overlay: {{OVERLAY}} rendered to the overlay path'
    Assert ($t.Contains('@' + ((Join-Path $ov 'machines\_ov-machine.md') -replace '\\', '/'))) 'overlay: machine import points at the overlay profile'
    $s = Read-Text $settings
    Assert ((Count-Matches $s ([regex]::Escape($ovRule))) -eq 1) 'overlay: allow rule merged once'
    Assert ((Count-Matches $s $allowPattern) -eq 1) 'overlay: repo allow rule still once'
    Assert ($s.Contains($ovRuleLower) -and $s.Contains($ovRuleUpper)) 'overlay: rules differing only in case both merged'
    Assert ((Test-Path -LiteralPath $ovSkill) -and (Read-Text $ovSkill).Contains('Hello Testowner.')) 'overlay: skill copied and rendered'
    Assert (-not (Read-Text (Join-Path $claudeDir 'skills\promote\SKILL.md')).Contains('overlay shadow copy')) 'overlay: a repo skill is never replaced'
    Assert (Test-Path -LiteralPath (Join-Path $shared 'ov-skill\SKILL.md')) 'overlay: skill shared with other agents'
    Assert ((Test-Path -LiteralPath $chartersFile) -and (Read-Text $chartersFile).Contains('C:/charter-root/CHARTER.md')) 'overlay: charters.json written'
    $ca = Read-Text $codexAgents
    Assert ($ca.Contains('# Owner rules sentinel') -and $ca.Contains('# overlay machine profile')) 'overlay: codex gets owner rules and overlay profile'

    Run-Install
    Assert ((Count-Matches (Read-Text $settings) ([regex]::Escape($ovRule))) -eq 1) 'overlay: remembered and not duplicated on reinstall'
    Assert ((Read-Text $claudeMd).Contains('# Owner rules sentinel')) 'overlay: rules kept on reinstall without -Overlay'

    Run-Uninstall
    $s = Read-Text $settings
    Assert ((Count-Matches $s ([regex]::Escape($ovRule))) -eq 0) 'overlay: allow rule removed by uninstall'
    Assert (-not ($s.Contains($ovRuleLower) -or $s.Contains($ovRuleUpper))) 'overlay: both case variants removed by uninstall'
    Assert (-not (Test-Path -LiteralPath $ovSkill)) 'overlay: skill removed by uninstall'
    Assert (-not (Test-Path -LiteralPath (Join-Path $shared 'ov-skill'))) 'overlay: shared skill removed by uninstall'
    Assert (-not (Test-Path -LiteralPath $chartersFile)) 'overlay: charters.json removed by uninstall'
    Assert (Test-Path -LiteralPath (Join-Path $claudeDir 'overlay.txt')) 'overlay: path kept for the next install'

    & (Join-Path $repo 'install.ps1') -SkipPlugins -Overlay 'none' | Out-Null
    $t = Read-Text $claudeMd
    Assert (-not (Test-Path -LiteralPath (Join-Path $claudeDir 'overlay.txt'))) 'overlay: -Overlay none forgets the path'
    Assert (-not $t.Contains('Testowner') -and -not $t.Contains('# Owner rules sentinel')) 'overlay: nothing of the overlay left after -Overlay none'
    Assert (-not (Test-Path -LiteralPath $chartersFile)) 'overlay: no charters.json without an overlay'
}
finally {
    $env:USERPROFILE = $savedProfile
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Force }
}

Write-Host ""
Write-Host "passed: $script:passes  failed: $script:fails  (scratch: $scratch)"
if ($script:fails -gt 0) { exit 1 }
exit 0
