// Unit tests for hooks/no-shell-edits.js.
//   node hooks/no-shell-edits.test.js
// Feeds each command to the hook the way Claude Code does (JSON on stdin) and
// checks the exit code: 2 = blocked, 0 = allowed. Exits 1 if any case fails.
//
// Kept as a script rather than inline shell lines on purpose: a shell command
// whose text contains "sed -i" or "echo x > f.txt" trips the installed guard
// itself, so the cases live here as data.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const hook = path.join(__dirname, 'no-shell-edits.js');

const cases = [
  // The four checks from the week-1 brief (A-3).
  ['brief 1: heredoc redirected into a file', 2, 'cat <<EOF > x.txt\nhi\nEOF'],
  ['brief 2: sed in-place', 2, 'sed -i s/a/b/ file.ts'],
  ['brief 3: heredoc fed to stdin', 0, 'python3 - <<EOF\nprint(1)\nEOF'],
  ['brief 4: git status', 0, 'git status'],

  // The shape that slipped through in A-6 on 2026-09-09: redirect before the heredoc.
  ["redirect before heredoc: cat > f <<'EOF'", 2, "cat > hooktest.txt <<'EOF'\nhello\nEOF"],
  ['append before heredoc: cat >> f <<EOF', 2, 'cat >> notes.md <<EOF\nhi\nEOF'],
  ['heredoc + redirect inside bash -c', 2, 'bash -c "cat <<EOF >out.json\n{}\nEOF"'],

  // Legitimate heredoc uses that must stay allowed.
  ['stdin heredoc with 2>&1', 0, 'python3 - <<EOF 2>&1\nprint(1)\nEOF'],
  ['stdin heredoc with >/dev/null', 0, 'node - <<EOF >/dev/null\nconsole.log(1)\nEOF'],
  ['stdin heredoc with 2>/dev/null', 0, 'node - <<EOF 2>/dev/null\nconsole.log(1)\nEOF'],
  ['git commit -F - with heredoc message', 0, "git commit -q -F - <<'MSG'\nmsg\nMSG"],
  ['heredoc body line with >&2', 0, 'bash <<EOF\necho hi >&2\nEOF'],

  // Other shell-edit forms.
  ['sed -i.bak', 2, 'sed -i.bak -e s/a/b/ x.py'],
  ['sed --in-place', 2, 'sed --in-place s/a/b/ x.py'],
  ['perl -pi', 2, 'perl -pi -e s/a/b/ x.py'],
  ['echo into .txt', 2, 'echo hello > hooktest.txt'],
  ['printf into .json', 2, 'printf "{}" > cfg.json'],
  ['echo into .ps1', 2, 'echo x > run.ps1'],

  // Ordinary commands that must stay allowed.
  ['echo piped to grep', 0, 'echo hello | grep h'],
  ['sed without -i', 0, 'sed -n 1,5p file.ts'],
  ['redirect without heredoc (out of scope)', 0, 'ls > listing.log'],
  ['empty command', 0, ''],

  // PowerShell (Codex runs every command through pwsh -Command; H6 in
  // docs/agent-os-spike.md).
  ['ps: Set-Content -Value', 2, "Set-Content -Path x.ts -Value 'a'"],
  ['ps: literal piped to Set-Content', 2, '"hi" | Set-Content notes.md'],
  ['ps: -replace round trip', 2, "(Get-Content f.ps1) -replace 'a','b' | Set-Content f.ps1"],
  ['ps: Add-Content', 2, "Add-Content log.md 'x'"],
  ['ps: Set-Content after ;', 2, "$x = 1; Set-Content a.txt $x"],
  ['ps: literal piped to Out-File', 2, "'x' | Out-File f.json"],
  ['ps: here-string piped to Out-File', 2, "@'\nline\n'@ | Out-File a.md"],
  ['ps: here-string redirected', 2, '@"\nx\n"@ > a.txt'],
  ['ps: [IO.File]::WriteAllText', 2, "[IO.File]::WriteAllText('a.txt','x')"],
  ['ps: [System.IO.File]::AppendAllText', 2, "[System.IO.File]::AppendAllText('a.md','x')"],
  ['ps: New-Item -Value', 2, "New-Item -Path a.txt -ItemType File -Value 'x'"],
  ['ps: Write-Output into .json', 2, "Write-Output '{}' > cfg.json"],
  ['ps: array argv from an older Codex shell tool', 2, ['pwsh', '-Command', "Set-Content a.txt 'x'"]],

  // PowerShell forms that must stay allowed.
  ['ps: command output to Out-File log', 0, 'Get-ChildItem | Out-File listing.log'],
  ['ps: all streams to a log', 0, 'npm test *> test-out.txt'],
  ['ps: 2>$null', 0, 'Remove-Item x -ErrorAction SilentlyContinue 2>$null'],
  ['ps: here-string to stdin, output to $null', 0, "@'\nprint(1)\n'@ | python - > $null"],
  ['ps: Get-Content', 0, 'Get-Content a.txt -TotalCount 5'],
  ['ps: Set-Content named in a commit message', 0, 'git commit -m "hooks: block Set-Content"'],
  ['ps: New-Item directory', 0, 'New-Item -ItemType Directory -Force out'],
];

let failed = 0;
for (const [label, expect, command] of cases) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  const ok = r.status === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  exit=${r.status} expect=${expect}  ${label}`);
}

// Malformed stdin must not wedge the Bash tool.
const bad = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
const badOk = bad.status === 0;
if (!badOk) failed++;
console.log(`${badOk ? 'PASS' : 'FAIL'}  exit=${bad.status} expect=0  malformed stdin is allowed`);

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} passed`);
process.exit(failed ? 1 : 0);
