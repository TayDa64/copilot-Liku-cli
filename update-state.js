const fs = require('fs');
const path = require('path');

const stateFile = path.join(__dirname, 'ui-automation-state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const uiProviderCode = fs.readFileSync(path.join(__dirname, 'src', 'main', 'ui-automation', 'core', 'ui-provider.js'), 'utf8');

const ipcCode = `const { ipcMain } = require('electron');
const { UIProvider } = require('./ui-provider');

function setupIPC() {
  const uiProvider = new UIProvider();
  
  ipcMain.handle('get-ui-tree', async () => {
    try {
      const tree = await uiProvider.getUITree();
      return { success: true, data: tree };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { setupIPC };`;

state.node_bridge = {
  status: 'completed',
  interface_code: uiProviderCode,
  ipc_code: ipcCode
};

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log('Updated state file');
