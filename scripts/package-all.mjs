// Builds one .vsix per extension into dist/.
import { readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

mkdirSync('dist', { recursive: true });
for (const dir of readdirSync('packages')) {
  const cwd = join('packages', dir);
  const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const out = join('..', '..', 'dist', `${name}-${version}.vsix`);
  console.log(`\n▶ ${name}@${version}`);
  execFileSync('npx', ['vsce', 'package', '--no-dependencies', '-o', out], { cwd, stdio: 'inherit' });
}
