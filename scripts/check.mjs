// Quick check: JS syntax and required package.json fields.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let failed = false;
for (const dir of readdirSync('packages')) {
  const cwd = join('packages', dir);
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  for (const f of ['name', 'displayName', 'description', 'version', 'publisher', 'engines', 'license', 'repository']) {
    if (!pkg[f]) { console.error(`${dir}: missing "${f}" in package.json`); failed = true; }
  }
  if (pkg.publisher === 'your-publisher') console.warn(`${dir}: publisher is still the placeholder (run npm run set-publisher -- <id>)`);
  for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
    if (!existsSync(join(cwd, f))) { console.error(`${dir}: missing ${f}`); failed = true; }
  }
  if (pkg.main) execFileSync('node', ['--check', join(cwd, pkg.main)], { stdio: 'inherit' });
}
console.log(failed ? '\n✗ problems found' : '\n✓ all good');
process.exit(failed ? 1 : 0);
