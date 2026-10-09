# claude-os: startup banner wrapper.
# Dot-sourced from both the PowerShell 7 and the Windows PowerShell 5.1
# profiles by install-banner.ps1 (between the "# claude-os:banner:start" and
# "# claude-os:banner:end" markers). wmux panes run powershell.exe. Defines a
# `claude` function that shadows claude.exe: it prints the banner, then hands
# every argument to the real executable.
#
# The banner is itself a canary. If the block between <!-- claude-os:start -->
# and <!-- claude-os:end --> in ~/.claude/CLAUDE.md holds rules, the box in
# art.txt is drawn. If the block is empty or the markers are gone, a single
# red line says so instead, so a missing layer is never dressed up as a working
# one.
#
# Skip the banner for one launch:   claude -NoBanner ...
# Skip it for a whole shell:        $env:CLAUDE_OS_NO_BANNER = '1'

function claude {
    $noBanner = ($env:CLAUDE_OS_NO_BANNER -eq '1')
    $passthru = @()
    foreach ($a in $args) {
        if ($a -eq '-NoBanner') { $noBanner = $true } else { $passthru += $a }
    }

    if (-not $noBanner) {
        $claudeMd = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'
        $art = Join-Path $env:USERPROFILE '.claude\banner\art.txt'
        # Loaded means rules between the markers, not markers. uninstall.ps1
        # keeps the pair and empties the block, so a presence test would draw
        # the box for a machine that was just disabled.
        $loaded = $false
        if (Test-Path -LiteralPath $claudeMd) {
            $md = Get-Content -LiteralPath $claudeMd -Raw
            # claude-os is today's marker; agent-os is the name a later release
            # switches to, accepted now so that switch cannot trip this canary.
            foreach ($tag in @('claude-os', 'agent-os')) {
                $open = $md.IndexOf("<!-- ${tag}:start -->")
                if ($open -lt 0) { continue }
                $bodyAt = $open + "<!-- ${tag}:start -->".Length
                $close = $md.IndexOf("<!-- ${tag}:end -->", $bodyAt)
                if ($close -ge 0 -and -not [string]::IsNullOrWhiteSpace($md.Substring($bodyAt, $close - $bodyAt))) {
                    $loaded = $true
                }
            }
        }
        if ($loaded -and (Test-Path -LiteralPath $art)) {
            # The checkout's version, the same "r<commit count> <date>" the
            # status line shows: green when level with origin/main, red when
            # origin/main is ahead (as of the last fetch, which the status line
            # runs in the background). Runs git once per launch; no git, no
            # version, still a banner.
            $repo = 'C:\GIT\cli-agent-os'
            $ver = ''
            $behind = 0
            if (Test-Path -LiteralPath (Join-Path $repo '.git')) {
                $count = & git -C $repo rev-list --count HEAD 2>$null
                if ($LASTEXITCODE -eq 0 -and $count) {
                    $date = & git -C $repo log -1 '--format=%cd' '--date=format:%b %d' 2>$null
                    $ver = "r$([string]$count)".Trim()
                    if ($date) { $ver += " $([string]$date)".TrimEnd() }
                    $ahead = & git -C $repo rev-list --count 'HEAD..origin/main' 2>$null
                    if ($LASTEXITCODE -eq 0 -and $ahead) { $behind = [int]([string]$ahead).Trim() }
                }
            }
            Write-Host ''
            Get-Content -LiteralPath $art | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
            Write-Host '  agent-os loaded' -ForegroundColor Green -NoNewline
            if ($ver) {
                Write-Host ' @ ' -ForegroundColor Green -NoNewline
                Write-Host $ver -ForegroundColor $(if ($behind -gt 0) { 'Red' } else { 'Green' }) -NoNewline
            }
            Write-Host "  |  $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -ForegroundColor Green
            Write-Host ''
        } else {
            Write-Host ''
            Write-Host '  [!] agent-os NOT loaded: the agent-os block in ~/.claude/CLAUDE.md is empty or absent' -ForegroundColor Red
            Write-Host ''
        }
    }

    $exe = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) {
        Write-Error 'claude.exe not found on PATH'
        return
    }
    & $exe.Source @passthru
}
