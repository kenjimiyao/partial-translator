import { domainIncludes, normalizeDomain } from "./domain";

interface ParsedOriginPattern {
  scheme: "http" | "https" | "both";
  hostname: string | "*";
  includesSubdomains: boolean;
}

function parseOriginPattern(pattern: string): ParsedOriginPattern | undefined {
  if (pattern === "<all_urls>" || pattern === "*://*/*") {
    return { scheme: "both", hostname: "*", includesSubdomains: true };
  }

  const match = /^(\*|https?):\/\/(\*\.)?([^/]+)\/\*$/u.exec(pattern);
  if (!match) {
    return undefined;
  }
  const rawScheme = match[1];
  const rawHostname = match[3].toLowerCase();
  return {
    scheme:
      rawScheme === "*" ? "both" : (rawScheme as "http" | "https"),
    hostname: rawHostname === "*" ? "*" : rawHostname,
    includesSubdomains: Boolean(match[2]) || rawHostname === "*",
  };
}

function patternCoversDomain(
  parsed: ParsedOriginPattern,
  domain: string,
): boolean {
  if (parsed.hostname === "*") {
    return true;
  }
  if (!parsed.includesSubdomains) {
    return false;
  }
  try {
    return domainIncludes(parsed.hostname, domain);
  } catch {
    return false;
  }
}

function patternOverlapsDomain(
  parsed: ParsedOriginPattern,
  domain: string,
): boolean {
  if (parsed.hostname === "*") {
    return true;
  }
  try {
    if (!parsed.includesSubdomains) {
      return domainIncludes(domain, parsed.hostname);
    }
    return (
      domainIncludes(parsed.hostname, domain) ||
      domainIncludes(domain, parsed.hostname)
    );
  } catch {
    return false;
  }
}

function patternHasScheme(
  parsed: ParsedOriginPattern,
  scheme: "http" | "https",
): boolean {
  return parsed.scheme === "both" || parsed.scheme === scheme;
}

/** Whether the existing origin grants cover HTTP and HTTPS for a domain tree. */
export function originsCoverDomain(
  origins: readonly string[],
  domainValue: string,
): boolean {
  const coverage = originSchemeCoverage(origins, domainValue);
  return coverage.http && coverage.https;
}

export function originSchemeCoverage(
  origins: readonly string[],
  domainValue: string,
): { http: boolean; https: boolean } {
  const domain = normalizeDomain(domainValue);
  let http = false;
  let https = false;

  for (const origin of origins) {
    const parsed = parseOriginPattern(origin);
    if (!parsed || !patternCoversDomain(parsed, domain)) {
      continue;
    }
    if (parsed.scheme === "both" || parsed.scheme === "http") {
      http = true;
    }
    if (parsed.scheme === "both" || parsed.scheme === "https") {
      https = true;
    }
  }
  return { http, https };
}

/** Exact scheme grants to remove when rolling back a permission request. */
export function missingOriginPatternsForDomain(
  origins: readonly string[],
  domainValue: string,
): string[] {
  const domain = normalizeDomain(domainValue);
  const coverage = originSchemeCoverage(origins, domain);
  const missing: string[] = [];
  if (!coverage.http) {
    missing.push(`http://*.${domain}/*`);
  }
  if (!coverage.https) {
    missing.push(`https://*.${domain}/*`);
  }
  return missing;
}

export interface PermissionRollbackPlan {
  origins: string[];
  hasUnsafeOverlap: boolean;
}

/**
 * Builds only rollback removals that cannot intersect an older grant. Chrome
 * removes PermissionSet intersections, so a broad removal must be skipped when
 * an older, narrower host grant overlaps it.
 */
export function permissionRollbackPlanForDomain(
  origins: readonly string[],
  domainValue: string,
): PermissionRollbackPlan {
  const domain = normalizeDomain(domainValue);
  const coverage = originSchemeCoverage(origins, domain);
  const parsedOrigins = origins
    .map(parseOriginPattern)
    .filter((value): value is ParsedOriginPattern => value !== undefined);
  const rollbackOrigins: string[] = [];
  let hasUnsafeOverlap = false;

  for (const scheme of ["http", "https"] as const) {
    if (coverage[scheme]) {
      continue;
    }
    const overlaps = parsedOrigins.some(
      (parsed) =>
        patternHasScheme(parsed, scheme) &&
        patternOverlapsDomain(parsed, domain),
    );
    if (overlaps) {
      hasUnsafeOverlap = true;
    } else {
      rollbackOrigins.push(`${scheme}://*.${domain}/*`);
    }
  }

  return { origins: rollbackOrigins, hasUnsafeOverlap };
}
