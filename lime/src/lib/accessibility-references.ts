import type {
  ACTAccessibilityRequirement,
  AccessibilityReference,
} from "@/lib/act-rules";

export function normalizeACTAccessibilityRequirements(
  requirements: ACTAccessibilityRequirement[]
): AccessibilityReference[] {
  return requirements.flatMap((requirement) => {
    let title = requirement.title;

    const wcagCriterionMatch = requirement.id.match(/^wcag\d+:(\d+\.\d+\.\d+)$/);
    if (wcagCriterionMatch) {
      title = `WCAG ${wcagCriterionMatch[1]}`;
    }

    if (requirement.id.startsWith("wcag-technique:")) {
      return [];
    }

    return [
      {
        id: requirement.id,
        title,
        forConformance: requirement.forConformance,
      },
    ];
  });
}

export function mergeAccessibilityReferences(
  ...groups: AccessibilityReference[][]
): AccessibilityReference[] {
  const merged = new Map<string, AccessibilityReference>();

  for (const group of groups) {
    for (const reference of group) {
      const key = reference.title.trim().toLowerCase();
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, reference);
        continue;
      }

      if (reference.forConformance && !existing.forConformance) {
        merged.set(key, {
          ...existing,
          forConformance: true,
        });
      }
    }
  }

  return Array.from(merged.values());
}
