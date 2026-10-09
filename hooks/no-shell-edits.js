// agent-os: blocks shell commands that modify files through the shell.
// Claude Code runs this as a PreToolUse hook (matcher: Bash), and so does
// Codex, which reports its shell tool as "Bash" with the same
// tool_input.command field (https://learn.chatgpt.com/docs/hooks, fetched
// 2026-09-30). Antigravity reaches it through hooks/agy-hook.js, which maps
// its run_command call onto the same shape. The tool call arrives as JSON on
// stdin; exit code 2 blocks the call and sends stderr back to the model as the
// reason. Exit 0 allows it. Under Codex the block is a JSON deny instead
// (hook-result.js).
//
// Two shells are covered. Claude Code's Bash tool is Git Bash; Codex runs
// every command through `pwsh -Command`, so the PowerShell forms of the same
// edits (Set-Content, Add-Content, a literal piped to Out-File, a here-string
// redirected into a file, [IO.File]::Write*) are blocked too. Redirecting a
// command's OUTPUT into a log file stays allowed in both shells: the rules ask
// for exactly that on long verification runs.
//
// Unit test (from the repo root):  node hooks/no-shell-edits.test.js

'use strict';

const { block } = require('./hook-result.js');

let cmd = '';
let input = null;
try {
  const raw = require('fs').readFileSync(0, 'utf8');
  input = JSON.parse(raw);
  const c = input && input.tool_input && input.tool_input.command;
  // An older Codex shell tool sent argv as an array.
  cmd = Array.isArray(c) ? c.join(' ') : String(c || '');
} catch (err) {
  // Unparseable input: allow the call rather than wedge every shell command.
  process.exit(0);
}

// A file redirect: ">" or ">>" not preceded by a digit or "*" (so "2>&1",
// "2>/dev/null" and "*>" of a command's output pass) and not followed by "&",
// /dev/null or PowerShell's $null.
const FILE_REDIRECT = String.raw`(?<![0-9*])>>?\s*(?!&|/dev/null|\$null)\S`;
// A heredoc opener: "<<EOF", "<<-EOF", "<<'EOF'", "<<\"EOF\"".
const HEREDOC = String.raw`<<-?\s*['"]?\w+['"]?`;
// Where a PowerShell command starts: line start, after | ; & ( { , or as the
// first word of a `pwsh -Command` / `powershell -c` argument.
const PS_CMD_START = String.raw`(?:^|[|;&({]\s*|-(?:Command|c)\s+['"]?)`;
// File types that hold source, config or prose.
const CODE_EXT = String.raw`\.(ts|tsx|js|mjs|cjs|jsx|py|md|json|ps1|psm1|sql|yml|yaml|toml|txt|sh|bat|cmd|xml|html|css|ini|cfg|csv|env)\b`;

const pats = [
  // --- Git Bash ---
  // A line that both opens a heredoc and redirects into a file, in either
  // order: "cat <<EOF > x.txt" and "cat > x.txt <<EOF" are both blocked.
  // A heredoc fed to a program's stdin with no file redirect is allowed.
  new RegExp(String.raw`^(?=.*${HEREDOC})(?=.*${FILE_REDIRECT}).*$`, 'm'),
  // sed in-place (-i, -i.bak, --in-place)
  /\bsed\s+(-\w*i|--in-place)\b/,
  // perl in-place
  /\bperl\s+-\w*i\b/,
  // echo/printf (or PowerShell's Write-Output) redirected into a source or config file
  new RegExp(String.raw`\b(echo|printf|Write-Output)\b[^|]*>\s*\S+${CODE_EXT}`, 'i'),

  // --- PowerShell ---
  // Set-Content / Add-Content in command position. A mention inside a commit
  // message ("git commit -m 'fix Set-Content'") is not in command position.
  new RegExp(String.raw`${PS_CMD_START}(Set-Content|Add-Content)\b`, 'im'),
  // A string literal or here-string piped to Out-File / Set-Content.
  /(['"]|['"]@)\s*\|\s*(Out-File|Set-Content|Add-Content)\b/i,
  // A here-string closed and redirected into a file: '@ > x.md, "@ >> x.md
  new RegExp(String.raw`['"]@\s*${FILE_REDIRECT}`),
  // .NET file writers
  /\[(System\.)?IO\.File\]::(WriteAll\w*|AppendAll\w*|Create\w*)/i,
  // New-Item with inline content
  /\bNew-Item\b[^|;\n]*-Value\b/i,
];

if (pats.some((p) => p.test(cmd))) {
  block(
    input,
    'PreToolUse',
    "Blocked by agent-os: change files with the agent's file tool (Claude Code: Edit or Write; " +
      'Codex: apply_patch), not through the shell.'
  );
}

process.exit(0);
