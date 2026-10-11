// Cross-platform launcher for the Electron self-test (sets env, inherits output).
import { spawn } from 'node:child_process';
import electron from 'electron';

const p = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, JARVIS_SELFTEST: '1' } });
p.on('exit', (code) => process.exit(code ?? 1));
