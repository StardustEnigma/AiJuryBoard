/**
 * API Client Utilities
 * Tavily, Claude, Gemini, Llama
 */

import { log, logError, logSuccess, retry } from './logger.js';

function useMockApis(): boolean {
  return (process.env.ALLOW_MOCK_APIS || 'false').toLowerCase() === 'true';
}

function normalizeTopicForMock(query: string): string {
  const cleaned = query
    .replace(/\b(opposing\s+viewpoints?|counter\s+evidence|counter\s+arguments?|criticism|critical\s+analysis)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || query.replace(/\s+/g, ' ').trim();
}

function isCounterViewQuery(query: string): boolean {
  return /opposing\s+viewpoints?|counter\s+evidence|counter\s+arguments?|criticism|critical\s+analysis/i.test(query);
}

function extractTopicFromPrompt(prompt: string): string {
  const topicMatch = prompt.match(/(?:^|\n)\s*Topic:\s*([^\n]+)/i);
  if (topicMatch?.[1]) {
    return topicMatch[1].trim();
  }

  const evidenceTopicMatch = prompt.match(/evidence[^\n]*:\s*[\s\S]*?Topic:\s*([^\n]+)/i);
  if (evidenceTopicMatch?.[1]) {
    return evidenceTopicMatch[1].trim();
  }

  const quoted = prompt.match(/"([^"]{3,120})"/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const aboutMatch = prompt.match(/\b(?:about|on)\s+([a-z0-9 ,.'-]{3,120})/i);
  if (aboutMatch?.[1]) {
    return aboutMatch[1].trim();
  }

  log('🧪', 'Mock topic extraction fallback used');

  return 'the topic';
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function mockFallacyResponse(prompt: string): string {
  const argumentMatch = prompt.match(/Argument to analyze:\s*[\r\n]*"?([\s\S]+?)"?\s*$/i);
  const argument = (argumentMatch?.[1] || prompt).replace(/\s+/g, ' ').trim();
  const score = hashText(argument) % 5;

  const variants = [
    {
      fallacy: 'Potential hasty generalization',
      severity: 'LOW',
      explanation:
        'The claim appears to move from limited examples to a broad conclusion. It should cite wider evidence before asserting certainty.',
    },
    {
      fallacy: 'Potential false dilemma',
      severity: 'LOW',
      explanation:
        'The reasoning frames the choice too narrowly. It may overlook phased or mixed policy options that combine caution and action.',
    },
    {
      fallacy: 'Potential appeal to fear',
      severity: 'MEDIUM',
      explanation:
        'The argument emphasizes risk strongly but gives fewer concrete probability estimates, which can amplify urgency beyond evidence.',
    },
    {
      fallacy: 'Potential causal oversimplification',
      severity: 'LOW',
      explanation:
        'The argument suggests a direct cause-effect path while the evidence may involve multiple interacting factors.',
    },
    {
      fallacy: 'Potential confirmation bias in evidence selection',
      severity: 'LOW',
      explanation:
        'The claim leans on supportive facts more than contradictory findings. Counter-evidence should be addressed directly.',
    },
  ];

  const selected = variants[score];
  return `FALLACIES: ${selected.fallacy}\nSEVERITY: ${selected.severity}\nEXPLANATION: ${selected.explanation}`;
}

function mockTavilyResponse(query: string): TavilyResponse {
  const compactQuery = query.replace(/\s+/g, ' ').trim();
  const baseTopic = normalizeTopicForMock(compactQuery);
  const counterView = isCounterViewQuery(compactQuery);

  const primaryResults: TavilySearchResult[] = [
    {
      title: `${baseTopic}: recent social context and scope`,
      url: 'https://civic-insights.org/reports/social-context',
      content:
        `A neutral overview of ${baseTopic} outlining prevalence, stakeholders, and the institutional context where policy decisions are made.`,
      score: 0.93,
    },
    {
      title: `${baseTopic}: policy intervention outcomes`,
      url: 'https://governance-review.edu/policy/outcomes',
      content:
        `Comparative policy evidence suggests targeted interventions can improve outcomes when accountability and review mechanisms are explicit.`,
      score: 0.86,
    },
    {
      title: `${baseTopic}: implementation and cost considerations`,
      url: 'https://public-finance.net/implementation/brief',
      content:
        `Implementation quality, enforcement design, and monitoring costs materially affect whether policy goals are achieved over time.`,
      score: 0.82,
    },
  ];

  const counterResults: TavilySearchResult[] = [
    {
      title: `${baseTopic}: critique of one-size-fits-all policy`,
      url: 'https://rights-observer.org/analysis/policy-critique',
      content:
        `Critical reviews warn that broad interventions may overreach when local context differs and safeguards are weakly defined.`,
      score: 0.9,
    },
    {
      title: `${baseTopic}: unintended effects and edge cases`,
      url: 'https://policy-lab.edu/research/unintended-effects',
      content:
        `Edge-case failures are more common when rollout is rushed; phased deployment with audits reduces harm in contested domains.`,
      score: 0.84,
    },
    {
      title: `${baseTopic}: evidence quality and data gaps`,
      url: 'https://methods-journal.net/review/evidence-gaps',
      content:
        `Several studies highlight data-quality limits and selection bias risks, recommending independent verification before scale-up.`,
      score: 0.8,
    },
  ];

  const results = counterView ? counterResults : primaryResults;

  return {
    query: compactQuery,
    answer: `Local fallback evidence generated for topic: ${compactQuery}`,
    response_time: 0,
    results,
  };
}

function mockGroqResponse(prompt: string): string {
  const normalizedPrompt = prompt.toLowerCase();
  const topic = extractTopicFromPrompt(prompt);

  if (normalizedPrompt.includes('fallacies:') && normalizedPrompt.includes('severity:')) {
    return mockFallacyResponse(prompt);
  }

  if (normalizedPrompt.includes('prosecution_summary:') && normalizedPrompt.includes('verdict:')) {
    const summaryVariants = [
      {
        prosecution: `Prosecution argues ${topic} requires timely action backed by monitoring and accountability controls.`,
        defense: `Defense argues that on ${topic}, evidence quality varies and rushed rollout can create avoidable harms.`,
        analysis: `Both sides rely on assumptions about implementation quality in ${topic} that are not fully stress-tested.`,
        disagreement: `They disagree on speed, intervention strength, and acceptable short-term risk for ${topic}.`,
        verdict: `For ${topic}, a phased rollout with public checkpoints is stronger than immediate maximal action.`,
      },
      {
        prosecution: `Prosecution frames ${topic} as an escalating problem with compounding costs if action is delayed.`,
        defense: `Defense argues policy on ${topic} should start with pilots because broad mandates can overreach in edge cases.`,
        analysis: `The strongest gap is weak quantification of upside and downside scenarios for ${topic}.`,
        disagreement: `Disagreement centers on whether precaution means moving now or waiting for cleaner evidence on ${topic}.`,
        verdict: `On ${topic}, targeted pilots with independent audits should come before full-scale enforcement.`,
      },
      {
        prosecution: `Prosecution says the evidence on ${topic} is sufficient to justify immediate but bounded intervention.`,
        defense: `Defense says findings on ${topic} are mixed and implementation errors could damage trust.`,
        analysis: `Both sides under-specify rollback triggers and operational safeguards for ${topic}.`,
        disagreement: `They remain divided on timeline, scope, and tolerance for policy reversals in ${topic}.`,
        verdict: `For ${topic}, choose incremental action with measurable milestones and explicit rollback thresholds.`,
      },
    ];
    const selected = summaryVariants[hashText(topic) % summaryVariants.length];

    return [
      `PROSECUTION_SUMMARY: ${selected.prosecution}`,
      `DEFENSE_SUMMARY: ${selected.defense}`,
      `DEVIL_ADVOCATE_ANALYSIS: ${selected.analysis}`,
      `SHARED_REALITY: Both sides accept ${topic} is real and decisions should be evidence-led.`,
      `REMAINING_DISAGREEMENT: ${selected.disagreement}`,
      `VERDICT: ${selected.verdict}`,
    ].join('\n');
  }

  if (normalizedPrompt.includes("you are the devil's advocate") || normalizedPrompt.includes('devils advocate') || normalizedPrompt.includes('gap 1:')) {
    return [
      `Gap 1: In ${topic}, both sides treat their strongest assumptions as stable, but they are not tested against edge cases.`,
      'Gap 2: Prosecution leans on urgency while defense leans on caution, yet neither side quantifies likely outcomes clearly.',
      'Gap 3: Implementation quality, enforcement drift, and institutional capacity are under-specified in both arguments.',
      'Question: What if the core assumption each side depends on fails during rollout in the first six months?',
    ].join(' ');
  }

  if (normalizedPrompt.includes('you are the defense') || normalizedPrompt.includes('counterpoint 1:')) {
    return [
      `Counterpoint 1: The prosecution frames ${topic} as needing immediate strong action, but the current evidence base is still uneven across regions and groups.`,
      'Counterpoint 2: Rapid policy rollout can create collateral harms if enforcement standards are inconsistent or hard to audit.',
      'Counterpoint 3: A phased model with pilots, independent review, and correction checkpoints is more likely to preserve fairness over time.',
      'Closing: The stronger path is controlled implementation with measurable safeguards, not maximal intervention on day one.',
    ].join(' ');
  }

  if (normalizedPrompt.includes('you are the prosecutor') || normalizedPrompt.includes('point 1:')) {
    return [
      `Point 1: The evidence on ${topic} indicates ongoing harm and institutional blind spots that are unlikely to self-correct without intervention.`,
      'Point 2: Delay increases downstream social and operational costs, especially when early warning indicators are already visible in multiple studies.',
      'Point 3: A structured intervention model with transparent oversight can reduce risk while preserving accountability and public trust.',
      'Closing: Timely action is justified, provided safeguards are built into implementation from the start.',
    ].join(' ');
  }

  return [
    'The available evidence is mixed and should be handled with caution.',
    'A balanced, testable, and phased approach is usually more reliable than absolute positions.',
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
