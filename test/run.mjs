// Runs the whole suite: every test/*.test.mjs through node:test.
// A script rather than a glob: `node --test <glob>` needs Node 21+, and Windows shells do not expand globs.
//   node test/run.mjs                 all files
//   node test/run.mjs server sim      only files whose name contains one of the words
//   node test/run.mjs --test-only     arguments starting with '-' go to node
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('-')), words = args.filter(a => !a.startsWith('-'));
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.mjs') && (!words.length || words.some(w => f.includes(w))))
  .sort()
  .map(f => path.join(dir, f));

if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}
const child = spawn(process.execPath, ['--test', ...flags, ...files], { stdio: 'inherit' });
child.on('error', err => { console.error(err); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
