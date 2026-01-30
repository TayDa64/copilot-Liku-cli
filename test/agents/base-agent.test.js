/**
 * Tests for Base Agent enhancements
 */

const { BaseAgent, AgentRole, AgentCapabilities } = require('../../src/main/agents/base-agent');

// Mock AI service
const createMockAIService = () => ({
  chat: jest.fn().mockResolvedValue({
    text: 'Mock response',
    tokens: { prompt: 100, completion: 50 }
  })
});

describe('BaseAgent', () => {
  let agent;
  let mockAIService;

  beforeEach(() => {
    mockAIService = createMockAIService();
    agent = new BaseAgent({
      role: AgentRole.BUILDER,
      name: 'test-agent',
      aiService: mockAIService,
      modelMetadata: {
        modelId: 'gpt-4o',
        provider: 'openai',
        capabilities: ['text']
      }
    });
  });

  describe('Constructor', () => {
    test('initializes modelMetadata', () => {
      expect(agent.modelMetadata).toBeDefined();
      expect(agent.modelMetadata.modelId).toBe('gpt-4o');
    });

    test('initializes proofChain as empty array', () => {
      expect(agent.proofChain).toBeDefined();
      expect(Array.isArray(agent.proofChain)).toBe(true);
      expect(agent.proofChain.length).toBe(0);
    });

    test('initializes toolHistory as empty array', () => {
      expect(agent.toolHistory).toBeDefined();
      expect(Array.isArray(agent.toolHistory)).toBe(true);
      expect(agent.toolHistory.length).toBe(0);
    });

    test('initializes metrics with default values', () => {
      expect(agent.metrics).toBeDefined();
      expect(agent.metrics.totalCalls).toBe(0);
      expect(agent.metrics.successfulCalls).toBe(0);
      expect(agent.metrics.failedCalls).toBe(0);
      expect(agent.metrics.avgResponseTimeMs).toBe(0);
      expect(agent.metrics.tokenUsage).toEqual({ prompt: 0, completion: 0 });
    });
  });

  describe('addStructuredProof()', () => {
    test('creates proof with required fields', () => {
      const proofData = {
        type: 'test-proof',
        content: 'Test content',
        source: 'test-source'
      };
      
      const proof = agent.addStructuredProof(proofData);
      
      expect(proof).toHaveProperty('id');
      expect(proof).toHaveProperty('timestamp');
      expect(proof).toHaveProperty('agentId');
      expect(proof).toHaveProperty('agentRole');
      expect(proof).toHaveProperty('modelMetadata');
      expect(proof.id).toMatch(/^proof-/);
      expect(proof.agentId).toBe(agent.id);
      expect(proof.agentRole).toBe(agent.role);
    });

    test('includes modelMetadata in proof', () => {
      const proofData = {
        type: 'test-proof',
        content: 'Test content'
      };
      
      const proof = agent.addStructuredProof(proofData);
      
      expect(proof.modelMetadata).toEqual(agent.modelMetadata);
    });

    test('adds proof to proofChain', () => {
      const proofData = {
        type: 'test-proof',
        content: 'Test content'
      };
      
      agent.addStructuredProof(proofData);
      
      expect(agent.proofChain.length).toBe(1);
      expect(agent.proofChain[0].type).toBe('test-proof');
    });

    test('emits proof event', (done) => {
      const proofData = {
        type: 'test-proof',
        content: 'Test content'
      };
      
      agent.on('proof', (proof) => {
        expect(proof.type).toBe('test-proof');
        expect(proof.content).toBe('Test content');
        done();
      });
      
      agent.addStructuredProof(proofData);
    });

    test('returns the structured proof object', () => {
      const proofData = {
        type: 'test-proof',
        content: 'Test content'
      };
      
      const proof = agent.addStructuredProof(proofData);
      
      expect(proof).toBeDefined();
      expect(proof.type).toBe('test-proof');
      expect(proof.content).toBe('Test content');
    });
  });

  describe('recordToolExecution()', () => {
    test('tracks success counts', () => {
      agent.recordToolExecution('read', { file: 'test.js' }, { content: 'test' }, 100, true);
      
      expect(agent.metrics.totalCalls).toBe(1);
      expect(agent.metrics.successfulCalls).toBe(1);
      expect(agent.metrics.failedCalls).toBe(0);
    });

    test('tracks failure counts', () => {
      agent.recordToolExecution('read', { file: 'test.js' }, 'error', 100, false);
      
      expect(agent.metrics.totalCalls).toBe(1);
      expect(agent.metrics.successfulCalls).toBe(0);
      expect(agent.metrics.failedCalls).toBe(1);
    });

    test('calculates rolling average response time', () => {
      agent.recordToolExecution('read', {}, {}, 100, true);
      agent.recordToolExecution('read', {}, {}, 200, true);
      agent.recordToolExecution('read', {}, {}, 300, true);
      
      // Note: The implementation uses a cumulative moving average
      // (total time / total calls), not a fixed-window rolling average
      expect(agent.metrics.avgResponseTimeMs).toBe(200);
    });

    test('adds entry to toolHistory', () => {
      agent.recordToolExecution('read', { file: 'test.js' }, { content: 'test' }, 100, true);
      
      expect(agent.toolHistory.length).toBe(1);
      expect(agent.toolHistory[0].toolName).toBe('read');
      expect(agent.toolHistory[0].success).toBe(true);
      expect(agent.toolHistory[0].durationMs).toBe(100);
    });

    test('stores output for successful calls', () => {
      const output = { content: 'test content' };
      agent.recordToolExecution('read', {}, output, 100, true);
      
      expect(agent.toolHistory[0].output).toEqual(output);
      expect(agent.toolHistory[0].error).toBeNull();
    });

    test('stores error for failed calls', () => {
      const error = 'File not found';
      agent.recordToolExecution('read', {}, error, 100, false);
      
      expect(agent.toolHistory[0].output).toBeNull();
      expect(agent.toolHistory[0].error).toBe(error);
    });
  });

  describe('getState()', () => {
    test('includes modelMetadata', () => {
      const state = agent.getState();
      
      expect(state.modelMetadata).toBeDefined();
      expect(state.modelMetadata).toEqual(agent.modelMetadata);
    });

    test('includes proofChainLength', () => {
      agent.addStructuredProof({ type: 'test' });
      agent.addStructuredProof({ type: 'test2' });
      
      const state = agent.getState();
      
      expect(state.proofChainLength).toBe(2);
    });

    test('includes metrics', () => {
      agent.recordToolExecution('read', {}, {}, 100, true);
      
      const state = agent.getState();
      
      expect(state.metrics).toBeDefined();
      expect(state.metrics.totalCalls).toBe(1);
      expect(state.metrics.successfulCalls).toBe(1);
    });

    test('includes lastActivity timestamp', () => {
      const state = agent.getState();
      
      expect(state.lastActivity).toBeDefined();
      expect(state.lastActivity).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('includes base agent properties', () => {
      const state = agent.getState();
      
      expect(state.id).toBe(agent.id);
      expect(state.role).toBe(agent.role);
      expect(state.name).toBe(agent.name);
    });
  });

  describe('reset()', () => {
    test('clears proofChain', () => {
      agent.addStructuredProof({ type: 'test' });
      agent.addStructuredProof({ type: 'test2' });
      
      agent.reset();
      
      expect(agent.proofChain.length).toBe(0);
    });

    test('clears toolHistory', () => {
      agent.recordToolExecution('read', {}, {}, 100, true);
      agent.recordToolExecution('read', {}, {}, 150, true);
      
      agent.reset();
      
      expect(agent.toolHistory.length).toBe(0);
    });

    test('resets metrics to default values', () => {
      agent.recordToolExecution('read', {}, {}, 100, true);
      agent.recordToolExecution('edit', {}, 'error', 200, false);
      
      agent.reset();
      
      expect(agent.metrics.totalCalls).toBe(0);
      expect(agent.metrics.successfulCalls).toBe(0);
      expect(agent.metrics.failedCalls).toBe(0);
      expect(agent.metrics.avgResponseTimeMs).toBe(0);
      expect(agent.metrics.tokenUsage).toEqual({ prompt: 0, completion: 0 });
    });

    test('clears conversation history', () => {
      agent.conversationHistory.push({ role: 'user', content: 'test' });
      
      agent.reset();
      
      expect(agent.conversationHistory.length).toBe(0);
    });

    test('resets recursion counters', () => {
      agent.enterRecursion();
      agent.enterRecursion();
      
      agent.reset();
      
      expect(agent.currentDepth).toBe(0);
      expect(agent.subCallCount).toBe(0);
    });
  });
});
