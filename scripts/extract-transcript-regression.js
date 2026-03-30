#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_FIXTURE_DIR,
  buildFixtureSkeleton,
  sanitizeFixtureName,
  upsertFixtureBundleEntry
} = require(path.join(__dirname, 'transcript-regression-fixtures.js'));

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
}

function readTranscriptInput() {
  const transcriptFile = getArgValue('--transcript-file');
  if (transcriptFile) {
    return {
      transcript: fs.readFileSync(transcriptFile, 'utf8'),
      sourceTracePath: transcriptFile
    };
  }

  if (!process.stdin.isTTY) {
    return {
      transcript: fs.readFileSync(0, 'utf8'),
      sourceTracePath: null
    };
  }

  throw new Error('Provide --transcript-file <path> or pipe transcript text via stdin.');
}

function resolveOutputFile(fixtureName) {
  const explicit = getArgValue('--output-file');
  if (explicit) return explicit;
  return path.join(DEFAULT_FIXTURE_DIR, `${sanitizeFixtureName(fixtureName || 'runtime-transcript')}.json`);
}

function main() {
  const { transcript, sourceTracePath } = readTranscriptInput();
  const description = getArgValue('--description') || null;
  const capturedAt = getArgValue('--captured-at') || null;
  const requestedName = getArgValue('--fixture-name') || null;
  const skeleton = buildFixtureSkeleton({
    fixtureName: requestedName,
    description,
    transcript,
    sourceTracePath: getArgValue('--source-trace-path') || sourceTracePath,
    capturedAt
  });

  const outputFile = resolveOutputFile(skeleton.fixtureName);
  const shouldWrite = !hasFlag('--stdout-only');

  if (shouldWrite) {
    const stored = upsertFixtureBundleEntry(outputFile, skeleton.fixtureName, skeleton.entry, {
      overwrite: hasFlag('--overwrite')
    });
    console.log(`Saved transcript regression fixture: ${stored.filePath}`);
  }

  console.log(`Fixture: ${skeleton.fixtureName}`);
  console.log(`Prompts: ${skeleton.entry.prompts.length}`);
  console.log(`Assistant turns: ${skeleton.entry.assistantTurns.length}`);
  console.log(`Observed providers: ${(skeleton.entry.observedHeaders.providers || []).join(', ') || 'none'}`);
  console.log('');
  console.log(JSON.stringify({ [skeleton.fixtureName]: skeleton.entry }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = {
  readTranscriptInput,
  resolveOutputFile
};