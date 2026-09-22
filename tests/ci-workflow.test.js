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

// Depot CI executes .depot/workflows/ci.yml; the .github copy is a manual
// workflow_dispatch fallback. The rules below are about what CI is permitted
// to do, so they apply to whichever file runs -- and the Depot copy is the one
// that runs on every push. Asserting them against .github alone would test the
// spare and leave the engine unchecked.
const depotWorkflowPath = path.join(candidateRoot, '.depot/workflows/ci.yml');
const depotContent = fs.readFileSync(depotWorkflowPath, 'utf8');
const depotLines = depotContent.split('\n');

const workflows = [
  { label: '.github/workflows/ci.yml', content, lines },
  { label: '.depot/workflows/ci.yml', content: depotContent, lines: depotLines }
];

// The steps list is the part the two copies must share. Their triggers and
// matrix legs diverge on purpose, so comparing whole files would fail on the
// intended differences and teach us to ignore the test.
function stepsBlock(sourceLines, label) {
  const start = sourceLines.findIndex((line) => /^\s*steps:\s*$/.test(line));
  assert.notEqual(start, -1, `${label} has no "steps:" block`);
  return sourceLines.slice(start).join('\n').trimEnd();
}

test('top-level permissions is exactly contents: read, and no other permissions block appears', () => {
  for (const workflow of workflows) {
    const permissionLines = workflow.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /permissions\s*:/.test(line));

    assert.equal(
      permissionLines.length,
      1,
      `${workflow.label}: expected exactly one line mentioning "permissions:", found ${permissionLines.length}`
    );

    const { line, index } = permissionLines[0];
    assert.match(
      line,
      /^permissions:\s*$/,
      `${workflow.label}: the permissions block must be top-level (no indentation) with no inline value, got: "${line}"`
    );

    let bodyIndex = index + 1;
    while (bodyIndex < workflow.lines.length && workflow.lines[bodyIndex].trim() === '') bodyIndex++;
    assert.ok(bodyIndex < workflow.lines.length, `${workflow.label}: permissions block has no body`);
    assert.match(
      workflow.lines[bodyIndex],
      /^\s{2}contents:\s*read\s*$/,
      `${workflow.label}: expected the sole permissions entry to be "  contents: read", got: "${workflow.lines[bodyIndex]}"`
    );

    let nextIndex = bodyIndex + 1;
    while (nextIndex < workflow.lines.length && workflow.lines[nextIndex].trim() === '') nextIndex++;
    if (nextIndex < workflow.lines.length) {
      const indent = workflow.lines[nextIndex].match(/^(\s*)/)[1].length;
      assert.ok(
        indent < 2,
        `${workflow.label}: permissions block must contain only "contents: read", found extra entry: "${workflow.lines[nextIndex]}"`
      );
    }
  }
});

test('every uses: line pins a 40-hex commit SHA with a trailing "# v" comment', () => {
  for (const workflow of workflows) {
    const usesLines = workflow.lines.filter((line) => /^\s*uses:\s*/.test(line));
    assert.ok(usesLines.length > 0, `expected at least one "uses:" line in ${workflow.label}`);
    for (const line of usesLines) {
      assert.match(
        line,
        /^\s*uses:\s*\S+@[0-9a-f]{40}\s*#\s*v\S+/,
        `${workflow.label}: "uses:" line must pin a 40-hex SHA followed by a "# v..." tag comment, got: "${line}"`
      );
    }
  }
});

test('the matrix includes both Node 24.x and 26.x', () => {
  for (const workflow of workflows) {
    assert.ok(workflow.content.includes('24.x'), `${workflow.label}: expected the matrix to include "24.x"`);
    assert.ok(workflow.content.includes('26.x'), `${workflow.label}: expected the matrix to include "26.x"`);
  }
});

test('the workflow never references secrets, npm install/ci, upload-artifact, or GITHUB_TOKEN', () => {
  const forbiddenFragments = ['secrets.', 'npm install', 'npm ci', 'upload-artifact', 'GITHUB_TOKEN'];
  for (const workflow of workflows) {
    for (const line of workflow.lines) {
      for (const fragment of forbiddenFragments) {
        assert.ok(
          !line.includes(fragment),
          `${workflow.label}: line contains forbidden fragment "${fragment}": "${line}"`
        );
      }
    }
  }
});

test('every "npm run <script>" invoked is listed in allowed_scripts', () => {
  const candidateConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'config/public-candidate.json'), 'utf8')
  );
  const allowed = new Set(candidateConfig.allowed_scripts);

  for (const workflow of workflows) {
    const invoked = new Set();
    const pattern = /npm run ([A-Za-z0-9_:.-]+)/g;
    let match;
    while ((match = pattern.exec(workflow.content)) !== null) {
      invoked.add(match[1]);
    }

    assert.ok(invoked.size > 0, `expected at least one "npm run" invocation in ${workflow.label}`);
    for (const name of invoked) {
      assert.ok(
        allowed.has(name),
        `${workflow.label}: "npm run ${name}" is not in config/public-candidate.json allowed_scripts`
      );
    }
  }
});

test('a build reproducibility step exists', () => {
  for (const workflow of workflows) {
    const hasHashTool = workflow.lines.some((line) => /sha256sum|shasum/.test(line));
    assert.ok(
      hasHashTool,
      `${workflow.label}: expected a step referencing sha256sum or shasum to check build reproducibility`
    );
  }
});

test('the candidate .github tree contains only its declared files', () => {
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
  // The inventory is asserted rather than bounded to the workflow alone: the
  // repository is public and takes contributions, so contributor-facing
  // templates belong here. Anything arriving outside this list is unreviewed.
  assert.deepEqual(files.sort(), [
    '.github/FUNDING.yml',
    '.github/ISSUE_TEMPLATE/bug_report.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/feature_request.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/workflows/ci.yml'
  ]);
});

test('the two workflow copies share an identical steps list', () => {
  // The copies exist because Depot CI and GitHub Actions read different paths,
  // not because they should do different work. Nothing in either file records
  // what the other contains, so a step added to one rots silently in the other:
  // the inventory's pinned hashes notice a change but cannot notice an omission.
  assert.equal(
    stepsBlock(depotLines, '.depot/workflows/ci.yml'),
    stepsBlock(lines, '.github/workflows/ci.yml'),
    'the steps lists have drifted; a change to one copy must be made in the other'
  );
});

test('the copies diverge only in their triggers and their matrix legs', () => {
  // Pinning the intended differences means an unintended one fails here rather
  // than being absorbed as "some divergence is expected".
  const triggers = (sourceLines) => {
    const start = sourceLines.findIndex((line) => /^on:\s*$/.test(line));
    assert.notEqual(start, -1, 'no "on:" block');
    let end = start + 1;
    while (end < sourceLines.length && (sourceLines[end].startsWith(' ') || sourceLines[end].trim() === '')) end++;
    return sourceLines.slice(start, end).map((line) => line.trim()).filter(Boolean);
  };

  assert.deepEqual(triggers(lines), ['on:', 'workflow_dispatch:']);
  assert.deepEqual(triggers(depotLines), [
    'on:',
    'push:',
    'branches:',
    '- main',
    'pull_request:',
    'workflow_dispatch:'
  ]);
});

test('the candidate .depot tree contains only the Depot CI workflow', () => {
  const depotRoot = path.join(candidateRoot, '.depot');
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

  walk(depotRoot);
  // `depot ci migrate` also writes .depot/actions/ when a workflow uses a local
  // action. This repo's workflow uses none, so anything beyond the one file is
  // either a migration artefact nobody reviewed or a local action that would
  // execute unpinned code in CI.
  assert.deepEqual(files.sort(), ['.depot/workflows/ci.yml']);
});

test('every eval step runs under --strict', () => {
  // The evals grade FAIL and WARN separately, and --strict is what makes a WARN
  // stop the build. Without it the warning tier is decorative: a check that
  // softens from FAIL to WARN, or a new warning condition, keeps CI green
  // forever. Asserted per copy so dropping the flag from one is a test failure
  // rather than a silent loss of enforcement.
  const evalScripts = ['eval', 'eval:code', 'eval:dashboard', 'eval:served'];
  for (const workflow of workflows) {
    for (const script of evalScripts) {
      const pattern = new RegExp(`run:\\s*npm run ${script.replace(':', ':')}\\s+--\\s+--strict\\s*$`, 'm');
      assert.match(
        workflow.content,
        pattern,
        `${workflow.label}: "npm run ${script}" must be invoked with -- --strict`
      );
    }
  }
});
