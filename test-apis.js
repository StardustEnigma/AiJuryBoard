#!/usr/bin/env node
/**
 * API Integration Test Suite
 * Tests all external APIs except ElevenLabs
 */

require('dotenv').config();

const testResults = {};

// 1. Test Tavily API
async function testTavily() {
  console.log('\n🔍 Testing Tavily API...');
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: 'Article 370 India 2024',
        include_answer: true,
        max_results: 3,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Tavily API: Connected');
    console.log(`   Found ${data.results?.length || 0} results`);
    testResults.tavily = 'PASS';
  } catch (error) {
    console.error('❌ Tavily API:', error.message);
    testResults.tavily = `FAIL: ${error.message}`;
  }
}

// 2. Test Claude API
async function testClaude() {
  console.log('\n🤖 Testing Claude API...');
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'Say one sentence about debate.',
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`HTTP ${response.status}: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Claude API: Connected');
    console.log(`   Response: ${data.content?.[0]?.text?.substring(0, 60)}...`);
    testResults.claude = 'PASS';
  } catch (error) {
    console.error('❌ Claude API:', error.message);
    testResults.claude = `FAIL: ${error.message}`;
  }
}

// 3. Test Gemini API
async function testGemini() {
  console.log('\n✨ Testing Gemini API...');
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: 'Summarize a debate in one sentence.' }],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`HTTP ${response.status}: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Gemini API: Connected');
    console.log(`   Response: ${data.candidates?.[0]?.content?.parts?.[0]?.text?.substring(0, 60)}...`);
    testResults.gemini = 'PASS';
  } catch (error) {
    console.error('❌ Gemini API:', error.message);
    testResults.gemini = `FAIL: ${error.message}`;
  }
}

// 4. Test Llama API (via Groq)
async function testLlama() {
  console.log('\n🦙 Testing Llama API (Groq)...');
  try {
    const model = process.env.LLAMA_MODEL || 'llama-3.1-8b-instant';
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'user',
            content: 'Find one logical fallacy in this sentence: "Because everyone believes it, it must be true."',
          },
        ],
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`HTTP ${response.status}: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Llama API: Connected');
    console.log(`   Response: ${data.choices?.[0]?.message?.content?.substring(0, 60)}...`);
    testResults.llama = 'PASS';
  } catch (error) {
    console.error('❌ Llama API:', error.message);
    testResults.llama = `FAIL: ${error.message}`;
  }
}

// 5. Test ArmorIQ API
async function testArmorIQ() {
  console.log('\n🛡️  Testing ArmorIQ API...');
  try {
    const response = await fetch('https://api.armoriq.io/v1/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ARMOR_IQ_KEY}`,
      },
      body: JSON.stringify({
        content: 'This is a prosecution argument in favor of the thesis.',
        role: 'prosecutor',
        context: 'judicial debate',
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`HTTP ${response.status}: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ ArmorIQ API: Connected');
    console.log(`   Validated: ${data.valid ? 'Yes' : 'No'}`);
    testResults.armoriq = 'PASS';
  } catch (error) {
    console.error('❌ ArmorIQ API:', error.message);
    testResults.armoriq = `FAIL: ${error.message}`;
  }
}

// 6. Test MongoDB
async function testMongoDB() {
  console.log('\n📊 Testing MongoDB...');
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    
    await client.connect();
    const adminDb = client.db('admin');
    await adminDb.command({ ping: 1 });
    
    console.log('✅ MongoDB: Connected');
    testResults.mongodb = 'PASS';
    
    await client.close();
  } catch (error) {
    console.error('❌ MongoDB:', error.message);
    testResults.mongodb = `FAIL: ${error.message}`;
  }
}

// 7. Test SpacetimeDB
async function testSpacetimeDB() {
  console.log('\n💾 Testing SpacetimeDB...');
  try {
    const response = await fetch(`${process.env.SPACETIME_URI}/database/${process.env.SPACETIME_DB}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    console.log('✅ SpacetimeDB: Connected');
    testResults.spacetimedb = 'PASS';
  } catch (error) {
    console.error('❌ SpacetimeDB:', error.message);
    testResults.spacetimedb = `FAIL: ${error.message}`;
  }
}

// Main test runner
async function runTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🧪 AI Jury API Integration Tests (Excluding ElevenLabs)');
  console.log('═══════════════════════════════════════════════════════');

  await testTavily();
  await testClaude();
  await testGemini();
  await testLlama();
  await testArmorIQ();
  await testMongoDB();
  await testSpacetimeDB();

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('📋 Test Summary');
  console.log('═══════════════════════════════════════════════════════');

  let passed = 0;
  let failed = 0;

  Object.entries(testResults).forEach(([name, result]) => {
    const status = result === 'PASS' ? '✅' : '❌';
    console.log(`${status} ${name.toUpperCase()}: ${result}`);
    if (result === 'PASS') passed++;
    else failed++;
  });

  console.log('═══════════════════════════════════════════════════════');
  console.log(`Total: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

// Run all tests
runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
