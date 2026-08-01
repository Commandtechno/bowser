// curated set of shiki bundled themes offered in settings; api/code.ts only accepts these
export const SYNTAX_THEMES: { id: string; label: string }[] = [
  { id: "github-dark", label: "GitHub Dark" },
  { id: "github-light", label: "GitHub Light" },
  { id: "dracula", label: "Dracula" },
  { id: "monokai", label: "Monokai" },
  { id: "nord", label: "Nord" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { id: "catppuccin-latte", label: "Catppuccin Latte" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "solarized-dark", label: "Solarized Dark" },
  { id: "solarized-light", label: "Solarized Light" },
  { id: "vitesse-dark", label: "Vitesse Dark" },
  { id: "rose-pine", label: "Rosé Pine" },
  { id: "min-dark", label: "Min Dark" },
  { id: "material-theme", label: "Material Theme" },
  { id: "material-theme-darker", label: "Material Theme Darker" },
  { id: "material-theme-lighter", label: "Material Theme Lighter" },
  { id: "material-theme-ocean", label: "Material Theme Ocean" },
  { id: "material-theme-palenight", label: "Material Theme Palenight" }
];

export const isSyntaxTheme = (id: unknown): id is string =>
  typeof id === "string" && SYNTAX_THEMES.some(t => t.id === id);

// accent presets shown as swatches in settings
export const ACCENT_PRESETS = ["#00ffc1", "#ff6b81", "#ffd166", "#7aa2f7", "#c792ea", "#7fdb6a", "#ff9e64", "#f4f4f5"];
