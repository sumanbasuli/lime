export type ViewportPreset = "desktop" | "laptop" | "tablet" | "mobile";

export interface ViewportPresetOption {
  key: ViewportPreset;
  label: string;
  width: number;
  height: number;
}

export const viewportPresetOptions: ViewportPresetOption[] = [
  { key: "desktop", label: "Desktop", width: 1440, height: 900 },
  { key: "laptop", label: "Laptop", width: 1280, height: 800 },
  { key: "tablet", label: "Tablet", width: 768, height: 1024 },
  { key: "mobile", label: "Mobile", width: 390, height: 844 },
];

export function getViewportPresetOption(
  preset: string | null | undefined
): ViewportPresetOption {
  return (
    viewportPresetOptions.find((option) => option.key === preset) ??
    viewportPresetOptions[0]
  );
}

export function formatViewportLabel(
  preset: string | null | undefined,
  width: number | null | undefined,
  height: number | null | undefined
): string {
  const option = getViewportPresetOption(preset);
  const resolvedWidth = width ?? option.width;
  const resolvedHeight = height ?? option.height;

  return `${option.label} ${resolvedWidth}\u00d7${resolvedHeight}`;
}
