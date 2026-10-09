// apiKeyHelper for the glm-backend skill. Claude Code runs this and sends whatever it prints
// as the credential, so it prints the Z.ai key and nothing else: ZAI_API_KEY if set, otherwise
// the contents of ~/.claude/secrets/zai-api-key.txt. Errors go to stderr with exit 1.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const fromEnv = (process.env.ZAI_API_KEY || '').trim();
if (fromEnv) {
  process.stdout.write(fromEnv);
  process.exit(0);
}

const file = path.join(os.homedir(), '.claude', 'secrets', 'zai-api-key.txt');
const fromFile = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
if (fromFile) {
  process.stdout.write(fromFile);
  process.exit(0);
}

process.stderr.write(`zai-key: no key; set ZAI_API_KEY or put the key alone in ${file}\n`);
process.exit(1);
