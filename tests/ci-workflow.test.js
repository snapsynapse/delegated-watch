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

// GitHub Actions runs this one workflow on every push to main and every pull
// request, and its two verify jobs are required status checks on main. A
// second CI copy for another runner (Depot, until 2026-11-08) is not allowed
// back: that copy stopped running without any visible sign, and because it
// never posted GitHub checks, pull requests merged with zero checks.
const workflows = [{ label: '.github/workflows/ci.yml', content, lines }];

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
    '.github/repository-settings.json',
    '.github/workflows/ci.yml'
  ]);
});

test('CI runs on every push to main and every pull request', () => {
  // The required status checks on main are the verify jobs of this workflow.
  // Without the pull_request trigger a PR would show zero checks and could
  // never satisfy them; without push it would never verify main itself.
  // workflow_dispatch stays so a run can be fired by hand on any ref.
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  assert.notEqual(start, -1, 'no "on:" block');
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) end++;
  const triggers = lines.slice(start, end).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(triggers, ['on:', 'push:', 'branches:', '- main', 'pull_request:', 'workflow_dispatch:']);
});

test('the verify job names match the required status checks', () => {
  // GitHub names a matrix job "<name> (<node-version>, <os>)". The ruleset on
  // main requires those exact contexts, and .github/repository-settings.json
  // records them. Renaming the job or changing a matrix leg without updating
  // both would leave a required check that never reports, blocking every merge.
  const settings = JSON.parse(fs.readFileSync(path.join(candidateRoot, '.github/repository-settings.json'), 'utf8'));
  const required = settings.rulesets
    .flatMap((ruleset) => ruleset.rules)
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters.required_status_checks.map((check) => check.context));
  assert.match(content, /^  verify:\n    name: verify$/m, 'the verify job must keep the name "verify"');
  assert.deepEqual(required.sort(), ['verify (24.x, ubuntu-latest)', 'verify (26.x, ubuntu-latest)']);
});

test('there is no second CI workflow for another runner', () => {
  assert.equal(fs.existsSync(path.join(candidateRoot, '.depot')), false, '.depot/ must not exist');
  assert.deepEqual(fs.readdirSync(path.join(candidateRoot, '.github/workflows')), ['ci.yml']);
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
