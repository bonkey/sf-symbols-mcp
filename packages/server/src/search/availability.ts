import type { Availability, Platform } from "@sfsmcp/schema";

/** Compare marketing OS versions ("13.0" vs "26.1"). Negative when a < b. */
export function compareOsVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Whether a symbol is usable given the caller's minimum OS versions:
 * for every requested platform the symbol must exist there and have been
 * introduced at or before that version.
 */
export function meetsAvailability(
  availability: Availability,
  minOS: Partial<Record<Platform, string | undefined>>,
): boolean {
  for (const [platform, requested] of Object.entries(minOS)) {
    if (!requested) continue;
    const introduced = availability[platform as Platform];
    if (!introduced) return false;
    if (compareOsVersions(introduced, requested) > 0) return false;
  }
  return true;
}
