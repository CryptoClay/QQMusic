import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'test', 'soak.spec.ts', '--project=chromium'], {
  env: { ...process.env, QQM_SOAK_SECONDS: process.env.QQM_SOAK_SECONDS || '7200' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
