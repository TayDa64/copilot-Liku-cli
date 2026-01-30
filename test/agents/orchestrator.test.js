/**
 * Tests for Orchestrator checkpointing
 */

const { AgentOrchestrator } = require('../../src/main/agents/orchestrator');
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
    capabilities: ['text']
  })
});

describe('AgentOrchestrator', () => {
  let orchestrator;
  let mockAIService;
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
    statePath = path.join(tempDir, 'agent_state.json');
    mockAIService = createMockAIService();
    
    const stateManager = new AgentStateManager(statePath);
    orchestrator = new AgentOrchestrator({
      aiService: mockAIService,
      stateManager
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('_initializeAgents()', () => {
    test('passes modelMetadata to all agents', () => {
      const supervisor = orchestrator.getSupervisor();
      const builder = orchestrator.getBuilder();
      const verifier = orchestrator.getVerifier();
      const researcher = orchestrator.getResearcher();
      
      expect(supervisor.modelMetadata).toBeDefined();
      expect(builder.modelMetadata).toBeDefined();
      expect(verifier.modelMetadata).toBeDefined();
      expect(researcher.modelMetadata).toBeDefined();
      
      expect(supervisor.modelMetadata.modelId).toBe('gpt-4o');
      expect(builder.modelMetadata.modelId).toBe('gpt-4o');
    });
  });

  describe('checkpoint()', () => {
    test('creates checkpoint via stateManager', async () => {
      orchestrator.startSession({ test: 'session' });
      
      const checkpoint = await orchestrator.checkpoint('test-checkpoint');
      
      expect(checkpoint).toBeDefined();
      expect(checkpoint.label).toBe('test-checkpoint');
      expect(checkpoint.sessionId).toBe(orchestrator.currentSession.id);
    });

    test('emits checkpoint event', (done) => {
      orchestrator.startSession({ test: 'session' });
      
      orchestrator.on('checkpoint', (checkpoint) => {
        expect(checkpoint).toBeDefined();
        expect(checkpoint.label).toBe('test-checkpoint');
        done();
      });
      
      orchestrator.checkpoint('test-checkpoint');
    });

    test('includes agent states in checkpoint', async () => {
      orchestrator.startSession({ test: 'session' });
      
      const checkpoint = await orchestrator.checkpoint('test-checkpoint');
      
      expect(checkpoint.agentStates).toBeDefined();
      expect(Array.isArray(checkpoint.agentStates)).toBe(true);
      expect(checkpoint.agentStates.length).toBeGreaterThan(0);
    });

    test('returns null if no current session', async () => {
      const checkpoint = await orchestrator.checkpoint('test-checkpoint');
      
      expect(checkpoint).toBeNull();
    });
  });

  describe('restoreFromCheckpoint()', () => {
    test('restores handoffHistory', async () => {
      orchestrator.startSession({ test: 'session' });
      
      // Create some handoff history
      orchestrator.handoffHistory = [
        { from: 'supervisor', to: 'builder', message: 'Build this' },
        { from: 'builder', to: 'verifier', message: 'Verify this' }
      ];
      
      const checkpoint = await orchestrator.checkpoint('test-checkpoint');
      
      // Clear history
      orchestrator.handoffHistory = [];
      
      // Restore
      const restored = await orchestrator.restoreFromCheckpoint(checkpoint.id);
      
      expect(orchestrator.handoffHistory.length).toBe(2);
      expect(orchestrator.handoffHistory[0].from).toBe('supervisor');
    });

    test('emits checkpoint:restored event', (done) => {
      orchestrator.startSession({ test: 'session' });
      
      orchestrator.checkpoint('test-checkpoint').then((checkpoint) => {
        orchestrator.on('checkpoint:restored', (restored) => {
          expect(restored).toBeDefined();
          expect(restored.id).toBe(checkpoint.id);
          done();
        });
        
        orchestrator.restoreFromCheckpoint(checkpoint.id);
      });
    });

    test('throws for invalid checkpointId', async () => {
      await expect(
        orchestrator.restoreFromCheckpoint('invalid-id')
      ).rejects.toThrow('Checkpoint not found: invalid-id');
    });

    test('returns checkpoint data', async () => {
      orchestrator.startSession({ test: 'session' });
      const checkpoint = await orchestrator.checkpoint('test-checkpoint');
      
      const restored = await orchestrator.restoreFromCheckpoint(checkpoint.id);
      
      expect(restored).toBeDefined();
      expect(restored.id).toBe(checkpoint.id);
      expect(restored.label).toBe('test-checkpoint');
    });
  });

  describe('getState()', () => {
    test('includes checkpoints array', () => {
      orchestrator.startSession({ test: 'session' });
      
      const state = orchestrator.getState();
      
      expect(state.checkpoints).toBeDefined();
      expect(Array.isArray(state.checkpoints)).toBe(true);
    });

    test('includes current session', () => {
      orchestrator.startSession({ test: 'session' });
      
      const state = orchestrator.getState();
      
      expect(state.session).toBeDefined();
      expect(state.session.id).toBe(orchestrator.currentSession.id);
    });

    test('includes agents array', () => {
      const state = orchestrator.getState();
      
      expect(state.agents).toBeDefined();
      expect(Array.isArray(state.agents)).toBe(true);
      expect(state.agents.length).toBeGreaterThan(0);
    });
  });
});
