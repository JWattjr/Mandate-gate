import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

// Keep the npm contract commands on the repository's pinned GenLayer toolchain
// when a local venv is present. Fall back to the platform Python so the
// commands remain usable after a normal `python -m venv` setup on CI.
const candidates = process.platform === 'win32'
  ? ['.venv/Scripts/python.exe', '.venv/Scripts/python', 'python']
  : ['.venv/bin/python', 'python3', 'python'];
const python = candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1);
const result = spawnSync(python, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error(`Unable to run ${python}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
