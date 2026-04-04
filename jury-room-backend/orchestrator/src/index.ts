/**
 * AI Jury Orchestrator - Main Entry Point
 * Initializes SpacetimeDB connection
 * Runs all workers in parallel
 */

import dotenv from 'dotenv';
import http from 'http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSpacetimeDB, registerSession } from './spacetime.js';
import { runDiscoveryWorker } from './workers/discovery.js';
import { runProsecutionWorker } from './workers/prosecution.js';
import { runDefenseWorker } from './workers/defense.js';
import { runDevilsAdvocateWorker } from './workers/devils_advocate.js';
import { runFallacyWorker } from './workers/fallacy.js';
import { runSynthesisWorker } from './workers/synthesis.js';
import { log, logSuccess, logError } from './utils/logger.js';

const envLoadResult = dotenv.config();
if (envLoadResult.error) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fallbackEnvPath = path.resolve(__dirname, '../../../.env');
  dotenv.config({ path: fallbackEnvPath });
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

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/sessions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const session = JSON.parse(body);
          registerSession(session);
          log('📨', `Registered session: ${session.topic} (${session.status})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ saved: true }));
        } catch (e) {
          res.writeHead(400);
          res.end();
        }
      });
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
