// agent-os: reads an agent's session transcript for the two Stop hooks
// (claims-stop.js wants the last assistant text, notes-stop.js wants the files
// the session wrote). One module so the formats are parsed in one place.
//
// Formats, each seen on the main desktop on 2026-09-30:
//   - Claude Code: JSONL, one message per line, { type: "assistant",
//     message: { content: [ { type: "text", text }, { type: "tool_use",
//     name: "Edit" | "Write" | "NotebookEdit", input: { file_path } } ] } }.
//   - Codex (rollout-*.jsonl under ~/.codex/sessions): { type: "response_item",
//     payload: { type: "message", role: "assistant", content: [ { type:
//     "output_text", text } ] } } for text; file edits are apply_patch calls,
//     either a direct { type: "custom_tool_call" | "function_call", name:
//     "apply_patch" } or a patch inside the JS of the "exec" tool, so any tool
//     call whose input holds "*** Begin Patch" is read for its file headers.
//   - Antigravity (transcript_full.jsonl under
//     ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs, read from a
//     live agy 1.2.14 run on 2026-09-30): { type: "PLANNER_RESPONSE", source:
//     "MODEL", content, tool_calls: [ { name, args } ] }. Text is `content`;
//     a write is a tool call named write_to_file, replace_file_content or
//     multi_replace_file_content, whose args.TargetFile is the path.
//
// Every function returns an empty result on an unreadable file: a Stop hook
// that cannot read the transcript lets the session end.

'use strict';

const fs = require('fs');

const CLAUDE_WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const AGY_WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);

function readLines(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return null;
  }
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      // a torn last line while the agent is still writing
    }
  }
  return out;
}

// File paths named by the headers of an apply_patch body.
function patchTargets(text) {
  const out = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  let m;
  while ((m = re.exec(String(text)))) out.push((m[1] || m[2]).trim());
  return out;
}

// The text of the last assistant message, or null.
function lastAssistantText(transcriptPath) {
  const lines = readLines(transcriptPath);
  if (!lines) return null;
  let last = null;
  for (const msg of lines) {
    if (!msg) continue;
    // Claude Code
    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          last = block.text;
        }
      }
      continue;
    }
    // Codex
    const p = msg.payload;
    if (msg.type === 'response_item' && p && p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
      const text = p.content
        .filter((c) => c && c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      if (text.trim()) last = text;
      continue;
    }
    // Antigravity
    if (msg.type === 'PLANNER_RESPONSE' && msg.source === 'MODEL' && typeof msg.content === 'string' && msg.content.trim()) {
      last = msg.content;
    }
  }
  return last;
}

// { hasWrites, targets: [path, ...] } for every file write the transcript
// records, or null when the file cannot be read.
function writeTargets(transcriptPath) {
  const lines = readLines(transcriptPath);
  if (!lines) return null;
  const targets = [];
  let hasWrites = false;
  const visitAgy = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (typeof node.name === 'string' && AGY_WRITE_TOOLS.has(node.name)) {
      hasWrites = true;
      const args = node.args || node.arguments || {};
      if (args && typeof args === 'object' && args.TargetFile) targets.push(String(args.TargetFile));
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visitAgy(v, depth + 1);
  };
  for (const msg of lines) {
    if (!msg) continue;
    // Claude Code
    const content = msg.message && msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || !CLAUDE_WRITE_TOOLS.has(block.name)) continue;
        hasWrites = true;
        const input = block.input || {};
        targets.push(String(input.file_path || input.notebook_path || ''));
      }
      continue;
    }
    // Codex
    const p = msg.payload;
    if (msg.type === 'response_item' && p && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      const body = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
      if (p.name === 'apply_patch' || body.includes('*** Begin Patch')) {
        hasWrites = true;
        targets.push(...patchTargets(body.replace(/\\n/g, '\n')));
      }
      continue;
    }
    // Antigravity
    visitAgy(msg, 0);
  }
  return { hasWrites, targets };
}

module.exports = { lastAssistantText, writeTargets, patchTargets };
