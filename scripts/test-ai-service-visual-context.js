#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createVisualContextStore } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'visual-context.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

const store = createVisualContextStore({ maxVisualContext: 2 });

test('visual context keeps latest frame', () => {
  store.clearVisualContext();
  store.addVisualContext({ dataURL: 'data:image/png;base64,AA==', width: 10, height: 10 });
  const latest = store.getLatestVisualContext();
  assert.strictEqual(latest.width, 10);
  assert.strictEqual(store.getVisualContextCount(), 1);
});

test('visual context evicts old frames beyond limit', () => {
  store.clearVisualContext();
  store.addVisualContext({ dataURL: 'data:image/png;base64,AA==', width: 10, height: 10 });
  store.addVisualContext({ dataURL: 'data:image/png;base64,BB==', width: 20, height: 20 });
  store.addVisualContext({ dataURL: 'data:image/png;base64,CC==', width: 30, height: 30 });
  assert.strictEqual(store.getVisualContextCount(), 2);
  assert.strictEqual(store.getLatestVisualContext().width, 30);
});
