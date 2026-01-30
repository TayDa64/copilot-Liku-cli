/**
 * Tests for centralized time utilities
 */

const {
  TIME_FORMAT,
  nowIso,
  nowFilenameSafe,
  formatTimestamp,
  parseTimestamp,
  timeSince
} = require('../../src/main/utils/time');

describe('Time Utilities', () => {
  describe('nowIso()', () => {
    test('returns valid ISO 8601 string', () => {
      const result = nowIso();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(() => new Date(result)).not.toThrow();
    });
  });

  describe('nowFilenameSafe()', () => {
    test('contains no colons or periods', () => {
      const result = nowFilenameSafe();
      expect(result).not.toContain(':');
      expect(result).not.toContain('.');
    });

    test('is a valid filename-safe string', () => {
      const result = nowFilenameSafe();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });

  describe('timeSince()', () => {
    test('formats seconds correctly', () => {
      const timestamp = new Date(Date.now() - 5000).toISOString();
      const result = timeSince(timestamp);
      expect(result).toBe('5s ago');
    });

    test('formats minutes correctly', () => {
      const timestamp = new Date(Date.now() - 120000).toISOString();
      const result = timeSince(timestamp);
      expect(result).toBe('2m ago');
    });

    test('formats hours correctly', () => {
      const timestamp = new Date(Date.now() - 7200000).toISOString();
      const result = timeSince(timestamp);
      expect(result).toBe('2h ago');
    });

    test('formats days correctly', () => {
      const timestamp = new Date(Date.now() - 172800000).toISOString();
      const result = timeSince(timestamp);
      expect(result).toBe('2d ago');
    });
  });

  describe('formatTimestamp()', () => {
    const testDate = new Date('2024-01-15T10:30:45.123Z');

    test('handles TIME_FORMAT.ISO', () => {
      const result = formatTimestamp(testDate, TIME_FORMAT.ISO);
      expect(result).toBe('2024-01-15T10:30:45.123Z');
    });

    test('handles TIME_FORMAT.FILENAME_SAFE', () => {
      const result = formatTimestamp(testDate, TIME_FORMAT.FILENAME_SAFE);
      expect(result).not.toContain(':');
      expect(result).not.toContain('.');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });

    test('handles TIME_FORMAT.DISPLAY', () => {
      const result = formatTimestamp(testDate, TIME_FORMAT.DISPLAY);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('defaults to ISO format', () => {
      const result = formatTimestamp(testDate);
      expect(result).toBe('2024-01-15T10:30:45.123Z');
    });

    test('accepts string timestamps', () => {
      const result = formatTimestamp('2024-01-15T10:30:45.123Z', TIME_FORMAT.ISO);
      expect(result).toBe('2024-01-15T10:30:45.123Z');
    });
  });

  describe('parseTimestamp()', () => {
    test('returns valid Date object', () => {
      const timestamp = '2024-01-15T10:30:45.123Z';
      const result = parseTimestamp(timestamp);
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe(timestamp);
    });

    test('handles various timestamp formats', () => {
      const formats = [
        '2024-01-15T10:30:45.123Z',
        '2024-01-15T10:30:45Z',
        '2024-01-15',
      ];
      
      formats.forEach(format => {
        const result = parseTimestamp(format);
        expect(result).toBeInstanceOf(Date);
        expect(isNaN(result.getTime())).toBe(false);
      });
    });
  });
});
