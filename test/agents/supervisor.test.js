/**
 * Tests for Supervisor enhancements
 */

const { SupervisorAgent } = require('../../src/main/agents/supervisor');
const { AgentRole } = require('../../src/main/agents/base-agent');

// Mock AI service
const createMockAIService = () => ({
  chat: jest.fn().mockResolvedValue({
    text: `Analysis: This is a test task.
    
Plan:
1. Implement feature X
2. Verify feature X works

Assumptions:
- The codebase has existing infrastructure
- Tests are available`,
    tokens: { prompt: 100, completion: 50 }
  })
});

describe('SupervisorAgent', () => {
  let supervisor;
  let mockAIService;

  beforeEach(() => {
    mockAIService = createMockAIService();
    supervisor = new SupervisorAgent({
      aiService: mockAIService,
      modelMetadata: {
        modelId: 'gpt-4o',
        provider: 'openai',
        capabilities: ['text']
      }
    });
  });

  describe('createPlan()', () => {
    test('includes modelContext with required fields', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.modelContext).toBeDefined();
      expect(plan.modelContext.modelId).toBeDefined();
      expect(plan.modelContext.provider).toBeDefined();
      expect(plan.modelContext.createdAt).toBeDefined();
    });

    test('modelContext includes modelId from metadata', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.modelContext.modelId).toBe('gpt-4o');
    });

    test('modelContext includes provider from metadata', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.modelContext.provider).toBe('openai');
    });

    test('modelContext includes createdAt timestamp', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.modelContext.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('includes planId', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.planId).toBeDefined();
      expect(plan.planId).toMatch(/^plan-/);
    });

    test('includes steps array', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.steps).toBeDefined();
      expect(Array.isArray(plan.steps)).toBe(true);
    });

    test('includes assumptions array', async () => {
      const analysis = {
        description: 'test task',
        analysis: 'Test analysis'
      };
      
      const plan = await supervisor.createPlan(analysis);
      
      expect(plan.assumptions).toBeDefined();
      expect(Array.isArray(plan.assumptions)).toBe(true);
    });
  });

  describe('buildDependencyGraph()', () => {
    test('creates nodes from tasks', () => {
      const tasks = [
        { id: 'task-1', description: 'Task 1', targetAgent: AgentRole.BUILDER, status: 'pending', dependencies: [] },
        { id: 'task-2', description: 'Task 2', targetAgent: AgentRole.VERIFIER, status: 'pending', dependencies: ['task-1'] }
      ];
      
      const graph = supervisor.buildDependencyGraph(tasks);
      
      expect(graph.nodes).toBeDefined();
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(graph.nodes.length).toBe(2);
    });

    test('nodes include task properties', () => {
      const tasks = [
        { id: 'task-1', description: 'Task 1', targetAgent: AgentRole.BUILDER, status: 'pending', dependencies: [] }
      ];
      
      const graph = supervisor.buildDependencyGraph(tasks);
      
      expect(graph.nodes[0].id).toBe('task-1');
      expect(graph.nodes[0].description).toBe('Task 1');
      expect(graph.nodes[0].agent).toBe(AgentRole.BUILDER);
      expect(graph.nodes[0].status).toBe('pending');
    });

    test('creates edges from dependencies', () => {
      const tasks = [
        { id: 'task-1', description: 'Task 1', targetAgent: AgentRole.BUILDER, status: 'pending', dependencies: [] },
        { id: 'task-2', description: 'Task 2', targetAgent: AgentRole.VERIFIER, status: 'pending', dependencies: ['task-1'] }
      ];
      
      const graph = supervisor.buildDependencyGraph(tasks);
      
      expect(graph.edges).toBeDefined();
      expect(Array.isArray(graph.edges)).toBe(true);
      expect(graph.edges.length).toBe(1);
    });

    test('edges have correct from/to properties', () => {
      const tasks = [
        { id: 'task-1', description: 'Task 1', targetAgent: AgentRole.BUILDER, status: 'pending', dependencies: [] },
        { id: 'task-2', description: 'Task 2', targetAgent: AgentRole.VERIFIER, status: 'pending', dependencies: ['task-1'] }
      ];
      
      const graph = supervisor.buildDependencyGraph(tasks);
      
      expect(graph.edges[0].from).toBe('task-1');
      expect(graph.edges[0].to).toBe('task-2');
      expect(graph.edges[0].type).toBe('depends-on');
    });
  });

  describe('aggregateResults()', () => {
    beforeEach(() => {
      supervisor.decomposedTasks = [
        { id: 'task-1', description: 'Task 1', targetAgent: AgentRole.BUILDER, status: 'completed', dependencies: [] },
        { id: 'task-2', description: 'Task 2', targetAgent: AgentRole.VERIFIER, status: 'completed', dependencies: ['task-1'] }
      ];
    });

    test('includes dependencyGraph', () => {
      const results = [
        { taskId: 'task-1', success: true },
        { taskId: 'task-2', success: true }
      ];
      
      const aggregated = supervisor.aggregateResults(results, {});
      
      expect(aggregated.dependencyGraph).toBeDefined();
      expect(aggregated.dependencyGraph.nodes).toBeDefined();
      expect(aggregated.dependencyGraph.edges).toBeDefined();
    });

    test('dependencyGraph includes nodes from decomposedTasks', () => {
      const results = [
        { taskId: 'task-1', success: true },
        { taskId: 'task-2', success: true }
      ];
      
      const aggregated = supervisor.aggregateResults(results, {});
      
      expect(aggregated.dependencyGraph.nodes.length).toBe(2);
    });

    test('includes summary with counts', () => {
      const results = [
        { taskId: 'task-1', success: true },
        { taskId: 'task-2', success: false }
      ];
      
      const aggregated = supervisor.aggregateResults(results, {});
      
      expect(aggregated.summary).toBeDefined();
      expect(aggregated.summary.total).toBe(2);
      expect(aggregated.summary.successful).toBe(1);
      expect(aggregated.summary.failed).toBe(1);
    });
  });
});
