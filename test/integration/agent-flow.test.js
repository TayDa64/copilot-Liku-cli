/**
 * Integration tests for agent flow
 */

const {
  createAgentSystem,
  recoverFromCheckpoint
} = require('../../src/main/agents/index');
const { AgentStateManager } = require('../../src/main/agents/state-manager');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock AI service
const createMockAIService = () => ({
  chat: jest.fn().mockResolvedValue({
    text: 'Mock response',
    tokens: { prompt: 100, completion: 50 }
  }),
  getModelMetadata: jest.fn().mockReturnValue({
    modelId: 'gpt-4o',
    provider: 'openai',
    modelVersion: '2024-05-13',
    capabilities: ['text', 'vision']
  })
});

describe('Agent Flow Integration', () => {
  let tempDir;
  let statePath;
  let mockAIService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
    statePath = path.join(tempDir, 'agent_state.json');
    mockAIService = createMockAIService();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Checkpoint creation and recovery flow', () => {
    test('full checkpoint creation and recovery', async () => {
      // Create agent system
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      // Start session
      const sessionId = orchestrator.startSession({ purpose: 'test' });
      expect(sessionId).toBeDefined();
      
      // Add some handoff history
      orchestrator.handoffHistory = [
        { from: 'supervisor', to: 'builder', message: 'Build this', timestamp: new Date().toISOString() }
      ];
      
      // Create checkpoint
      const checkpoint = await orchestrator.checkpoint('test-checkpoint');
      expect(checkpoint).toBeDefined();
      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.sessionId).toBe(sessionId);
      
      // Clear handoff history
      orchestrator.handoffHistory = [];
      
      // Recover from checkpoint
      const recovered = await orchestrator.restoreFromCheckpoint(checkpoint.id);
      expect(recovered).toBeDefined();
      expect(orchestrator.handoffHistory.length).toBe(1);
      expect(orchestrator.handoffHistory[0].from).toBe('supervisor');
    });

    test('checkpoint persists across orchestrator instances', async () => {
      // Create first orchestrator
      const orchestrator1 = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      orchestrator1.startSession({ purpose: 'test' });
      const checkpoint = await orchestrator1.checkpoint('test-checkpoint');
      
      // Create new orchestrator with same state path
      const orchestrator2 = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      // Should be able to recover checkpoint
      const recovered = await orchestrator2.restoreFromCheckpoint(checkpoint.id);
      expect(recovered).toBeDefined();
      expect(recovered.id).toBe(checkpoint.id);
    });
  });

  describe('Model metadata propagation', () => {
    test('propagates from aiService through all agents', () => {
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      // Check state manager
      const state = orchestrator.stateManager.getFullState();
      expect(state.modelMetadata.modelId).toBe('gpt-4o');
      expect(state.modelMetadata.provider).toBe('openai');
      
      // Check all agents
      const supervisor = orchestrator.getSupervisor();
      const builder = orchestrator.getBuilder();
      const verifier = orchestrator.getVerifier();
      const researcher = orchestrator.getResearcher();
      
      expect(supervisor.modelMetadata.modelId).toBe('gpt-4o');
      expect(builder.modelMetadata.modelId).toBe('gpt-4o');
      expect(verifier.modelMetadata.modelId).toBe('gpt-4o');
      expect(researcher.modelMetadata.modelId).toBe('gpt-4o');
    });

    test('metadata includes all expected fields', () => {
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      const builder = orchestrator.getBuilder();
      
      expect(builder.modelMetadata.modelId).toBe('gpt-4o');
      expect(builder.modelMetadata.provider).toBe('openai');
      expect(builder.modelMetadata.modelVersion).toBe('2024-05-13');
      expect(builder.modelMetadata.capabilities).toEqual(['text', 'vision']);
    });
  });

  describe('State migration with real file I/O', () => {
    test('migrates v1 state to v2', () => {
      // Create v1 state file
      const v1State = {
        version: '1.0.0',
        created: new Date().toISOString(),
        queue: [{ id: 'task-1', description: 'Test task' }],
        inProgress: [],
        completed: [],
        failed: [],
        agents: {},
        sessions: []
      };
      
      fs.writeFileSync(statePath, JSON.stringify(v1State, null, 2));
      
      // Create state manager - should migrate automatically
      const stateManager = new AgentStateManager(statePath);
      const state = stateManager.getFullState();
      
      expect(state.schemaVersion).toBe(2);
      expect(state.version).toBe('1.1.0');
      expect(state.modelMetadata).toBeDefined();
      expect(state.sessionContext).toBeDefined();
      expect(state.checkpoints).toBeDefined();
      
      // Original data should be preserved
      expect(state.queue.length).toBe(1);
      expect(state.queue[0].id).toBe('task-1');
    });

    test('creates fresh state if file does not exist', () => {
      const stateManager = new AgentStateManager(statePath);
      const state = stateManager.getFullState();
      
      expect(state.schemaVersion).toBe(2);
      expect(state.version).toBe('1.1.0');
      expect(state.queue.length).toBe(0);
    });

    test('persists state to file', () => {
      const stateManager = new AgentStateManager(statePath);
      stateManager.enqueue({ description: 'Test task' });
      
      expect(fs.existsSync(statePath)).toBe(true);
      
      const content = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content);
      
      expect(state.queue.length).toBe(1);
      expect(state.queue[0].description).toBe('Test task');
    });
  });

  describe('Builder rollback with real file operations', () => {
    test('rollback works with real files', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "original"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      const builder = orchestrator.getBuilder();
      
      // Create rollback data
      const rollbackData = [
        {
          file: testFile,
          originalContent,
          timestamp: new Date().toISOString()
        }
      ];
      
      // Modify file
      fs.writeFileSync(testFile, 'function test() { return "modified"; }');
      
      // Rollback
      const results = await builder.rollback(rollbackData);
      
      expect(results[0].success).toBe(true);
      
      const restoredContent = fs.readFileSync(testFile, 'utf-8');
      expect(restoredContent).toBe(originalContent);
    });

    test('creates proof entry for rollback', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "original"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      const builder = orchestrator.getBuilder();
      builder.proofChain = [];
      
      const rollbackData = [
        {
          file: testFile,
          originalContent,
          timestamp: new Date().toISOString()
        }
      ];
      
      fs.writeFileSync(testFile, 'function test() { return "modified"; }');
      
      await builder.rollback(rollbackData);
      
      expect(builder.proofChain.length).toBe(1);
      expect(builder.proofChain[0].type).toBe('rollback');
      expect(builder.proofChain[0].file).toBe(testFile);
      expect(builder.proofChain[0].agentId).toBe(builder.id);
    });
  });

  describe('End-to-end session flow', () => {
    test('complete session with checkpoints', async () => {
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      // Start session
      const sessionId = orchestrator.startSession({ purpose: 'test integration' });
      
      // Create initial checkpoint
      const checkpoint1 = await orchestrator.checkpoint('initial');
      expect(checkpoint1.sessionId).toBe(sessionId);
      
      // Simulate some work
      orchestrator.handoffHistory.push({
        from: 'supervisor',
        to: 'builder',
        message: 'Build feature',
        timestamp: new Date().toISOString()
      });
      
      // Create progress checkpoint
      const checkpoint2 = await orchestrator.checkpoint('progress');
      expect(checkpoint2.sessionId).toBe(sessionId);
      
      // List checkpoints for session
      const checkpoints = orchestrator.stateManager.listCheckpoints(sessionId);
      expect(checkpoints.length).toBe(2);
      expect(checkpoints[0].label).toBe('initial');
      expect(checkpoints[1].label).toBe('progress');
      
      // End session
      const endedSession = orchestrator.endSession({ status: 'completed' });
      expect(endedSession.id).toBe(sessionId);
      expect(endedSession.endedAt).toBeDefined();
    });
  });
});
