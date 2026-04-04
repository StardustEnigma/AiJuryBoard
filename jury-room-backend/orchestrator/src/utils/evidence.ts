import type { TavilySearchResult } from './apis.js';

type CuratedEvidenceSnapshot = {
  title: string;
  source: string;
  content: string;
  url?: string;
  selected: TavilySearchResult[];
  diversityReport: string[];
};

function safeDomain(url?: string): string {
  if (!url) return 'unknown-source';

  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown-source';
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function dedupeAndSort(results: TavilySearchResult[]): TavilySearchResult[] {
  const seen = new Set<string>();
  const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const deduped: TavilySearchResult[] = [];

  for (const result of sorted) {
    const title = normalizeText(result.title || '');
    const contentHead = normalizeText((result.content || '').slice(0, 140));
    const domain = safeDomain(result.url);
    const key = `${domain}|${title}|${contentHead}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(result);
  }

  return deduped;
}

function pickDiverseSources(results: TavilySearchResult[], maxSources: number): TavilySearchResult[] {
  const selected: TavilySearchResult[] = [];
  const usedDomains = new Set<string>();

  for (const result of results) {
    const domain = safeDomain(result.url);
    if (domain === 'unknown-source' || usedDomains.has(domain)) {
      continue;
    }

    selected.push(result);
    usedDomains.add(domain);

    if (selected.length >= maxSources) {
      return selected;
    }
  }

  for (const result of results) {
    if (selected.length >= maxSources) {
      break;
    }

    if (!selected.includes(result)) {
      selected.push(result);
    }
  }

  return selected;
}

export function curateEvidenceSnapshot(
  topic: string,
  rawResults: TavilySearchResult[],
  maxSources = 3
): CuratedEvidenceSnapshot {
  const usable = rawResults.filter((result) => {
    const hasTitle = Boolean(result.title && result.title.trim());
    const hasContent = Boolean(result.content && result.content.trim());
    return hasTitle && hasContent;
  });

  const deduped = dedupeAndSort(usable);
  const selected = pickDiverseSources(deduped, maxSources);

  const domains = selected.map((result) => safeDomain(result.url));
  const uniqueDomains = new Set(domains.filter((domain) => domain !== 'unknown-source'));
  const diversityReport: string[] = [
    `Selected sources: ${selected.length}`,
    `Unique domains: ${uniqueDomains.size}`,
  ];

  if (selected.length > 1 && uniqueDomains.size < 2) {
    diversityReport.push('Potential concentration bias: most evidence came from one domain family.');
  } else {
    diversityReport.push('Source diversity check: passed basic domain spread.');
  }

  const findings = selected.map((result, index) => {
    const title = compact(result.title || 'Untitled', 120);
    const snippet = compact(result.content || '', 180);
    return `- Finding ${index + 1}: ${title}. ${snippet}`;
  });

  const sourceList = selected.map((result) => {
    const domain = safeDomain(result.url);
    const title = compact(result.title || 'Untitled', 80);
    return `- ${domain}: ${title}`;
  });

  const content = [
    `Topic: ${topic}`,
    `Evidence snapshot generated from ${selected.length} source(s).`,
    'Key findings:',
    ...findings,
    'Bias checks:',
    ...diversityReport.map((line) => `- ${line}`),
    'Sources:',
    ...sourceList,
  ].join('\n');

  return {
    title: `Evidence Snapshot (${selected.length} sources)`,
    source: [...uniqueDomains].join(' | ') || 'unknown-source',
    content,
    url: selected[0]?.url,
    selected,
    diversityReport,
  };
}