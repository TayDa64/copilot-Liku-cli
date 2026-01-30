/**
 * Tests for Agent State Manager
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { AgentStateManager } = require('../../src/main/agents/state-manager');

describe('AgentStateManager', () => {
  let tempDir;
  let statePath;
  let stateManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    statePath = path.join(tempDir, 'agent_state.json');
    stateManager = new AgentStateManager(statePath);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    test('initializes with schema v2', () => {
      const state = stateManager.getFullState();
      expect(state.schemaVersion).toBe(2);
      expect(state.version).toBe('1.1.0');
    });

    test('includes all required v2 fields', () => {
      const state = stateManager.getFullState();
      expect(state).toHaveProperty('modelMetadata');
      expect(state).toHaveProperty('sessionContext');
      expect(state).toHaveProperty('checkpoints');
      expect(state).toHaveProperty('queue');
      expect(state).toHaveProperty('inProgress');
      expect(state).toHaveProperty('completed');
      expect(state).toHaveProperty('failed');
      expect(state).toHaveProperty('agents');
      expect(state).toHaveProperty('sessions');
    });

    test('initializes modelMetadata with default values', () => {
      const state = stateManager.getFullState();
      expect(state.modelMetadata).toEqual({
        modelId: 'unknown',
        provider: 'unknown',
        modelVersion: null,
        capabilities: []
      });
    });
  });

  describe('State Migration', () => {
    test('migrates v1 state to v2 automatically', () => {
      // Create a v1 state file
      const v1State = {
        version: '1.0.0',
        created: new Date().toISOString(),
        queue: [],
        inProgress: [],
        completed: [],
        failed: [],
        agents: {},
        sessions: []
      };
      
      fs.writeFileSync(statePath, JSON.stringify(v1State, null, 2));
      
      // Load the state - should trigger migration
      const migratedManager = new AgentStateManager(statePath);
      const state = migratedManager.getFullState();
      
      expect(state.schemaVersion).toBe(2);
      expect(state.version).toBe('1.1.0');
      expect(state).toHaveProperty('modelMetadata');
      expect(state).toHaveProperty('sessionContext');
      expect(state).toHaveProperty('checkpoints');
    });

    test('adds modelMetadata during migration', () => {
      const v1State = {
        version: '1.0.0',
        created: new Date().toISOString(),
        queue: [],
        inProgress: [],
        completed: [],
        failed: [],
        agents: {},
        sessions: []
      };
      
      fs.writeFileSync(statePath, JSON.stringify(v1State, null, 2));
      
      const migratedManager = new AgentStateManager(statePath);
      const state = migratedManager.getFullState();
      
      expect(state.modelMetadata).toBeDefined();
      expect(state.modelMetadata.modelId).toBe('unknown');
      expect(state.modelMetadata.provider).toBe('unknown');
    });

    test('adds sessionContext during migration', () => {
      const v1State = {
        version: '1.0.0',
        created: new Date().toISOString(),
        queue: [],
        inProgress: [],
        completed: [],
        failed: [],
        agents: {},
        sessions: []
      };
      
      fs.writeFileSync(statePath, JSON.stringify(v1State, null, 2));
      
      const migratedManager = new AgentStateManager(statePath);
      const state = migratedManager.getFullState();
      
      expect(state.sessionContext).toBeDefined();
      expect(state.sessionContext.initiatedBy).toBeNull();
      expect(state.sessionContext.purpose).toBeNull();
    });

    test('adds checkpoints array during migration', () => {
      const v1State = {
        version: '1.0.0',
        created: new Date().toISOString(),
        queue: [],
        inProgress: [],
        completed: [],
        failed: [],
        agents: {},
        sessions: []
      };
      
      fs.writeFileSync(statePath, JSON.stringify(v1State, null, 2));
      
      const migratedManager = new AgentStateManager(statePath);
      const state = migratedManager.getFullState();
      
      expect(state.checkpoints).toBeDefined();
      expect(Array.isArray(state.checkpoints)).toBe(true);
      expect(state.checkpoints.length).toBe(0);
    });
  });

  describe('Checkpoint Management', () => {
    test('createCheckpoint() creates checkpoint with required fields', () => {
      const sessionId = 'test-session';
      const label = 'test-checkpoint';
      const agentStates = [{ agent: 'builder', state: {} }];
      const handoffHistory = [{ from: 'supervisor', to: 'builder' }];
      
      const checkpoint = stateManager.createCheckpoint(sessionId, label, agentStates, handoffHistory);
      
      expect(checkpoint).toHaveProperty('id');
      expect(checkpoint).toHaveProperty('label');
      expect(checkpoint).toHaveProperty('sessionId');
      expect(checkpoint).toHaveProperty('timestamp');
      expect(checkpoint).toHaveProperty('agentStates');
      expect(checkpoint.sessionId).toBe(sessionId);
      expect(checkpoint.label).toBe(label);
      expect(checkpoint.agentStates).toEqual(agentStates);
      expect(checkpoint.handoffHistory).toEqual(handoffHistory);
    });

    test('getCheckpoint() retrieves checkpoint by id', () => {
      const sessionId = 'test-session';
      const label = 'test-checkpoint';
      
      const created = stateManager.createCheckpoint(sessionId, label, [], []);
      const retrieved = stateManager.getCheckpoint(created.id);
      
      expect(retrieved).toEqual(created);
    });

    test('getCheckpoint() returns null for non-existent id', () => {
      const result = stateManager.getCheckpoint('non-existent-id');
      expect(result).toBeNull();
    });

    test('listCheckpoints() filters by sessionId', () => {
      const session1 = 'session-1';
      const session2 = 'session-2';
      
      stateManager.createCheckpoint(session1, 'checkpoint-1', [], []);
      stateManager.createCheckpoint(session1, 'checkpoint-2', [], []);
      stateManager.createCheckpoint(session2, 'checkpoint-3', [], []);
      
      const session1Checkpoints = stateManager.listCheckpoints(session1);
      
      expect(session1Checkpoints.length).toBe(2);
      expect(session1Checkpoints.every(cp => cp.sessionId === session1)).toBe(true);
    });

    test('listCheckpoints() returns all checkpoints when no sessionId provided', () => {
      stateManager.createCheckpoint('session-1', 'checkpoint-1', [], []);
      stateManager.createCheckpoint('session-2', 'checkpoint-2', [], []);
      
      const allCheckpoints = stateManager.listCheckpoints();
      
      expect(allCheckpoints.length).toBe(2);
    });
  });

  describe('Model Metadata Management', () => {
    test('setModelMetadata() updates state.modelMetadata', () => {
      const metadata = {
        modelId: 'gpt-4o',
        provider: 'openai',
        modelVersion: '2024-05-13',
        capabilities: ['vision', 'text']
      };
      
      stateManager.setModelMetadata(metadata);
      const state = stateManager.getFullState();
      
      expect(state.modelMetadata.modelId).toBe('gpt-4o');
      expect(state.modelMetadata.provider).toBe('openai');
      expect(state.modelMetadata.modelVersion).toBe('2024-05-13');
      expect(state.modelMetadata.capabilities).toEqual(['vision', 'text']);
    });

    test('setModelMetadata() adds lastUpdated timestamp', () => {
      const metadata = {
        modelId: 'gpt-4o',
        provider: 'openai'
      };
      
      stateManager.setModelMetadata(metadata);
      const state = stateManager.getFullState();
      
      expect(state.modelMetadata).toHaveProperty('lastUpdated');
      expect(state.modelMetadata.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('State File Path Generation', () => {
    test('_getStateFilePath() generates filename-safe paths', () => {
      const filePath = stateManager._getStateFilePath();
      
      expect(filePath).not.toContain(':');
      expect(filePath).toContain('state-');
      expect(filePath.endsWith('.json')).toBe(true);
    });

    test('_getStateFilePath() includes model suffix when provided', () => {
      const filePath = stateManager._getStateFilePath(null, 'gpt-4o');
      
      expect(filePath).toContain('-gpt-4o');
    });

    test('_getStateFilePath() includes session suffix when provided', () => {
      const sessionId = 'session-123456789';
      const filePath = stateManager._getStateFilePath(sessionId);
      
      // Should include last 8 characters of sessionId
      expect(filePath).toContain('-23456789');
    });

    test('_getStateFilePath() includes both suffixes when both provided', () => {
      const sessionId = 'session-123456789';
      const modelId = 'gpt-4o';
      const filePath = stateManager._getStateFilePath(sessionId, modelId);
      
      expect(filePath).toContain('-gpt-4o');
      // Should include last 8 characters of sessionId
      expect(filePath).toContain('-23456789');
    });
  });

  describe('reset()', () => {
    test('creates fresh v2 state', () => {
      // Modify the state
      stateManager.enqueue({ description: 'test task' });
      stateManager.setModelMetadata({ modelId: 'custom-model' });
      stateManager.createCheckpoint('session-1', 'checkpoint-1', [], []);
      
      // Reset
      stateManager.reset();
      const state = stateManager.getFullState();
      
      expect(state.schemaVersion).toBe(2);
      expect(state.version).toBe('1.1.0');
      expect(state.queue.length).toBe(0);
      expect(state.checkpoints.length).toBe(0);
      expect(state.modelMetadata.modelId).toBe('unknown');
    });

    test('preserves state structure after reset', () => {
      stateManager.reset();
      const state = stateManager.getFullState();
      
      expect(state).toHaveProperty('modelMetadata');
      expect(state).toHaveProperty('sessionContext');
      expect(state).toHaveProperty('checkpoints');
      expect(state).toHaveProperty('queue');
      expect(state).toHaveProperty('inProgress');
      expect(state).toHaveProperty('completed');
    });
  });
});
