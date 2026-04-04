export type PolicyCheck = {
  allowed: boolean;
  sanitizedText: string;
  warnings: string[];
  reason?: string;
};

const INJECTION_PATTERNS = [
  /ignore\s+(all|any|previous|prior)\s+instructions?/gi,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/gi,
  /jailbreak/gi,
  /developer\s+mode/gi,
  /do\s+anything\s+now/gi,
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*•]\s+/gm, '')
    .trim();
}

function clampWords(value: string, maxWords: number): string {
  const words = normalizeWhitespace(value).split(' ').filter(Boolean);
  if (words.length <= maxWords) {
    return normalizeWhitespace(value);
  }

  return `${words.slice(0, maxWords).join(' ')}...`;
}

function applyInjectionSanitization(value: string): { sanitized: string; warnings: string[] } {
  let sanitized = value;
  const warnings: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      warnings.push('prompt-injection-pattern-removed');
      sanitized = sanitized.replace(pattern, ' ');
    }
  }

  return {
    sanitized: normalizeWhitespace(sanitized),
    warnings,
  };
}

export function gateSearchTopic(topic: string): PolicyCheck {
  const trimmed = normalizeWhitespace(topic).slice(0, 300);
  if (!trimmed) {
    return {
      allowed: false,
      sanitizedText: '',
      warnings: ['empty-topic'],
      reason: 'Topic is empty after normalization',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(trimmed);
  if (!sanitized) {
    return {
      allowed: false,
      sanitizedText: '',
      warnings: [...warnings, 'topic-removed-by-policy'],
      reason: 'Topic content removed by policy sanitization',
    };
  }

  return {
    allowed: true,
    sanitizedText: sanitized,
    warnings,
  };
}

export function fallbackArgument(role: string): string {
  if (role === 'PROSECUTION') {
    return 'Point 1: The evidence suggests the core problem is serious. Point 2: Multiple sources indicate real harm. Point 3: Delayed action increases risk. Closing: Based on available facts, stronger action is justified.';
  }

  if (role === 'DEFENSE') {
    return 'Counterpoint 1: The issue is complex and not explained by one cause. Counterpoint 2: Some evidence is selective and may miss context. Counterpoint 3: Interventions can have side effects. Closing: A balanced, evidence-led approach is safer than one-sided conclusions.';
  }

  return 'Gap 1: Key assumptions are not fully tested. Gap 2: Evidence strength differs across claims. Gap 3: Long-term outcomes remain uncertain. Question: What changes if the strongest assumption from each side is wrong?';
}

export function gateGeneratedArgument(role: string, text: string, maxWords: number): PolicyCheck {
  const stripped = stripMarkdown(text);
  const normalized = normalizeWhitespace(stripped);

  if (!normalized) {
    return {
      allowed: false,
      sanitizedText: fallbackArgument(role),
      warnings: ['empty-generated-text'],
      reason: 'Model returned empty text',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(normalized);
  const limited = clampWords(sanitized, maxWords);

  const outputWarnings = [...warnings];
  if (limited !== sanitized) {
    outputWarnings.push('argument-trimmed-to-word-cap');
  }

  return {
    allowed: true,
    sanitizedText: limited,
    warnings: outputWarnings,
  };
}

function ensureSynthesisSections(value: string): string {
  const required = [
    'PROSECUTION_SUMMARY:',
    'DEFENSE_SUMMARY:',
    'DEVIL_ADVOCATE_ANALYSIS:',
    'SHARED_REALITY:',
    'REMAINING_DISAGREEMENT:',
    'VERDICT:',
  ];

  let out = value;
  for (const section of required) {
    if (!new RegExp(`(^|\\n)${section.replace(':', '\\:')}`, 'i').test(out)) {
      out = `${out}\n${section} Not provided.`;
    }
  }

  return out.trim();
}

export function gateSynthesisOutput(text: string, maxWords = 160): PolicyCheck {
  const stripped = stripMarkdown(text);
  const normalized = normalizeWhitespace(stripped);

  if (!normalized) {
    return {
      allowed: false,
      sanitizedText:
        'PROSECUTION_SUMMARY: Not provided. DEFENSE_SUMMARY: Not provided. DEVIL_ADVOCATE_ANALYSIS: Not provided. SHARED_REALITY: Not provided. REMAINING_DISAGREEMENT: Not provided. VERDICT: Unable to determine due to insufficient synthesis output.',
      warnings: ['empty-synthesis-output'],
      reason: 'Model returned empty synthesis',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(normalized);
  const sectioned = ensureSynthesisSections(sanitized);
  const limited = clampWords(sectioned, maxWords);
  const outputWarnings = [...warnings];

  if (limited !== sectioned) {
    outputWarnings.push('synthesis-trimmed-to-word-cap');
  }

  return {
    allowed: true,
    sanitizedText: limited,
    warnings: outputWarnings,
  };
}

export function gateFallacyOutput(text: string): PolicyCheck {
  const stripped = stripMarkdown(text);
  const normalized = normalizeWhitespace(stripped);

  if (!normalized) {
    return {
      allowed: false,
      sanitizedText: 'FALLACIES: None\nSEVERITY: NONE\nEXPLANATION: No analyzable output returned.',
      warnings: ['empty-fallacy-output'],
      reason: 'Model returned empty fallacy analysis',
    };
  }

  const withHeadings = [
    /FALLACIES:/i.test(normalized) ? normalized : `FALLACIES: None\n${normalized}`,
  ][0];

  const ensuredSeverity = /SEVERITY:/i.test(withHeadings)
    ? withHeadings
    : `${withHeadings}\nSEVERITY: LOW`;
  const ensuredExplanation = /EXPLANATION:/i.test(ensuredSeverity)
    ? ensuredSeverity
    : `${ensuredSeverity}\nEXPLANATION: ${normalized}`;

  return {
    allowed: true,
    sanitizedText: ensuredExplanation,
    warnings: [],
  };
}