#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { UIAHost } = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'core', 'uia-host.js'));

const TEST_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.LIKU_TEST_TIMEOUT_MS || '30000', 10) || 30000
);

const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL uia host request queue timed out after ${TEST_TIMEOUT_MS}ms`);
  process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function flushTurns(turns = 2) {
  return (async () => {
    for (let index = 0; index < turns; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
}

function createMockHost() {
  const host = new UIAHost();
  const writes = [];
  const proc = {
    killed: false,
    stdin: {
      destroyed: false,
      write(line, callback) {
        writes.push(JSON.parse(String(line || '').trim()));
        if (typeof callback === 'function') {
          callback(null);
        }
        return true;
      },
      end() {},
      destroy() {
        this.destroyed = true;
      }
    },
    stdout: {
      destroy() {}
    },
    stderr: {
      destroy() {}
    }
  };

  host.start = async () => {
    host._alive = true;
    host._proc = proc;
  };

  return { host, writes, proc };
}

async function main() {
  await test('queues concurrent sends and dispatches them one at a time with request IDs', async () => {
    const { host, writes } = createMockHost();

    const firstPromise = host.send({ cmd: 'firstCommand' });
    const secondPromise = host.send({ cmd: 'secondCommand' });
    await flushTurns();

    assert.strictEqual(writes.length, 1, 'only the first request should be dispatched immediately');
    assert.strictEqual(writes[0].cmd, 'firstCommand');
    assert.ok(writes[0].requestId, 'outbound commands should carry a requestId');

    let secondResolved = false;
    secondPromise.then(() => {
      secondResolved = true;
    });

    host._onData(Buffer.from(`${JSON.stringify({
      ok: true,
      cmd: 'firstCommand',
      requestId: writes[0].requestId
    })}\n`));
    const firstResponse = await firstPromise;
    await flushTurns();

    assert.strictEqual(firstResponse.requestId, writes[0].requestId);
    assert.strictEqual(secondResolved, false, 'second request should stay queued until the first reply arrives');
    assert.strictEqual(writes.length, 2, 'second request should dispatch after the first resolves');
    assert.strictEqual(writes[1].cmd, 'secondCommand');
    assert.ok(writes[1].requestId, 'queued request should also receive a requestId');
    assert.notStrictEqual(writes[1].requestId, writes[0].requestId, 'request IDs should be unique');

    host._onData(Buffer.from(`${JSON.stringify({
      ok: true,
      cmd: 'secondCommand',
      requestId: writes[1].requestId
    })}\n`));
    const secondResponse = await secondPromise;
    assert.strictEqual(secondResponse.requestId, writes[1].requestId);
  });

  await test('falls back to legacy sequential replies when the host omits requestId', async () => {
    const { host, writes } = createMockHost();

    const responsePromise = host.send({ cmd: 'legacyCommand' });
    await flushTurns();

    assert.strictEqual(writes.length, 1);
    host._onData(Buffer.from(`${JSON.stringify({
      ok: true,
      cmd: 'legacyCommand'
    })}\n`));

    const response = await responsePromise;
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.cmd, 'legacyCommand');
    assert.strictEqual(host._pending, null, 'legacy reply should still clear the active request');
  });

  await test('routes UIA events without consuming the active request', async () => {
    const { host, writes } = createMockHost();
    const seenEvents = [];

    host.on('uia-event', (payload) => {
      seenEvents.push(payload);
    });

    const responsePromise = host.send({ cmd: 'eventfulCommand' });
    await flushTurns();

    assert.strictEqual(writes.length, 1);

    host._onData(Buffer.from(`${JSON.stringify({
      type: 'event',
      event: 'focusChanged',
      data: { activeWindow: { hwnd: 42 } }
    })}\n`));
    await flushTurns();

    assert.strictEqual(seenEvents.length, 1, 'event messages should still be emitted');
    assert.strictEqual(host._pending?.requestId, writes[0].requestId, 'event messages must not consume the active request');

    host._onData(Buffer.from(`${JSON.stringify({
      ok: true,
      cmd: 'eventfulCommand',
      requestId: writes[0].requestId
    })}\n`));
    const response = await responsePromise;
    assert.strictEqual(response.requestId, writes[0].requestId);
  });

  await test('ignores stale mismatched replies instead of resolving the wrong queued request', async () => {
    const { host, writes } = createMockHost();
    const orphanReplies = [];

    host.on('orphanResponse', (payload) => {
      orphanReplies.push(payload);
    });

    const firstPromise = host.send({ cmd: 'slowCommand' });
    const firstOutcome = firstPromise.then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error })
    );
    const secondPromise = host.send({ cmd: 'nextCommand' });
    await flushTurns();

    assert.strictEqual(writes.length, 1);
    const firstRequestId = writes[0].requestId;

    host._rejectActiveRequest(new Error('synthetic timeout'));
    host._dispatchNext();
    await flushTurns();

    assert.strictEqual(writes.length, 2, 'second request should dispatch after the first is rejected');
    const secondRequestId = writes[1].requestId;

    let secondResolved = false;
    secondPromise.then(() => {
      secondResolved = true;
    });

    host._onData(Buffer.from(`${JSON.stringify({
      ok: true,
      cmd: 'slowCommand',
      requestId: firstRequestId
    })}\n`));
    await flushTurns();

    assert.strictEqual(orphanReplies.length, 1, 'stale reply should be surfaced as orphaned');
    assert.strictEqual(secondResolved, false, 'stale reply must not resolve the next active request');
    assert.strictEqual(host._pending?.requestId, secondRequestId, 'second request should remain active');

    host._onData(Buffer.from(`${JSON.stringify({
      ok: true,
      cmd: 'nextCommand',
      requestId: secondRequestId
    })}\n`));
    const secondResponse = await secondPromise;
    const firstResult = await firstOutcome;

    assert.strictEqual(secondResponse.requestId, secondRequestId);
    assert.strictEqual(firstResult.status, 'rejected');
    assert.match(firstResult.error.message, /synthetic timeout/i);
  });
}

main()
  .catch((error) => {
    console.error('FAIL uia host request queue');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(forcedExitTimer);
  });
