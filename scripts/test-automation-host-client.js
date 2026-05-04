'use strict';

const { getAutomationHostClient } = require('../src/main/automation-host-client');

function readField(object, camelKey, pascalKey) {
  if (!object || typeof object !== 'object') return undefined;
  if (typeof object[camelKey] !== 'undefined') return object[camelKey];
  return object[pascalKey];
}

async function main() {
  const client = getAutomationHostClient();
  const readyNotifications = [];
  const unsubscribe = client.onNotification('host/ready', (payload) => readyNotifications.push(payload));

  try {
    const ping = await client.ping({ message: 'phase0-smoke' });
    const pingMessage = readField(ping, 'message', 'Message');
    if (!ping || !pingMessage) {
      throw new Error(`Unexpected ping payload: ${JSON.stringify(ping)}`);
    }

    const invoke = await client.invoke('ping', { message: 'phase0-invoke' });
    const invokeSuccess = readField(invoke, 'success', 'Success');
    const invokeResult = readField(invoke, 'result', 'Result');
    const invokeMessage = readField(invokeResult, 'message', 'Message');
    if (!invoke || invokeSuccess !== true || !invokeMessage) {
      throw new Error(`Unexpected invoke payload: ${JSON.stringify(invoke)}`);
    }

    const batch = await client.invokeBatch([
      { method: 'ping', params: { message: 'batch-one' } },
      { method: 'ping', params: { message: 'batch-two' } }
    ]);

    const batchCount = readField(batch, 'count', 'Count');
    const batchResults = readField(batch, 'results', 'Results');
    if (!batch || batchCount !== 2 || !Array.isArray(batchResults) || batchResults.some((item) => readField(item, 'success', 'Success') !== true)) {
      throw new Error(`Unexpected batch payload: ${JSON.stringify(batch)}`);
    }

    console.log(JSON.stringify({ ok: true, ping, invoke, batch, readyNotifications }, null, 2));
  } finally {
    unsubscribe();
    await client.stop('phase0-smoke-complete');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});