/**
 * Tests for Builder enhancements
 */

const { BuilderAgent } = require('../../src/main/agents/builder');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock AI service
const createMockAIService = () => ({
  chat: jest.fn().mockResolvedValue({
    text: `Files Modified: test.js

\`\`\`diff
--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 function test() {
-  return 'old';
+  return 'new';
 }
\`\`\`

Rationale: Updated return value`,
    tokens: { prompt: 100, completion: 50 }
  })
});

describe('BuilderAgent', () => {
  let builder;
  let mockAIService;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-test-'));
    mockAIService = createMockAIService();
    builder = new BuilderAgent({
      aiService: mockAIService,
      modelMetadata: {
        modelId: 'gpt-4o',
        provider: 'openai',
        capabilities: ['text']
      }
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('implementChanges()', () => {
    test('tracks rollbackData with originalContent', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        }
      };
      
      const result = await builder.implementChanges(changePlan, {});
      
      expect(result.rollbackData).toBeDefined();
      expect(Array.isArray(result.rollbackData)).toBe(true);
      expect(result.rollbackData.length).toBeGreaterThan(0);
    });

    test('rollbackData includes originalContent', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        }
      };
      
      const result = await builder.implementChanges(changePlan, {});
      
      expect(result.rollbackData[0].originalContent).toBe(originalContent);
      expect(result.rollbackData[0].file).toBe(testFile);
    });

    test('returns rollbackData in result', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        }
      };
      
      const result = await builder.implementChanges(changePlan, {});
      
      expect(result).toHaveProperty('rollbackData');
      expect(result.rollbackData).toBeDefined();
    });
  });

  describe('Diff metadata', () => {
    test('diffs include modelMetadata', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        }
      };
      
      await builder.implementChanges(changePlan, {});
      
      expect(builder.diffs.length).toBeGreaterThan(0);
      expect(builder.diffs[0].modelMetadata).toBeDefined();
      expect(builder.diffs[0].modelMetadata.modelId).toBe('gpt-4o');
    });

    test('diffs include planId', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        },
        planId: 'test-plan-123'
      };
      
      await builder.implementChanges(changePlan, {});
      
      expect(builder.diffs[0].planId).toBe('test-plan-123');
    });

    test('diffs include rationale', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        }
      };
      
      await builder.implementChanges(changePlan, {});
      
      expect(builder.diffs[0].rationale).toBeDefined();
    });

    test('diffs include rollbackAvailable flag', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const changePlan = {
        changes: [{ file: testFile, description: 'Update function' }],
        understanding: {
          fileContents: { [testFile]: originalContent }
        }
      };
      
      await builder.implementChanges(changePlan, {});
      
      expect(builder.diffs[0].rollbackAvailable).toBe(true);
    });
  });

  describe('rollback()', () => {
    test('restores original file content', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const rollbackData = [
        {
          file: testFile,
          originalContent,
          timestamp: new Date().toISOString()
        }
      ];
      
      // Modify the file
      fs.writeFileSync(testFile, 'function test() { return "new"; }');
      
      // Rollback
      const results = await builder.rollback(rollbackData);
      
      const restoredContent = fs.readFileSync(testFile, 'utf-8');
      expect(restoredContent).toBe(originalContent);
      expect(results[0].success).toBe(true);
    });

    test('creates structured proof for each rollback', async () => {
      const testFile = path.join(tempDir, 'test.js');
      const originalContent = 'function test() { return "old"; }';
      fs.writeFileSync(testFile, originalContent);
      
      const rollbackData = [
        {
          file: testFile,
          originalContent,
          timestamp: new Date().toISOString()
        }
      ];
      
      // Modify the file
      fs.writeFileSync(testFile, 'function test() { return "new"; }');
      
      // Clear proofChain
      builder.proofChain = [];
      
      // Rollback
      await builder.rollback(rollbackData);
      
      expect(builder.proofChain.length).toBe(1);
      expect(builder.proofChain[0].type).toBe('rollback');
      expect(builder.proofChain[0].file).toBe(testFile);
    });

    test('handles errors gracefully', async () => {
      // Use a directory path instead of file to cause an error
      const invalidPath = path.join(tempDir, 'invalid-directory/');
      
      const rollbackData = [
        {
          file: invalidPath,
          originalContent: 'content',
          timestamp: new Date().toISOString()
        }
      ];
      
      const results = await builder.rollback(rollbackData);
      
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();
    });

    test('returns results for all rollback operations', async () => {
      const file1 = path.join(tempDir, 'test1.js');
      const file2 = path.join(tempDir, 'test2.js');
      fs.writeFileSync(file1, 'content1');
      fs.writeFileSync(file2, 'content2');
      
      const rollbackData = [
        { file: file1, originalContent: 'original1', timestamp: new Date().toISOString() },
        { file: file2, originalContent: 'original2', timestamp: new Date().toISOString() }
      ];
      
      const results = await builder.rollback(rollbackData);
      
      expect(results.length).toBe(2);
      expect(results[0].file).toBe(file1);
      expect(results[1].file).toBe(file2);
    });
  });
});
