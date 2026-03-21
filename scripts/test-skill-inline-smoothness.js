#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-skill-proof-'));
const likuHome = path.join(sandboxRoot, '.liku');
process.env.LIKU_HOME_OVERRIDE = likuHome;
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(sandboxRoot, '.liku-cli-old');

const repoRoot = path.join(__dirname, '..');
const likuHomeModule = require(path.join(repoRoot, 'src', 'shared', 'liku-home.js'));
likuHomeModule.ensureLikuStructure();

const skillRouter = require(path.join(repoRoot, 'src', 'main', 'memory', 'skill-router.js'));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

function cleanupSandbox() {
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    // non-fatal in tests
  }
}

function resetSkills() {
  const skillsDir = path.join(likuHome, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const child of fs.readdirSync(skillsDir)) {
      fs.rmSync(path.join(skillsDir, child), { recursive: true, force: true });
    }
  }
  likuHomeModule.ensureLikuStructure();
}

function addGenericSkill() {
  skillRouter.addSkill('generic-browser-skill', {
    keywords: ['likusmooth', 'browser', 'apple'],
    tags: ['browser'],
    content: '# Generic browser skill\n\nUse the browser carefully.'
  });
}

function countSkillFiles() {
  const skillsDir = path.join(likuHome, 'skills');
  return fs.readdirSync(skillsDir).filter((name) => name.endsWith('.md')).length;
}

test('sandboxed LIKU_HOME keeps proof isolated from real ~/.liku', () => {
  assert.strictEqual(likuHomeModule.LIKU_HOME, likuHome);
  assert(fs.existsSync(path.join(likuHome, 'skills')), 'sandbox skills directory exists');
});

test('empty index returns no relevant skills', () => {
  resetSkills();
  const selection = skillRouter.getRelevantSkillsSelection('hello there');
  assert.deepStrictEqual(selection.ids, []);
  assert.strictEqual(selection.text, '');
});

test('non-matching query returns no relevant skills from isolated sandbox', () => {
  resetSkills();
  skillRouter.addSkill('non-matching-skill', {
    keywords: ['likusmoothalpha'],
    tags: ['automation'],
    content: '# Non matching\n\nDo something else.'
  });
  const selection = skillRouter.getRelevantSkillsSelection('tell me a joke');
  assert.deepStrictEqual(selection.ids, []);
  assert.strictEqual(selection.text, '');
});

test('repeated grounded success promotes a learned variant without creating duplicates', () => {
  resetSkills();
  const payload = {
    idHint: 'learned-variant',
    keywords: ['likusmooth', 'browser', 'apple'],
    tags: ['awm', 'browser'],
    scope: {
      processNames: ['likusmoothproc'],
      windowTitles: ['Liku Smooth Window'],
      domains: ['smooth.example.test']
    },
    verification: 'Apple page is open on the smooth domain',
    content: '# Open Apple in browser\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://smooth.example.test"\n4. key: enter'
  };

  const first = skillRouter.upsertLearnedSkill(payload);
  const second = skillRouter.upsertLearnedSkill(payload);

  assert.strictEqual(first.entry.status, 'candidate');
  assert.strictEqual(second.entry.status, 'promoted');
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(countSkillFiles(), 1);
});

test('slightly different scope builds a sibling variant in the same family', () => {
  resetSkills();
  const base = skillRouter.upsertLearnedSkill({
    idHint: 'family-variant',
    keywords: ['likusmooth', 'browser', 'apple'],
    tags: ['awm', 'browser'],
    scope: {
      processNames: ['likusmoothproc'],
      windowTitles: ['Liku Smooth Window'],
      domains: ['smooth.example.test']
    },
    verification: 'Primary page is open',
    content: '# Open Apple in browser\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://smooth.example.test"\n4. key: enter'
  });
  const promoted = skillRouter.upsertLearnedSkill({
    idHint: 'family-variant',
    keywords: ['likusmooth', 'browser', 'apple'],
    tags: ['awm', 'browser'],
    scope: {
      processNames: ['likusmoothproc'],
      windowTitles: ['Liku Smooth Window'],
      domains: ['smooth.example.test']
    },
    verification: 'Primary page is open',
    content: '# Open Apple in browser\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://smooth.example.test"\n4. key: enter'
  });
  const sibling = skillRouter.upsertLearnedSkill({
    idHint: 'family-variant',
    keywords: ['likusmooth', 'browser', 'apple'],
    tags: ['awm', 'browser'],
    scope: {
      processNames: ['likusmoothproc'],
      windowTitles: ['Liku Smooth Window'],
      domains: ['smooth-alt.example.test']
    },
    verification: 'Alternate page is open',
    content: '# Open Apple in browser\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://smooth-alt.example.test"\n4. key: enter'
  });

  assert.strictEqual(promoted.entry.status, 'promoted');
  assert.notStrictEqual(sibling.id, base.id);
  assert.strictEqual(sibling.entry.familySignature, promoted.entry.familySignature);
  assert.notStrictEqual(sibling.entry.variantSignature, promoted.entry.variantSignature);
  assert.strictEqual(countSkillFiles(), 2);
});

test('matching scoped promoted variant outranks a generic skill', () => {
  resetSkills();
  const payload = {
    idHint: 'ranked-variant',
    keywords: ['likusmooth', 'browser', 'apple'],
    tags: ['awm', 'browser'],
    scope: {
      processNames: ['likusmoothproc'],
      windowTitles: ['Liku Smooth Window'],
      domains: ['smooth.example.test']
    },
    content: '# Open Apple in browser\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://smooth.example.test"\n4. key: enter'
  };
  skillRouter.upsertLearnedSkill(payload);
  const promoted = skillRouter.upsertLearnedSkill(payload);
  addGenericSkill();

  const selection = skillRouter.getRelevantSkillsSelection('open likusmooth apple in browser', {
    currentProcessName: 'likusmoothproc',
    currentWindowTitle: 'Liku Smooth Window',
    currentUrlHost: 'smooth.example.test',
    limit: 1
  });

  assert.strictEqual(promoted.entry.status, 'promoted');
  assert.deepStrictEqual(selection.ids, [promoted.id]);
});

test('selection reads only the chosen skill files, not the whole corpus', () => {
  resetSkills();
  for (let index = 0; index < 8; index += 1) {
    skillRouter.addSkill(`bulk-skill-${index}`, {
      keywords: [`bulkkeyword${index}`, 'bulkbrowser'],
      tags: ['bulk'],
      content: `# Bulk ${index}\n\nSkill ${index}`
    });
  }
  skillRouter.addSkill('target-one', {
    keywords: ['likureadtarget', 'alpha'],
    tags: ['proof'],
    content: '# Target one\n\nPrimary target skill.'
  });
  skillRouter.addSkill('target-two', {
    keywords: ['likureadtarget', 'beta'],
    tags: ['proof'],
    content: '# Target two\n\nSecondary target skill.'
  });

  const originalRead = fs.readFileSync;
  let markdownReads = 0;
  fs.readFileSync = function patchedRead(filePath, ...args) {
    if (String(filePath).endsWith('.md') && String(filePath).includes(path.join('.liku', 'skills'))) {
      markdownReads += 1;
    }
    return originalRead.call(this, filePath, ...args);
  };

  try {
    const selection = skillRouter.getRelevantSkillsSelection('likureadtarget alpha beta', { limit: 2 });
    assert.deepStrictEqual(selection.ids, ['target-one', 'target-two']);
    assert.strictEqual(markdownReads, 2);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('learning smoothness stays within a small latency budget in sandbox', () => {
  resetSkills();
  for (let index = 0; index < 40; index += 1) {
    skillRouter.addSkill(`latency-skill-${index}`, {
      keywords: [`latency${index}`, 'smoothness', 'browser'],
      tags: ['latency'],
      content: `# Latency ${index}\n\nSkill ${index}`
    });
  }
  const startedAt = process.hrtime.bigint();
  const selection = skillRouter.getRelevantSkillsSelection('latency12 browser smoothness', { limit: 3 });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert(selection.ids.length >= 1, 'at least one skill selected');
  assert(elapsedMs < 50, `selection took ${elapsedMs.toFixed(2)}ms`);
});

cleanupSandbox();
if (failures > 0) {
  process.exitCode = 1;
}
