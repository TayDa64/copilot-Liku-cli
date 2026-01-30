/**
 * Tests for Researcher caching
 */

const { ResearcherAgent } = require('../../src/main/agents/researcher');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock AI service
const createMockAIService = () => ({
  chat: jest.fn().mockResolvedValue({
    text: 'Research findings about the query',
    tokens: { prompt: 100, completion: 50 }
  })
});

describe('ResearcherAgent', () => {
  let researcher;
  let mockAIService;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'researcher-test-'));
    mockAIService = createMockAIService();
    researcher = new ResearcherAgent({
      aiService: mockAIService,
      modelMetadata: {
        modelId: 'gpt-4o',
        provider: 'openai',
        capabilities: ['text']
      },
      cacheMaxAge: 1000 // 1 second for testing
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Constructor', () => {
    test('initializes researchCache', () => {
      expect(researcher.researchCache).toBeDefined();
      expect(researcher.researchCache instanceof Map).toBe(true);
    });

    test('initializes cacheMaxAge', () => {
      expect(researcher.cacheMaxAge).toBeDefined();
      expect(typeof researcher.cacheMaxAge).toBe('number');
    });

    test('initializes sourceCredibility', () => {
      expect(researcher.sourceCredibility).toBeDefined();
      expect(researcher.sourceCredibility instanceof Map).toBe(true);
    });
  });

  describe('getCacheKey()', () => {
    test('generates consistent keys from query + sources', () => {
      const query = 'test query';
      const probeResult = {
        relevantSources: [
          { path: 'file1.js' },
          { path: 'file2.js' }
        ]
      };
      
      const key1 = researcher.getCacheKey(query, probeResult);
      const key2 = researcher.getCacheKey(query, probeResult);
      
      expect(key1).toBe(key2);
    });

    test('generates different keys for different queries', () => {
      const probeResult = {
        relevantSources: [{ path: 'file1.js' }]
      };
      
      const key1 = researcher.getCacheKey('query1', probeResult);
      const key2 = researcher.getCacheKey('query2', probeResult);
      
      expect(key1).not.toBe(key2);
    });

    test('generates different keys for different sources', () => {
      const query = 'test query';
      const probeResult1 = {
        relevantSources: [{ path: 'file1.js' }]
      };
      const probeResult2 = {
        relevantSources: [{ path: 'file2.js' }]
      };
      
      const key1 = researcher.getCacheKey(query, probeResult1);
      const key2 = researcher.getCacheKey(query, probeResult2);
      
      expect(key1).not.toBe(key2);
    });
  });

  describe('research() caching', () => {
    test('returns cached result if within cacheMaxAge', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      // First call
      const result1 = await researcher.research('test query', probeResult);
      
      // Second call should return cached result
      mockAIService.chat.mockClear();
      const result2 = await researcher.research('test query', probeResult);
      
      expect(result2.fromCache).toBe(true);
      expect(mockAIService.chat).not.toHaveBeenCalled();
    });

    test('marks cached results with fromCache: true', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      // First call
      await researcher.research('test query', probeResult);
      
      // Second call
      const result = await researcher.research('test query', probeResult);
      
      expect(result.fromCache).toBe(true);
    });

    test('includes cacheAge in cached results', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      // First call
      await researcher.research('test query', probeResult);
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Second call
      const result = await researcher.research('test query', probeResult);
      
      expect(result.cacheAge).toBeDefined();
      expect(result.cacheAge).toBeGreaterThan(0);
    });

    test('does not use cache if result expired', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      // First call
      await researcher.research('test query', probeResult);
      
      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Second call should not use cache
      mockAIService.chat.mockClear();
      const result = await researcher.research('test query', probeResult);
      
      expect(result.fromCache).toBeUndefined();
      expect(mockAIService.chat).toHaveBeenCalled();
    });
  });

  describe('updateSourceCredibility()', () => {
    test('tracks helpful counts', () => {
      researcher.updateSourceCredibility('file1.js', true);
      
      const credibility = researcher.sourceCredibility.get('file1.js');
      
      expect(credibility).toBeDefined();
      expect(credibility.helpful).toBe(1);
      expect(credibility.unhelpful).toBe(0);
    });

    test('tracks unhelpful counts', () => {
      researcher.updateSourceCredibility('file1.js', false);
      
      const credibility = researcher.sourceCredibility.get('file1.js');
      
      expect(credibility).toBeDefined();
      expect(credibility.helpful).toBe(0);
      expect(credibility.unhelpful).toBe(1);
    });

    test('accumulates multiple ratings', () => {
      researcher.updateSourceCredibility('file1.js', true);
      researcher.updateSourceCredibility('file1.js', true);
      researcher.updateSourceCredibility('file1.js', false);
      
      const credibility = researcher.sourceCredibility.get('file1.js');
      
      expect(credibility.helpful).toBe(2);
      expect(credibility.unhelpful).toBe(1);
    });

    test('updates lastAccessed timestamp', () => {
      researcher.updateSourceCredibility('file1.js', true);
      
      const credibility = researcher.sourceCredibility.get('file1.js');
      
      expect(credibility.lastAccessed).toBeDefined();
      expect(credibility.lastAccessed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('clearCache()', () => {
    test('empties researchCache', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      // Create cache entry
      await researcher.research('test query', probeResult);
      expect(researcher.researchCache.size).toBeGreaterThan(0);
      
      // Clear cache
      researcher.clearCache();
      
      expect(researcher.researchCache.size).toBe(0);
    });
  });

  describe('getCacheStats()', () => {
    test('returns size', () => {
      const stats = researcher.getCacheStats();
      
      expect(stats.size).toBeDefined();
      expect(typeof stats.size).toBe('number');
    });

    test('returns maxAge', () => {
      const stats = researcher.getCacheStats();
      
      expect(stats.maxAge).toBeDefined();
      expect(stats.maxAge).toBe(researcher.cacheMaxAge);
    });

    test('returns entries array', () => {
      const stats = researcher.getCacheStats();
      
      expect(stats.entries).toBeDefined();
      expect(Array.isArray(stats.entries)).toBe(true);
    });

    test('entries reflect current cache keys', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      await researcher.research('test query', probeResult);
      
      const stats = researcher.getCacheStats();
      
      expect(stats.entries.length).toBe(1);
    });
  });

  describe('reset()', () => {
    test('clears cache', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      await researcher.research('test query', probeResult);
      expect(researcher.researchCache.size).toBeGreaterThan(0);
      
      researcher.reset();
      
      expect(researcher.researchCache.size).toBe(0);
    });

    test('clears credibility tracking', () => {
      researcher.updateSourceCredibility('file1.js', true);
      expect(researcher.sourceCredibility.size).toBeGreaterThan(0);
      
      researcher.reset();
      
      expect(researcher.sourceCredibility.size).toBe(0);
    });

    test('clears research results', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(testFile, 'test content');
      
      const probeResult = {
        query: 'test query',
        relevantSources: [{ type: 'file', path: testFile }]
      };
      
      await researcher.research('test query', probeResult);
      expect(researcher.researchResults.length).toBeGreaterThan(0);
      
      researcher.reset();
      
      expect(researcher.researchResults.length).toBe(0);
    });
  });
});
