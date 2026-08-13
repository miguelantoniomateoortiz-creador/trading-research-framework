import type { Config } from "tailwindcss";

/**
 * El dashboard vive siempre en modo oscuro (decisión del roadmap, no una
 * preferencia de sistema): un laboratorio de investigación se mira durante
 * horas y el contraste bajo cansa menos. Paleta reducida a propósito.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: {
          950: "#0a0b0e",
          900: "#111318",
          850: "#161922",
          800: "#1c202b",
          700: "#2a2f3d",
          600: "#3a4155",
          400: "#7b8496",
          300: "#a3abbb",
          100: "#e6e9f0",
        },
        accent: {
          DEFAULT: "#5eead4",
          dim: "#134e4a",
        },
        good: "#4ade80",
        bad: "#f87171",
        warn: "#fbbf24",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
