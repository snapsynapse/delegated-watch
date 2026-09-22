import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
// candidate/ is a subtree in the producer checkout and the root in the public
// repository. ENOENT selects the root layout; any other error surfaces.
const candidateRoot = (() => {
  const nested = path.join(repoRoot, 'candidate');
  try {
    return fs.statSync(nested).isDirectory() ? nested : repoRoot;
  } catch (error) {
    if (error.code === 'ENOENT') return repoRoot;
    throw error;
  }
})();
const workflowPath = path.join(candidateRoot, '.github/workflows/ci.yml');
const content = fs.readFileSync(workflowPath, 'utf8');
const lines = content.split('\n');

test('top-level permissions is exactly contents: read, and no other permissions block appears', () => {
  const permissionLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /permissions\s*:/.test(line));

  assert.equal(
    permissionLines.length,
    1,
    `expected exactly one line mentioning "permissions:", found ${permissionLines.length}`
  );

  const { line, index } = permissionLines[0];
  assert.match(
    line,
    /^permissions:\s*$/,
    `the permissions block must be top-level (no indentation) with no inline value, got: "${line}"`
  );

  let bodyIndex = index + 1;
  while (bodyIndex < lines.length && lines[bodyIndex].trim() === '') bodyIndex++;
  assert.ok(bodyIndex < lines.length, 'permissions block has no body');
  assert.match(
    lines[bodyIndex],
    /^\s{2}contents:\s*read\s*$/,
    `expected the sole permissions entry to be "  contents: read", got: "${lines[bodyIndex]}"`
  );

  let nextIndex = bodyIndex + 1;
  while (nextIndex < lines.length && lines[nextIndex].trim() === '') nextIndex++;
  if (nextIndex < lines.length) {
    const indent = lines[nextIndex].match(/^(\s*)/)[1].length;
    assert.ok(
      indent < 2,
      `permissions block must contain only "contents: read", found extra entry: "${lines[nextIndex]}"`
    );
  }
});

test('every uses: line pins a 40-hex commit SHA with a trailing "# v" comment', () => {
  const usesLines = lines.filter((line) => /^\s*uses:\s*/.test(line));
  assert.ok(usesLines.length > 0, 'expected at least one "uses:" line in the workflow');
  for (const line of usesLines) {
    assert.match(
      line,
      /^\s*uses:\s*\S+@[0-9a-f]{40}\s*#\s*v\S+/,
      `"uses:" line must pin a 40-hex SHA followed by a "# v..." tag comment, got: "${line}"`
    );
  }
});

test('the matrix includes both Node 24.x and 26.x', () => {
  assert.ok(content.includes('24.x'), 'expected the matrix to include "24.x"');
  assert.ok(content.includes('26.x'), 'expected the matrix to include "26.x"');
});

test('the workflow never references secrets, npm install/ci, upload-artifact, or GITHUB_TOKEN', () => {
  const forbiddenFragments = ['secrets.', 'npm install', 'npm ci', 'upload-artifact', 'GITHUB_TOKEN'];
  for (const line of lines) {
    for (const fragment of forbiddenFragments) {
      assert.ok(
        !line.includes(fragment),
        `line contains forbidden fragment "${fragment}": "${line}"`
      );
    }
  }
});

test('every "npm run <script>" invoked is listed in allowed_scripts', () => {
  const candidateConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'config/public-candidate.json'), 'utf8')
  );
  const allowed = new Set(candidateConfig.allowed_scripts);

  const invoked = new Set();
  const pattern = /npm run ([A-Za-z0-9_:.-]+)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    invoked.add(match[1]);
  }

  assert.ok(invoked.size > 0, 'expected at least one "npm run" invocation in the workflow');
  for (const name of invoked) {
    assert.ok(
      allowed.has(name),
      `"npm run ${name}" is not in config/public-candidate.json allowed_scripts`
    );
  }
});

test('a build reproducibility step exists', () => {
  const hasHashTool = lines.some((line) => /sha256sum|shasum/.test(line));
  assert.ok(hasHashTool, 'expected a step referencing sha256sum or shasum to check build reproducibility');
});

test('the candidate .github tree contains only the ci workflow file', () => {
  const githubRoot = path.join(candidateRoot, '.github');
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(candidateRoot, full).split(path.sep).join('/'));
      }
    }
  }

  walk(githubRoot);
  assert.deepEqual(files, ['.github/workflows/ci.yml']);
});
