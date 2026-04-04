/**
 * API Client Utilities
 * Tavily, Claude, Gemini, Llama
 */

import { log, logError, logSuccess, retry } from './logger.js';

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
  if (!apiKey) throw new Error('TAVILY_API_KEY not set');

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
  
  if (!apiKey) throw new Error('LLAMA_API_KEY not set');

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
          max_tokens: 1000,
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

export async function callLlama(prompt: string): Promise<string> {
  const model = process.env.LLAMA_MODEL || 'llama-3.1-8b-instant';
  return callGroqModel(prompt, model, '🦙', 'Llama');
}

export async function callMixtral(prompt: string): Promise<string> {
  const model = 'mixtral-8x7b-32768';
  return callGroqModel(prompt, model, '🔀', 'Mixtral');
}

export async function callLlamaLarge(prompt: string): Promise<string> {
  const model = 'llama-3.1-70b-versatile';
  return callGroqModel(prompt, model, '🦙', 'Llama-70B');
}
