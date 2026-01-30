/**
 * Tests for module exports
 */

const {
  AgentOrchestrator,
  SupervisorAgent,
  BuilderAgent,
  VerifierAgent,
  ResearcherAgent,
  AgentStateManager,
  createAgentSystem,
  recoverFromCheckpoint
} = require('../../src/main/agents/index');

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

describe('Agents Module', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
    statePath = path.join(tempDir, 'agent_state.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Module exports', () => {
    test('exports AgentOrchestrator', () => {
      expect(AgentOrchestrator).toBeDefined();
      expect(typeof AgentOrchestrator).toBe('function');
    });

    test('exports SupervisorAgent', () => {
      expect(SupervisorAgent).toBeDefined();
      expect(typeof SupervisorAgent).toBe('function');
    });

    test('exports BuilderAgent', () => {
      expect(BuilderAgent).toBeDefined();
      expect(typeof BuilderAgent).toBe('function');
    });

    test('exports VerifierAgent', () => {
      expect(VerifierAgent).toBeDefined();
      expect(typeof VerifierAgent).toBe('function');
    });

    test('exports ResearcherAgent', () => {
      expect(ResearcherAgent).toBeDefined();
      expect(typeof ResearcherAgent).toBe('function');
    });

    test('exports AgentStateManager', () => {
      expect(AgentStateManager).toBeDefined();
      expect(typeof AgentStateManager).toBe('function');
    });

    test('exports createAgentSystem', () => {
      expect(createAgentSystem).toBeDefined();
      expect(typeof createAgentSystem).toBe('function');
    });

    test('exports recoverFromCheckpoint', () => {
      expect(recoverFromCheckpoint).toBeDefined();
      expect(typeof recoverFromCheckpoint).toBe('function');
    });
  });

  describe('createAgentSystem()', () => {
    test('passes modelMetadata to stateManager', () => {
      const mockAIService = createMockAIService();
      
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      expect(orchestrator).toBeDefined();
      expect(orchestrator instanceof AgentOrchestrator).toBe(true);
      
      const state = orchestrator.stateManager.getFullState();
      expect(state.modelMetadata).toBeDefined();
      expect(state.modelMetadata.modelId).toBe('gpt-4o');
    });

    test('passes modelMetadata to orchestrator', () => {
      const mockAIService = createMockAIService();
      
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath
      });
      
      // Check that agents have modelMetadata
      const builder = orchestrator.getBuilder();
      expect(builder.modelMetadata).toBeDefined();
      expect(builder.modelMetadata.modelId).toBe('gpt-4o');
    });

    test('creates orchestrator with provided options', () => {
      const mockAIService = createMockAIService();
      
      const orchestrator = createAgentSystem({
        aiService: mockAIService,
        statePath,
        maxRecursionDepth: 5,
        maxSubCalls: 20
      });
      
      expect(orchestrator.maxRecursionDepth).toBe(5);
      expect(orchestrator.maxSubCalls).toBe(20);
    });

    test('works without aiService', () => {
      const orchestrator = createAgentSystem({
        statePath
      });
      
      expect(orchestrator).toBeDefined();
      expect(orchestrator instanceof AgentOrchestrator).toBe(true);
    });
  });

  describe('recoverFromCheckpoint()', () => {
    test('returns checkpoint for valid id', () => {
      const stateManager = new AgentStateManager(statePath);
      const checkpoint = stateManager.createCheckpoint('session-1', 'test-checkpoint', [], []);
      
      const recovered = recoverFromCheckpoint(checkpoint.id, { statePath });
      
      expect(recovered).toBeDefined();
      expect(recovered.id).toBe(checkpoint.id);
      expect(recovered.label).toBe('test-checkpoint');
    });

    test('throws for invalid id', () => {
      expect(() => {
        recoverFromCheckpoint('invalid-id', { statePath });
      }).toThrow('Checkpoint not found: invalid-id');
    });

    test('returns checkpoint with correct structure', () => {
      const stateManager = new AgentStateManager(statePath);
      const agentStates = [{ agent: 'builder', state: {} }];
      const handoffHistory = [{ from: 'supervisor', to: 'builder' }];
      
      const checkpoint = stateManager.createCheckpoint(
        'session-1',
        'test-checkpoint',
        agentStates,
        handoffHistory
      );
      
      const recovered = recoverFromCheckpoint(checkpoint.id, { statePath });
      
      expect(recovered.sessionId).toBe('session-1');
      expect(recovered.agentStates).toEqual(agentStates);
      expect(recovered.handoffHistory).toEqual(handoffHistory);
    });

    test('uses default state path if not provided', () => {
      // This test verifies the function can be called without statePath option
      // It will fail to find the checkpoint but should not throw on missing statePath
      expect(() => {
        recoverFromCheckpoint('invalid-id');
      }).toThrow('Checkpoint not found: invalid-id');
    });
  });
});
