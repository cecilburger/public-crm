/**
 * Start the BD brain — `apps/bd-brain`, the Python bot the worker asks what
 * to say to a brand — the way the other dev scripts start their service.
 *
 *   npm run dev:bd-brain     → http://127.0.0.1:4321
 *
 * Why a Node launcher and not `cd apps/bd-brain && PYTHONPATH=src python -m
 * bd_bot brain-serve` in package.json: the QA team runs this on Windows,
 * where that line does not parse, and the worker reads BD_BRAIN_SECRET from
 * the root `.env` through `tsx --env-file=.env` — so the brain must read the
 * same file, or the two disagree on the secret and every call is a 401.
 * `tsx --env-file` has already put the root `.env` into `process.env` by the
 * time this runs; it is passed through to Python unchanged. The bot's own
 * `config.load()` then layers `apps/bd-brain/.env` (if present) underneath,
 * for settings only the bot has (Google OAuth paths, MEETING_* hours).
 *
 * The interpreter is whichever of `python3` / `python` answers, or
 * BD_BRAIN_PYTHON — a venv's interpreter, typically. Nothing is installed
 * here; see apps/bd-brain/README.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const appDir = path.join(root, 'apps', 'bd-brain');

function findPython(): string {
  const preferred = process.env.BD_BRAIN_PYTHON;
  const candidates = preferred ? [preferred] : ['python3', 'python'];
  for (const candidate of candidates) {
    // No `shell: true` here: Windows' own PATH/PATHEXT lookup already finds a
    // bare `python`/`python3`, and routing through cmd.exe instead only means
    // an interpreter path with a space (BD_BRAIN_PYTHON pointed at a venv
    // under one, or this repo's own directory) gets split into two arguments
    // and "is not recognized" instead of running.
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) return candidate;
  }
  console.error(
    '[bd-brain] no Python 3.11+ found. Install one, or point BD_BRAIN_PYTHON at a venv interpreter\n'
    + '           (e.g. BD_BRAIN_PYTHON=apps/bd-brain/.venv/bin/python). See apps/bd-brain/README.md.',
  );
  process.exit(1);
}

const python = findPython();
const pythonPath = [path.join(appDir, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);

// `npm run test:bd-brain`: the bot's own pytest suite, offline. The three
// variables are blanked the way the suite's conftest does, so a developer's
// ANTHROPIC_API_KEY in .env cannot turn a test run into billable calls.
if (process.argv.includes('--test')) {
  const extra = process.argv.slice(process.argv.indexOf('--test') + 1);
  const test = spawnSync(python, ['-m', 'pytest', 'tests', '-q', '-p', 'no:cacheprovider', ...extra], {
    cwd: appDir, stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: pythonPath, ANTHROPIC_API_KEY: '', USE_LLM_INTENTS: 'false', USE_LLM_REPLIES: 'false' },
  });
  process.exit(test.status ?? 1);
}

if (!process.env.BD_BRAIN_SECRET) {
  console.error('[bd-brain] BD_BRAIN_SECRET is empty in .env — the brain refuses to start without it, and so does this.');
  process.exit(1);
}

const port = process.env.BD_BRAIN_PORT || new URL(process.env.BD_BRAIN_URL || 'http://127.0.0.1:4321').port || '4321';

console.log(`[bd-brain] ${python} -m bd_bot brain-serve --port ${port}  (cwd apps/bd-brain)`);
const child = spawn(python, ['-m', 'bd_bot', 'brain-serve', '--port', port], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
