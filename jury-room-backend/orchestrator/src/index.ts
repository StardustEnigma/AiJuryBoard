/**
 * AI Jury Orchestrator - Main Entry Point
 * Initializes SpacetimeDB connection
 * Runs all workers in parallel
 */

import dotenv from 'dotenv';
import http from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initSpacetimeDB, registerSession } from './spacetime.js';
import { runDiscoveryWorker } from './workers/discovery.js';
import { runProsecutionWorker } from './workers/prosecution.js';
import { runDefenseWorker } from './workers/defense.js';
import { runDevilsAdvocateWorker } from './workers/devils_advocate.js';
import { runFallacyWorker } from './workers/fallacy.js';
import { runSynthesisWorker } from './workers/synthesis.js';
import {
  isElevenLabsConfigured,
  resolveElevenLabsDefaults,
  synthesizeSpeechWithElevenLabs,
} from './utils/elevenlabs.js';
import { log, logSuccess, logError } from './utils/logger.js';

const envLoadResult = dotenv.config();
if (envLoadResult.error) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fallbackEnvPath = path.resolve(__dirname, '../../../.env');
  dotenv.config({ path: fallbackEnvPath });
}

const MESSAGE_STATUS_ORDER = ['DRAFT', 'VALIDATED', 'BROADCASTABLE', 'SPOKEN'] as const;
const AUDIO_DIR = path.resolve(process.cwd(), 'logs', 'audio');
const audioFileByKey = new Map<string, string>();
const AUDIO_ALLOW_BROWSER_FALLBACK = (process.env.AUDIO_ALLOW_BROWSER_FALLBACK || 'true').toLowerCase() !== 'false';

type AudioRenderRequest = {
  messageId: string | number;
  text: string;
  role?: string;
  voiceId?: string;
  modelId?: string;
};

function normalizeRole(value: unknown): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\u2019']/g, '')
    .replace(/[\s-]+/g, '_');

  if (normalized === 'PROSECUTION' || normalized === 'DEFENSE' || normalized === 'DEVILS_ADVOCATE') {
    return normalized;
  }

  return undefined;
}

function resolveRoleVoiceId(role?: string): string | undefined {
  if (role === 'PROSECUTION') {
    return (process.env.ELEVENLABS_VOICE_ID_PROSECUTION || '').trim() || undefined;
  }

  if (role === 'DEFENSE') {
    return (process.env.ELEVENLABS_VOICE_ID_DEFENSE || '').trim() || undefined;
  }

  if (role === 'DEVILS_ADVOCATE') {
    return (process.env.ELEVENLABS_VOICE_ID_DEVILS_ADVOCATE || '').trim() || undefined;
  }

  return undefined;
}

function isElevenLabsRestrictionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('detected_unusual_activity') ||
    normalized.includes('free tier usage disabled') ||
    (normalized.includes('401') && normalized.includes('unauthorized'))
  );
}

function normalizeMessageId(value: string | number): bigint {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    return BigInt(value.trim());
  }

  throw new Error('messageId is required');
}

function normalizeStatus(value: unknown): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function parseAudioPath(url?: string): string | null {
  if (!url || !url.startsWith('/audio/')) {
    return null;
  }

  const relative = decodeURIComponent(url.slice('/audio/'.length));
  const resolved = path.resolve(AUDIO_DIR, relative);
  if (!resolved.startsWith(AUDIO_DIR)) {
    return null;
  }

  return resolved;
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function advanceMessageStatusTo(conn: any, messageId: bigint, targetStatus: (typeof MESSAGE_STATUS_ORDER)[number]) {
  const messages = await conn.db.message.iter();
  const message = (messages as Array<{ id: bigint | string; messageStatus?: string }>).find(
    (row) => row.id.toString() === messageId.toString()
  );

  if (!message) {
    throw new Error(`Message ${messageId.toString()} not found`);
  }

  let currentStatus = normalizeStatus(message.messageStatus || 'DRAFT');
  const targetIndex = MESSAGE_STATUS_ORDER.indexOf(targetStatus);
  if (targetIndex < 0) {
    throw new Error(`Unsupported target status: ${targetStatus}`);
  }

  let currentIndex = MESSAGE_STATUS_ORDER.indexOf(currentStatus as (typeof MESSAGE_STATUS_ORDER)[number]);
  if (currentIndex < 0) {
    currentIndex = 0;
    currentStatus = MESSAGE_STATUS_ORDER[0];
  }

  while (currentIndex < targetIndex) {
    const nextStatus = MESSAGE_STATUS_ORDER[currentIndex + 1];
    await conn.reducers.advanceMessageStatus({ messageId, status: nextStatus });
    currentIndex += 1;
  }
}

async function handleAudioRender(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const payload = (await readJsonBody(req)) as AudioRenderRequest;
    const messageId = normalizeMessageId(payload.messageId);
    const text = String(payload.text || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'text is required' }));
      return;
    }

    const defaults = resolveElevenLabsDefaults();
    const role = normalizeRole(payload.role);
    const roleVoiceId = resolveRoleVoiceId(role);
    const voiceId = (payload.voiceId || roleVoiceId || defaults.voiceId).trim();
    const modelId = (payload.modelId || defaults.modelId).trim();
    const audioKey = `${messageId.toString()}-${voiceId}-${modelId}-${hashText(text)}`;

    const conn = (await initSpacetimeDB()) as any;
    await advanceMessageStatusTo(conn, messageId, 'VALIDATED');

    if (!isElevenLabsConfigured()) {
      if (!AUDIO_ALLOW_BROWSER_FALLBACK) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ELEVENLABS_API_KEY is not configured on orchestrator' }));
        return;
      }

      await advanceMessageStatusTo(conn, messageId, 'BROADCASTABLE');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          cached: false,
          voiceId,
          modelId,
          fallback: 'browser_tts',
          fallbackReason: 'ELEVENLABS_NOT_CONFIGURED',
        })
      );
      return;
    }

    fs.mkdirSync(AUDIO_DIR, { recursive: true });

    const existingFile = audioFileByKey.get(audioKey);
    if (existingFile && fs.existsSync(existingFile)) {
      const fileName = path.basename(existingFile);
      await advanceMessageStatusTo(conn, messageId, 'BROADCASTABLE');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          cached: true,
          voiceId,
          modelId,
          audioUrl: `/audio/${encodeURIComponent(fileName)}`,
        })
      );
      return;
    }

    let audioUrl: string | undefined;
    let fallback: 'browser_tts' | undefined;
    let fallbackReason: string | undefined;

    try {
      const audioBuffer = await synthesizeSpeechWithElevenLabs({ text, voiceId, modelId });
      const fileName = `${audioKey}.mp3`;
      const outputPath = path.join(AUDIO_DIR, fileName);
      fs.writeFileSync(outputPath, audioBuffer);
      audioFileByKey.set(audioKey, outputPath);
      audioUrl = `/audio/${encodeURIComponent(fileName)}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!AUDIO_ALLOW_BROWSER_FALLBACK || !isElevenLabsRestrictionError(message)) {
        throw error;
      }

      fallback = 'browser_tts';
      fallbackReason = 'ELEVENLABS_ACCOUNT_RESTRICTED';
      log('🔊', 'ElevenLabs restricted; falling back to browser TTS');
    }

    await advanceMessageStatusTo(conn, messageId, 'BROADCASTABLE');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        cached: false,
        voiceId,
        modelId,
        audioUrl,
        fallback,
        fallbackReason,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('AUDIO', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleAudioSpoken(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const payload = await readJsonBody(req);
    const messageId = normalizeMessageId(payload?.messageId);
    const conn = (await initSpacetimeDB()) as any;

    await advanceMessageStatusTo(conn, messageId, 'SPOKEN');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messageId: messageId.toString(), status: 'SPOKEN' }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('AUDIO', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}

/**
 * Create HTTP server for frontend notifications
 */
function startNotificationServer() {
  const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const maybeAudioPath = parseAudioPath(req.url);
    if (maybeAudioPath && req.method === 'GET') {
      if (!fs.existsSync(maybeAudioPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Audio file not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(maybeAudioPath).pipe(res);
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/sessions' && req.method === 'POST') {
      void readJsonBody(req)
        .then((session) => {
          registerSession(session);
          log('📨', `Registered session: ${session.topic} (${session.status})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ saved: true }));
        })
        .catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }

    if (req.url === '/audio/render' && req.method === 'POST') {
      void handleAudioRender(req, res);
      return;
    }

    if (req.url === '/audio/spoken' && req.method === 'POST') {
      void handleAudioSpoken(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(9000, () => {
    logSuccess('📨', 'Notification server listening on http://localhost:9000');
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🏛️  AI Jury Orchestrator - Starting');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    // Start notification server
    startNotificationServer();

    // Initialize SpacetimeDB connection
    await initSpacetimeDB();

    // Start all workers in parallel
    log('🚀', 'Starting all workers...');

    const workers = [
      { name: 'Discovery', fn: () => runDiscoveryWorker(15000) },
      { name: 'Prosecution', fn: () => runProsecutionWorker(20000) },
      { name: 'Defense', fn: () => runDefenseWorker(20000) },
      { name: "Devil's Advocate", fn: () => runDevilsAdvocateWorker(25000) },
      { name: 'Fallacy', fn: () => runFallacyWorker(10000) },
      { name: 'Synthesis', fn: () => runSynthesisWorker(35000) },
    ];

    // Launch all workers (they run forever in background)
    for (const worker of workers) {
      worker
        .fn()
        .catch((error) => {
          logError('WORKER', `${worker.name} worker crashed: ${error}`);
        });
    }

    logSuccess('🏛️', 'All workers started. Monitoring...');

    // Keep process alive; log status periodically
    setInterval(() => {
      log('💚', 'Orchestrator running healthy');
    }, 60000);
  } catch (error) {
    logError('MAIN', `Failed to start orchestrator: ${error}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('🛑', 'Shutdown signal received. Closing gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('🛑', 'Termination signal received. Closing gracefully...');
  process.exit(0);
});

main();
