/**
 * API Client Utilities
 * Tavily, Claude, Gemini, Llama
 */

import { log, logError, logSuccess, retry } from './logger.js';

function useMockApis(): boolean {
  return (process.env.ALLOW_MOCK_APIS || 'true').toLowerCase() !== 'false';
}

function mockTavilyResponse(query: string): TavilyResponse {
  const compactQuery = query.replace(/\s+/g, ' ').trim();
  return {
    query: compactQuery,
    answer: `Local fallback evidence generated for topic: ${compactQuery}`,
    response_time: 0,
    results: [
      {
        title: `Context snapshot: ${compactQuery}`,
        url: 'https://example.org/context',
        content:
          'This is a local fallback evidence item created because Tavily API credentials are missing. It provides neutral baseline context for debate flow testing.',
        score: 0.92,
      },
      {
        title: `Supporting considerations for ${compactQuery}`,
        url: 'https://example.org/support',
        content:
          'Some arguments support intervention based on possible social impact, operational efficiency, and risk reduction when governance controls are explicit.',
        score: 0.84,
      },
      {
        title: `Counter-view considerations for ${compactQuery}`,
        url: 'https://example.org/counter',
        content:
          'Some arguments caution against overreach, weak evidence quality, and unintended side effects. They recommend phased rollout and independent review.',
        score: 0.81,
      },
    ],
  };
}

function mockGroqResponse(prompt: string): string {
  const normalizedPrompt = prompt.toLowerCase();

  if (normalizedPrompt.includes('fallacies:') && normalizedPrompt.includes('severity:')) {
    return 'FALLACIES: Potential hasty generalization\nSEVERITY: LOW\nEXPLANATION: The argument may over-extend from limited examples and should cite broader evidence.';
  }

  if (normalizedPrompt.includes('prosecution_summary:') && normalizedPrompt.includes('verdict:')) {
    return [
      'PROSECUTION_SUMMARY: Prosecution argues action is needed to reduce harm and improve accountability.',
      'DEFENSE_SUMMARY: Defense argues evidence is mixed and policy may create side effects if rushed.',
      'DEVIL_ADVOCATE_ANALYSIS: Key assumptions on both sides need stronger validation and edge-case testing.',
      'SHARED_REALITY: Both sides accept the issue is real and decisions should be evidence-led.',
      'REMAINING_DISAGREEMENT: Disagreement remains on urgency, intervention strength, and acceptable risk.',
      'VERDICT: A phased approach with safeguards is stronger than immediate maximal action.',
    ].join('\n');
  }

  if (normalizedPrompt.includes('counterpoint 1:')) {
    return [
      'Counterpoint 1: The evidence is not complete and may miss context.',
      'Counterpoint 2: Fast policy changes can create unexpected harm.',
      'Counterpoint 3: A phased plan allows correction based on new data.',
      'Closing: Caution with measurable checkpoints is the safer path.',
    ].join(' ');
  }

  if (normalizedPrompt.includes('gap 1:')) {
    return [
      'Gap 1: Core assumptions are stated but not fully tested.',
      'Gap 2: Evidence quality differs across major claims.',
      'Gap 3: Long-term outcomes are uncertain in both proposals.',
      'Question: What if the strongest assumption from each side fails in practice?',
    ].join(' ');
  }

  return [
    'Point 1: Available evidence suggests the issue requires active response.',
    'Point 2: Delay increases operational and social risk.',
    'Point 3: Structured intervention with oversight improves outcomes.',
    'Closing: Action with clear safeguards is justified.',
  ].join(' ');
}

// ============ TAVILY SEARCH ============

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilyResponse {
  results: TavilySearchResult[];
  answer: string;
  query: string;
  response_time: number;
}

export async function searchTavily(query: string): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    if (!useMockApis()) {
      throw new Error('TAVILY_API_KEY not set');
    }

    log('🔍', 'TAVILY_API_KEY missing, using local mock evidence results');
    return mockTavilyResponse(query);
  }

  return retry(
    async () => {
      log('🔍', `Searching Tavily: "${query}"`);
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          include_answer: true,
          max_results: 5,
          include_raw_content: true,
        }),
      });

      if (!response.ok) {
        const error = await response.json() as any;
        throw new Error(`Tavily error: ${(error?.error?.message) || response.statusText}`);
      }

      const data = (await response.json()) as TavilyResponse;
      logSuccess('🔍', `Found ${data.results.length} results`);
      return data;
    },
    'Tavily search',
    3,
    2000
  );
}



// ============ GROQ API (Llama, Mixtral, etc) ============

export interface GroqResponse {
  choices: { message: { content: string } }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

async function callGroqModel(prompt: string, model: string, emoji: string, name: string): Promise<string> {
  const apiKey = process.env.LLAMA_API_KEY;
  
  if (!apiKey) {
    if (!useMockApis()) {
      throw new Error('LLAMA_API_KEY not set');
    }

    log(emoji, `${name} API key missing, using local mock response`);
    return mockGroqResponse(prompt);
  }

  return retry(
    async () => {
      log(emoji, `Calling ${name} via Groq (${model})`);
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 220,
        }),
      });

      if (!response.ok) {
        const error = await response.json() as any;
        throw new Error(`${name} error: ${(error?.error?.message) || response.statusText}`);
      }

      const data = (await response.json()) as GroqResponse;
      const text = data.choices?.[0]?.message?.content || '';
      logSuccess(emoji, `${name} responded (${data.usage?.completion_tokens || 0} tokens)`);
      return text;
    },
    `${name} API call`,
    3,
    2000
  );
}

export function clampToWords(text: string, maxWords: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const words = normalized.split(' ');
  if (words.length <= maxWords) {
    return normalized;
  }

  return `${words.slice(0, maxWords).join(' ')}...`;
}

export async function callLlama(prompt: string): Promise<string> {
  const model = process.env.LLAMA_MODEL || 'llama-3.1-8b-instant';
  return callGroqModel(prompt, model, '🦙', 'Llama');
}

export async function callMixtral(prompt: string): Promise<string> {
  const model = process.env.ARGUMENT_MODEL || process.env.MIXTRAL_MODEL || 'llama-3.3-70b-versatile';
  return callGroqModel(prompt, model, '🔀', 'Argument-LLM');
}

export async function callLlamaLarge(prompt: string): Promise<string> {
  const model = process.env.LLAMA_LARGE_MODEL || 'llama-3.3-70b-versatile';
  return callGroqModel(prompt, model, '🦙', 'Llama-70B');
}
