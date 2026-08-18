/** A validation problem tied to the original textarea line. */
export interface DomainInputError {
  line: number;
  value: string;
  message: string;
}

export interface ParsedDomainLines {
  domains: string[];
  errors: DomainInputError[];
}

const HOSTNAME_ERROR =
  "ホスト名として入力してください（例: example.com）。URL、ポート番号、パス、ワイルドカードは使えません。";

/**
 * Normalize a user-entered hostname for storage and Chrome match patterns.
 *
 * URL-like input is deliberately rejected rather than silently extracting its
 * hostname. Unicode hostnames are converted to their ASCII/IDNA representation
 * by the platform URL parser.
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("ドメインを入力してください。");
  }

  if (
    trimmed.includes("://") ||
    /[/?#@:*\\]/u.test(trimmed) ||
    /\s/u.test(trimmed) ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("-")
  ) {
    throw new Error(HOSTNAME_ERROR);
  }

  // A single terminal dot is a valid DNS notation. It is not part of the
  // hostname Chrome expects in a match pattern, so remove it when storing.
  const withoutTerminalDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (!withoutTerminalDot || withoutTerminalDot.endsWith(".")) {
    throw new Error(HOSTNAME_ERROR);
  }

  let hostname: string;
  try {
    const parsed = new URL(`http://${withoutTerminalDot}`);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    throw new Error(HOSTNAME_ERROR);
  }

  if (hostname.length > 253 || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) {
    throw new Error(HOSTNAME_ERROR);
  }

  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new Error(HOSTNAME_ERROR);
  }

  return hostname;
}

/** Parse one-hostname-per-line input while preserving useful line errors. */
export function parseDomainLines(input: string): ParsedDomainLines {
  const domains: string[] = [];
  const errors: DomainInputError[] = [];
  const seen = new Set<string>();

  input.split(/\r?\n/u).forEach((value, index) => {
    if (!value.trim()) {
      return;
    }

    try {
      const normalized = normalizeDomain(value);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        domains.push(normalized);
      }
    } catch (error) {
      errors.push({
        line: index + 1,
        value: value.trim(),
        message: error instanceof Error ? error.message : HOSTNAME_ERROR,
      });
    }
  });

  return { domains, errors };
}

/** True when `candidate` is the same hostname or a subdomain of `domain`. */
export function domainIncludes(domain: string, candidate: string): boolean {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCandidate = normalizeDomain(candidate);
  return (
    normalizedCandidate === normalizedDomain ||
    normalizedCandidate.endsWith(`.${normalizedDomain}`)
  );
}

/**
 * Remove duplicate and redundant subdomain entries. The first occurrence wins,
 * while the result stays deterministic and keeps the user's relative ordering.
 */
export function minimizeDomains(domains: readonly string[]): string[] {
  const normalized = [...new Set(domains.map(normalizeDomain))];
  return normalized.filter(
    (candidate) =>
      !normalized.some(
        (other) => other !== candidate && domainIncludes(other, candidate),
      ),
  );
}

/**
 * Chrome's wildcard host pattern covers the apex and every subdomain. Keep the
 * schemes separate so runtime requests are direct subsets of the optional host
 * permissions declared in the manifest.
 */
export function domainToMatchPatterns(domain: string): string[] {
  const normalized = normalizeDomain(domain);
  return [
    `http://*.${normalized}/*`,
    `https://*.${normalized}/*`,
  ];
}

export function domainsToMatchPatterns(domains: readonly string[]): string[] {
  return minimizeDomains(domains).flatMap(domainToMatchPatterns);
}
