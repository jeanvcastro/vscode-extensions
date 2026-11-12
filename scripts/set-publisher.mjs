// Usage: npm run set-publisher -- <publisher-id> [github-owner/repo]
// Sets "publisher" (and, if given, "repository"/"homepage"/"bugs") in every extension.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [id, repo] = process.argv.slice(2);
if (!id || !/^[a-z0-9][a-z0-9-]*$/i.test(id) || (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
  console.error('Usage: npm run set-publisher -- <publisher-id> [owner/repo]');
  process.exit(1);
}
for (const dir of readdirSync('packages')) {
  const file = join('packages', dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.publisher = id;
  if (repo) {
    const url = `https://github.com/${repo}`;
    pkg.repository = { type: 'git', url: `${url}.git`, directory: `packages/${dir}` };
    pkg.homepage = `${url}/tree/main/packages/${dir}#readme`;
    pkg.bugs = { url: `${url}/issues` };
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${pkg.name}: publisher = ${id}${repo ? `, repo = ${repo}` : ''}`);
}
