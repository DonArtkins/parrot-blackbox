import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

test('README documents the npm install command matching the package name', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`npm install -g ${pkg.name}`), 'README shows the global install command');
  assert.ok(readme.includes('Timeshift'), 'README mentions Timeshift');
});

test('CHANGELOG documents the current version', () => {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(changelog.includes(`[${pkg.version}]`), `CHANGELOG lists v${pkg.version}`);
});