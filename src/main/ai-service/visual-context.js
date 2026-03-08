function createVisualContextStore(options = {}) {
  const maxVisualContext = Number.isInteger(options.maxVisualContext) ? options.maxVisualContext : 5;
  let visualContextBuffer = [];

  function addVisualContext(imageData) {
    const { createVisualFrame } = require('../../shared/inspect-types');
    const frame = createVisualFrame(imageData);
    frame.addedAt = Date.now();
    visualContextBuffer.push(frame);

    while (visualContextBuffer.length > maxVisualContext) {
      visualContextBuffer.shift();
    }

    return frame;
  }

  function clearVisualContext() {
    visualContextBuffer = [];
  }

  function getLatestVisualContext() {
    return visualContextBuffer.length > 0
      ? visualContextBuffer[visualContextBuffer.length - 1]
      : null;
  }

  function getVisualContextCount() {
    return visualContextBuffer.length;
  }

  return {
    addVisualContext,
    clearVisualContext,
    getLatestVisualContext,
    getVisualContextCount
  };
}

module.exports = {
  createVisualContextStore
};
