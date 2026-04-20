/**
 * RedisCacheService
 * Wraps Redis client with graceful degradation.
 * If Redis is unavailable, all operations silently no-op — the app falls back to SQLite.
 */

import { createClient, RedisClientType } from 'redis';

export class RedisCacheService {
  private client: RedisClientType | null = null;
  private connected = false;
  private defaultTtl: number;

  constructor(
    private redisUrl?: string,
    defaultTtlSeconds: number = parseInt(process.env.REDIS_CACHE_TTL_SECONDS || '3600')
  ) {
    this.defaultTtl = defaultTtlSeconds;
  }

  async connect(): Promise<boolean> {
    if (!this.redisUrl) {
      console.log('[Redis] No REDIS_URL configured — caching disabled');
      return false;
    }

    try {
      this.client = createClient({
        url: this.redisUrl,
        socket: {
          connectTimeout: 3000,
          reconnectStrategy: false // Don't auto-reconnect in case of failure
        }
      }) as RedisClientType;

      this.client.on('error', (err) => {
        console.error('[Redis] Connection error:', err.message);
        this.connected = false;
      });

      this.client.on('connect', () => {
        this.connected = true;
      });

      this.client.on('end', () => {
        this.connected = false;
      });

      await this.client.connect();
      this.connected = true;
      console.log('[Redis] Connected');
      return true;
    } catch (error) {
      console.error('[Redis] Failed to connect:', error);
      this.client = null;
      this.connected = false;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.quit();
      } catch {
        // ignore
      }
      this.connected = false;
      this.client = null;
      console.log('[Redis] Disconnected');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client || !this.connected) return null;

    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.connected) return;

    try {
      const ttl = ttlSeconds ?? this.defaultTtl;
      await this.client.set(key, JSON.stringify(value), { EX: ttl });
    } catch {
      // silent fail
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client || !this.connected) return;

    try {
      await this.client.del(key);
    } catch {
      // silent fail
    }
  }

  async delPattern(pattern: string): Promise<void> {
    if (!this.client || !this.connected) return;

    try {
      let cursor = 0;
      do {
        const result = await this.client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = result.cursor;
        if (result.keys.length > 0) {
          await this.client.del(result.keys);
        }
      } while (cursor !== 0);
    } catch {
      // silent fail
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client || !this.connected) return false;

    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}
