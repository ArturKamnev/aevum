import type { Project } from "../types";

export const defaultCategoryColor = "var(--project-sage)";

export const aevumCategoryPalette = [
  "var(--project-sage)",
  "var(--project-clay)",
  "var(--project-ink)",
  "var(--project-mint)",
  "var(--project-sky)",
  "var(--project-violet)",
  "var(--project-rose)",
  "var(--project-gold)",
] as const;

export type AevumCategoryColor = typeof aevumCategoryPalette[number];

export function isAevumCategoryColor(value: string): value is AevumCategoryColor {
  return (aevumCategoryPalette as readonly string[]).includes(value);
}

export function assignCategoryColor(projects: readonly Pick<Project, "color">[]): AevumCategoryColor {
  const counts = new Map<AevumCategoryColor, number>();
  aevumCategoryPalette.forEach((color) => counts.set(color, 0));

  for (const project of projects) {
    if (isAevumCategoryColor(project.color)) {
      counts.set(project.color, (counts.get(project.color) ?? 0) + 1);
    }
  }

  return aevumCategoryPalette.reduce((best, color) => {
    const bestCount = counts.get(best) ?? 0;
    const colorCount = counts.get(color) ?? 0;
    return colorCount < bestCount ? color : best;
  }, aevumCategoryPalette[0]);
}
