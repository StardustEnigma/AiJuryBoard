/**
 * Shared Utility Functions
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';

export function log(prefix: string, message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

export function logError(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log(prefix, `❌ ${message}`);
}

export function logSuccess(prefix: string, message: string) {
  log(prefix, `✅ ${message}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  name: string,
  maxRetries = 3,
  delayMs = 5000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) {
        logError('RETRY', `Failed after ${maxRetries} attempts: ${name}`);
        throw error;
      }
      logError('RETRY', `Attempt ${i + 1}/${maxRetries} failed for ${name}, retrying...`);
      await sleep(delayMs);
    }
  }
  throw new Error(`Retry loop failed for ${name}`);
}

export function generateIdempotencyKey(prefix: string): string {
  const normalized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  return `${normalized}-${digest}`;
}

export async function writeAuditLog(entry: Record<string, unknown>) {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = path.join(logDir, `audit-${new Date().toISOString().split('T')[0]}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch (error) {
    logError('AUDIT', `Failed to write audit log: ${error}`);
  }
}
