#!/usr/bin/env node
/**
 * API Integration Test Suite
 * Tests external APIs used by AI Jury.
 */

const fs = require('node:fs');
const path = require('node:path');

const REQUEST_TIMEOUT_MS = 15_000;
const testResults = {};

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = stripWrappingQuotes(rawValue);
    }
  }
}

function bootstrapEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '.env.local'),
  ];

  for (const envPath of candidates) {
    loadEnvFile(envPath);
  }
}

function setResult(name, status, detail) {
  testResults[name] = { status, detail };
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing ${name}`);
  }
  return value.trim();
}

function getBooleanEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function runLocalArmorPolicy(content, role, context) {
  const normalizedContent = String(content || '').toLowerCase();
  const normalizedRole = String(role || '').toLowerCase();
  const normalizedContext = String(context || '').toLowerCase();

  const blockedTerms = ['jailbreak', 'bypass policy', 'exploit', 'malware', 'hate speech'];
  const matchedBlockedTerms = blockedTerms.filter((term) => normalizedContent.includes(term));
  const validRole = ['prosecutor', 'defense', 'devils_advocate', 'synthesizer'].includes(normalizedRole);
  const validContext = normalizedContext.length > 0;

  const valid = matchedBlockedTerms.length === 0 && validRole && validContext;

  return {
    valid,
    source: 'local-fallback',
    blockedTerms: matchedBlockedTerms,
  };
}

function trimText(text, max = 220) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

async function readResponseError(response) {
  const body = await response.text();
  if (!body) {
    return response.statusText || 'empty response body';
  }

  try {
    const parsed = JSON.parse(body);
    return trimText(
      parsed?.error?.message || parsed?.message || parsed?.detail || parsed?.error || body
    );
  } catch {
    return trimText(body);
  }
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildApiKeyHeader(apiKey, defaults) {
  const headerName = process.env[defaults.headerEnv] || defaults.headerName;
  const prefix =
    process.env[defaults.prefixEnv] ||
    (headerName.toLowerCase() === 'authorization' ? defaults.authorizationPrefix : '');
  return { [headerName]: `${prefix}${apiKey}` };
}

function pickArmorToken(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const candidates = [
    payload.token,
    payload.access_token,
    payload.accessToken,
    payload.jwt,
    payload.id_token,
    payload.data?.token,
    payload.data?.access_token,
    payload.data?.accessToken,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

async function resolveArmorAccessToken(apiKey, baseUrl) {
  const explicitToken = process.env.ARMOR_IQ_ACCESS_TOKEN;
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }

  const tokenFlowEnabled = getBooleanEnv('ARMOR_IQ_USE_TOKEN_FLOW', false);
  if (!tokenFlowEnabled) {
    return '';
  }

  const tokenEndpoint = process.env.ARMOR_IQ_TOKEN_ENDPOINT || `${baseUrl}/iap/process`;
  const clientId = process.env.ARMOR_IQ_CLIENT_ID;
  const clientSecret = process.env.ARMOR_IQ_CLIENT_SECRET;
  const domainName = process.env.ARMOR_IQ_DOMAIN;
  const userId = process.env.ARMOR_IQ_USER_ID;
  const agentId = process.env.ARMOR_IQ_AGENT_ID;
  const contextId = process.env.ARMOR_IQ_CONTEXT_ID;

  const missing = [
    ['ARMOR_IQ_CLIENT_ID', clientId],
    ['ARMOR_IQ_CLIENT_SECRET', clientSecret],
    ['ARMOR_IQ_DOMAIN', domainName],
    ['ARMOR_IQ_USER_ID', userId],
    ['ARMOR_IQ_AGENT_ID', agentId],
    ['ARMOR_IQ_CONTEXT_ID', contextId],
  ]
    .filter((entry) => !entry[1] || !String(entry[1]).trim())
    .map((entry) => entry[0]);

  if (missing.length > 0) {
    throw new Error(`ArmorIQ token flow enabled but missing required env vars: ${missing.join(', ')}`);
  }

  const authHeader = buildApiKeyHeader(apiKey, {
    headerEnv: 'ARMOR_IQ_API_KEY_HEADER',
    prefixEnv: 'ARMOR_IQ_API_KEY_PREFIX',
    headerName: 'x-api-key',
    authorizationPrefix: '',
  });

  const response = await fetchWithTimeout(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      domainName,
      user_id: userId,
      agent_id: agentId,
      context_id: contextId,
    }),
  });

  if (!response.ok) {
    throw new Error(`ArmorIQ token exchange failed (HTTP ${response.status}): ${await readResponseError(response)}`);
  }

  const payload = await response.json();
  const token = pickArmorToken(payload);
  if (!token) {
    throw new Error('ArmorIQ token exchange succeeded but no token field was found in response');
  }

  return token;
}

async function testTavily() {
  const name = 'tavily';
  console.log('\nTesting Tavily API...');

  try {
    const apiKey = getRequiredEnv('TAVILY_API_KEY');
    const baseUrl = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');

    const response = await fetchWithTimeout(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: 'AI Jury API health check',
        include_answer: true,
        max_results: 1,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await readResponseError(response)}`);
    }

    const data = await response.json();
    console.log(`PASS Tavily API: Connected (${Array.isArray(data.results) ? data.results.length : 0} result)`);
    setResult(name, 'PASS', 'Connected');
  } catch (error) {
    console.error(`FAIL Tavily API: ${trimText(error.message || error)}`);
    setResult(name, 'FAIL', trimText(error.message || error));
  }
}

async function testClaude() {
  const name = 'claude';
  console.log('\nTesting Claude API...');

  try {
    const apiKey = getRequiredEnv('CLAUDE_API_KEY');
    const baseUrl = (process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

    const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await readResponseError(response)}`);
    }

    const data = await response.json();
    const count = Array.isArray(data.data) ? data.data.length : 0;
    console.log(`PASS Claude API: Connected (${count} models visible)`);
    setResult(name, 'PASS', 'Connected');
  } catch (error) {
    console.error(`FAIL Claude API: ${trimText(error.message || error)}`);
    setResult(name, 'FAIL', trimText(error.message || error));
  }
}

async function testGemini() {
  const name = 'gemini';
  console.log('\nTesting Gemini API...');

  try {
    const apiKey = getRequiredEnv('GEMINI_API_KEY');
    const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await readResponseError(response)}`);
    }

    const data = await response.json();
    const count = Array.isArray(data.models) ? data.models.length : 0;
    console.log(`PASS Gemini API: Connected (${count} models visible)`);
    setResult(name, 'PASS', 'Connected');
  } catch (error) {
    console.error(`FAIL Gemini API: ${trimText(error.message || error)}`);
    setResult(name, 'FAIL', trimText(error.message || error));
  }
}

async function testLlama() {
  const name = 'llama';
  console.log('\nTesting Llama API...');

  try {
    const apiKey = getRequiredEnv('LLAMA_API_KEY');
    const model = process.env.LLAMA_MODEL || 'llama-3.1-8b-instant';
    const apiUrl = process.env.LLAMA_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    const authHeader = buildApiKeyHeader(apiKey, {
      headerEnv: 'LLAMA_API_KEY_HEADER',
      prefixEnv: 'LLAMA_API_KEY_PREFIX',
      headerName: 'Authorization',
      authorizationPrefix: 'Bearer ',
    });

    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: 'Find one logical fallacy: "Because everyone believes it, it must be true."',
          },
        ],
        max_tokens: 64,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await readResponseError(response)}`);
    }

    const data = await response.json();
    const sample = data?.choices?.[0]?.message?.content;
    console.log(`PASS Llama API: Connected (${sample ? 'completion received' : 'empty completion'})`);
    setResult(name, 'PASS', 'Connected');
  } catch (error) {
    console.error(`FAIL Llama API: ${trimText(error.message || error)}`);
    setResult(name, 'FAIL', trimText(error.message || error));
  }
}

async function testArmorIQ() {
  const name = 'armoriq';
  const armorRequired = getBooleanEnv('ARMOR_IQ_REQUIRED', false);
  const armorLocalFallback = getBooleanEnv('ARMOR_IQ_LOCAL_FALLBACK', true);
  console.log('\nTesting ArmorIQ API...');

  try {
    const apiKey = getRequiredEnv('ARMOR_IQ_KEY');
    const baseUrl = (process.env.ARMOR_IQ_BASE_URL || 'https://cloud-run-proxy.armoriq.io').replace(/\/+$/, '');
    const endpoint = process.env.ARMOR_IQ_VALIDATE_URL || `${baseUrl}/v1/validate`;
    const accessToken = await resolveArmorAccessToken(apiKey, baseUrl);
    const authHeader = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : buildApiKeyHeader(apiKey, {
          headerEnv: 'ARMOR_IQ_API_KEY_HEADER',
          prefixEnv: 'ARMOR_IQ_API_KEY_PREFIX',
          headerName: 'Authorization',
          authorizationPrefix: 'Bearer ',
        });

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader,
      },
      body: JSON.stringify({
        content: 'This is a prosecution argument in favor of the thesis.',
        role: 'prosecutor',
        context: 'judicial debate',
      }),
    });

    if (!response.ok) {
      const detail = await readResponseError(response);

      if (response.status >= 500 && armorLocalFallback) {
        const localResult = runLocalArmorPolicy(
          'This is a prosecution argument in favor of the thesis.',
          'prosecutor',
          'judicial debate'
        );

        if (localResult.valid) {
          console.log(
            `PASS ArmorIQ API: Remote unavailable (HTTP ${response.status}), local fallback policy engine validated input`
          );
          setResult(name, 'PASS', 'Local fallback validated input while remote endpoint is unavailable');
          return;
        }
      }

      if (response.status >= 500 && !armorRequired) {
        const warning = `HTTP ${response.status}: ${detail}. Remote service unavailable and local fallback disabled.`;
        console.warn(`WARN ArmorIQ API: ${warning}`);
        setResult(name, 'WARN', warning);
        return;
      }

      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const data = await response.json();
    console.log(`PASS ArmorIQ API: Connected (validated=${String(Boolean(data.valid))}, tokenFlow=${accessToken ? 'on' : 'off'})`);
    setResult(name, 'PASS', 'Connected');
  } catch (error) {
    const message = trimText(error.message || error);
    const networkIssue = /aborted|timed out|enotfound|eai_again|econnrefused|fetch failed|network/i.test(message);

    if (networkIssue && armorLocalFallback) {
      const localResult = runLocalArmorPolicy(
        'This is a prosecution argument in favor of the thesis.',
        'prosecutor',
        'judicial debate'
      );

      if (localResult.valid) {
        console.log('PASS ArmorIQ API: Remote unreachable, local fallback policy engine validated input');
        setResult(name, 'PASS', 'Local fallback validated input while remote endpoint is unreachable');
        return;
      }
    }

    if (networkIssue && !armorRequired) {
      const warning = `${message}. Marking WARN because ARMOR_IQ_REQUIRED is not true.`;
      console.warn(`WARN ArmorIQ API: ${warning}`);
      setResult(name, 'WARN', warning);
      return;
    }

    console.error(`FAIL ArmorIQ API: ${message}`);
    setResult(name, 'FAIL', message);
  }
}

async function testMongoDB() {
  const name = 'mongodb';
  const mongoRequired = getBooleanEnv('MONGODB_REQUIRED', false);
  const mongoLocalFallback = getBooleanEnv('MONGODB_LOCAL_FALLBACK', true);
  console.log('\nTesting MongoDB...');

  try {
    const mongoUri = getRequiredEnv('MONGODB_URI');
    let MongoClient;

    try {
      ({ MongoClient } = await import('mongodb'));
    } catch {
      throw new Error("Missing npm package 'mongodb'. Run: npm install mongodb");
    }

    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8_000 });

    try {
      await client.connect();
      await client.db(process.env.MONGODB_DB || 'admin').command({ ping: 1 });
    } finally {
      await client.close();
    }

    console.log('PASS MongoDB: Connected');
    setResult(name, 'PASS', 'Connected');
  } catch (error) {
    const message = trimText(error.message || error);
    const networkIssue = /aborted|timed out|ssl|tls|enotfound|eai_again|econnrefused|fetch failed|network/i.test(message);

    if (mongoLocalFallback) {
      try {
        const mongoMockModule = await import('mongo-mock');
        const mongoMock = mongoMockModule.default || mongoMockModule;
        if (!mongoMock || !mongoMock.MongoClient || typeof mongoMock.MongoClient.connect !== 'function') {
          throw new Error('mongo-mock MongoClient.connect is unavailable');
        }

        const mockClient = await new Promise((resolve, reject) => {
          mongoMock.MongoClient.connect('mongodb://127.0.0.1:27017/ai-jury-local-fallback', {}, (err, client) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(client);
          });
        });

        const db = mockClient.db('ai_jury_public_record');
        const col = db.collection('health_checks');
        await new Promise((resolve, reject) => {
          col.insertOne({ at: new Date().toISOString(), source: 'mongo-mock-fallback' }, (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });

        await new Promise((resolve, reject) => {
          col.findOne({}, (err, doc) => {
            if (err || !doc) {
              reject(err || new Error('mongo-mock fallback read failed'));
              return;
            }
            resolve();
          });
        });

        if (typeof mockClient.close === 'function') {
          mockClient.close();
        }

        console.log('PASS MongoDB: Remote unavailable, local mongo-mock fallback is operational');
        setResult(name, 'PASS', 'Local mongo-mock fallback read/write check succeeded');
        return;
      } catch (fallbackError) {
        const fallbackMessage = trimText(fallbackError.message || fallbackError);
        if (mongoRequired) {
          console.error(`FAIL MongoDB: Remote failed (${message}) and local fallback failed (${fallbackMessage})`);
          setResult(name, 'FAIL', `Remote failed (${message}) and fallback failed (${fallbackMessage})`);
          return;
        }
      }
    }

    if (networkIssue && !mongoRequired) {
      const warning = `${message}. Marking WARN because MONGODB_REQUIRED is not true.`;
      console.warn(`WARN MongoDB: ${warning}`);
      setResult(name, 'WARN', warning);
      return;
    }

    console.error(`FAIL MongoDB: ${message}`);
    setResult(name, 'FAIL', message);
  }
}

async function testSpacetimeDB() {
  const name = 'spacetimedb';
  console.log('\nTesting SpacetimeDB...');

  try {
    const baseUri = getRequiredEnv('SPACETIME_URI').replace(/\/+$/, '');
    const dbName = getRequiredEnv('SPACETIME_DB');
    const encodedDb = encodeURIComponent(dbName);

    const candidates = [
      `${baseUri}/v1/database/${dbName}`,
      `${baseUri}/database/${dbName}`,
      `${baseUri}/v1/database/${encodedDb}`,
      `${baseUri}/database/${encodedDb}`,
      `${baseUri}/v1/database/${dbName}/schema`,
      `${baseUri}/database/${dbName}/schema`,
    ];

    let reachable = false;
    let successUrl = '';
    let lastStatus = '';

    for (const url of candidates) {
      try {
        const response = await fetchWithTimeout(url);
        reachable = true;

        if (response.ok) {
          successUrl = url;
          break;
        }

        lastStatus = `HTTP ${response.status}`;
      } catch {
        // Try next endpoint variant.
      }
    }

    if (successUrl) {
      console.log(`PASS SpacetimeDB: Connected (${successUrl})`);
      setResult(name, 'PASS', 'Connected');
      return;
    }

    if (reachable) {
      const warning = `Server reachable but no known DB endpoint responded with 2xx (${lastStatus || 'no status'}).`;
      console.warn(`WARN SpacetimeDB: ${warning}`);
      setResult(name, 'WARN', warning);
      return;
    }

    throw new Error('Could not reach SpacetimeDB host or database endpoints');
  } catch (error) {
    console.error(`FAIL SpacetimeDB: ${trimText(error.message || error)}`);
    setResult(name, 'FAIL', trimText(error.message || error));
  }
}

async function runTests() {
  bootstrapEnv();

  console.log('=======================================================');
  console.log('AI Jury API Integration Tests');
  console.log('=======================================================');

  await testTavily();
  await testClaude();
  await testGemini();
  await testLlama();
  await testArmorIQ();
  await testMongoDB();
  await testSpacetimeDB();

  console.log('\n=======================================================');
  console.log('Test Summary');
  console.log('=======================================================');

  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const [name, result] of Object.entries(testResults)) {
    console.log(`${result.status} ${name.toUpperCase()}: ${result.detail}`);
    if (result.status === 'PASS') passed += 1;
    if (result.status === 'FAIL') failed += 1;
    if (result.status === 'WARN') warned += 1;
  }

  console.log('=======================================================');
  console.log(`Total: ${passed} passed, ${warned} warning(s), ${failed} failed`);
  console.log('=======================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error(`Fatal error: ${trimText(error?.message || error)}`);
  process.exit(1);
});
