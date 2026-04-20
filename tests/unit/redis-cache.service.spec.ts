/**
 * Unit Tests: RedisCacheService
 * Tests graceful degradation when Redis is unavailable (no-op mode).
 * Tests connected behavior with a real Redis if available, otherwise skips.
 */

import { RedisCacheService } from '../../src/services/redis-cache.service';

describe('RedisCacheService', () => {
  // ===== No-op mode (no Redis URL) =====

  describe('no-op mode (no REDIS_URL)', () => {
    let cache: RedisCacheService;

    beforeEach(() => {
      cache = new RedisCacheService(undefined, 60);
    });

    test('connect should return false', async () => {
      const result = await cache.connect();
      expect(result).toBe(false);
    });

    test('isConnected should return false', () => {
      expect(cache.isConnected()).toBe(false);
    });

    test('get should return null', async () => {
      const result = await cache.get('any-key');
      expect(result).toBeNull();
    });

    test('set should not throw', async () => {
      await expect(cache.set('key', { foo: 'bar' })).resolves.toBeUndefined();
    });

    test('del should not throw', async () => {
      await expect(cache.del('key')).resolves.toBeUndefined();
    });

    test('delPattern should not throw', async () => {
      await expect(cache.delPattern('key:*')).resolves.toBeUndefined();
    });

    test('healthCheck should return false', async () => {
      const result = await cache.healthCheck();
      expect(result).toBe(false);
    });

    test('disconnect should not throw', async () => {
      await expect(cache.disconnect()).resolves.toBeUndefined();
    });
  });

  // ===== Graceful degradation (bad URL) =====

  describe('graceful degradation (unreachable Redis)', () => {
    let cache: RedisCacheService;

    test('connect should return false on unreachable server', async () => {
      cache = new RedisCacheService('redis://localhost:19999', 60);
      const result = await cache.connect();
      expect(result).toBe(false);
      expect(cache.isConnected()).toBe(false);
    });
  });

  // ===== Connected mode (real Redis) =====
  // These tests only run if Redis is available at localhost:6379

  describe('connected mode (real Redis)', () => {
    let cache: RedisCacheService;
    let redisAvailable = false;

    beforeAll(async () => {
      cache = new RedisCacheService('redis://localhost:6379', 60);
      redisAvailable = await cache.connect();
      if (!redisAvailable) {
        console.log('⚠ Redis not available at localhost:6379 — skipping connected mode tests');
      }
    });

    afterAll(async () => {
      if (redisAvailable) {
        // Clean up test keys
        await cache.delPattern('test:*');
        await cache.disconnect();
      }
    });

    test('should connect successfully', () => {
      if (!redisAvailable) return;
      expect(cache.isConnected()).toBe(true);
    });

    test('should set and get a value', async () => {
      if (!redisAvailable) return;
      await cache.set('test:unit:1', { name: 'John', balance: 20 });
      const result = await cache.get<{ name: string; balance: number }>('test:unit:1');
      expect(result).toEqual({ name: 'John', balance: 20 });
    });

    test('should return null for missing key', async () => {
      if (!redisAvailable) return;
      const result = await cache.get('test:unit:missing');
      expect(result).toBeNull();
    });

    test('should delete a key', async () => {
      if (!redisAvailable) return;
      await cache.set('test:unit:del', 'value');
      await cache.del('test:unit:del');
      const result = await cache.get('test:unit:del');
      expect(result).toBeNull();
    });

    test('should delete by pattern', async () => {
      if (!redisAvailable) return;
      await cache.set('test:pattern:a', '1');
      await cache.set('test:pattern:b', '2');
      await cache.set('test:other:c', '3');

      await cache.delPattern('test:pattern:*');

      expect(await cache.get('test:pattern:a')).toBeNull();
      expect(await cache.get('test:pattern:b')).toBeNull();
      expect(await cache.get('test:other:c')).not.toBeNull();

      // Cleanup
      await cache.del('test:other:c');
    });

    test('healthCheck should return true', async () => {
      if (!redisAvailable) return;
      const result = await cache.healthCheck();
      expect(result).toBe(true);
    });
  });
});
