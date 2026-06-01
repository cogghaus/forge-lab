import type { Config } from 'tailwindcss';
import { heroui } from '@heroui/react';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  darkMode: 'class',
  plugins: [
    heroui({
      themes: {
        dark: {
          colors: {
            background: '#0D0D0F',
            foreground: '#F5F0EB',
            divider: 'rgba(255,255,255,0.06)',
            focus: '#FF6B2B',
            overlay: 'rgba(0,0,0,0.6)',
            content1: '#1A1A1F',
            content2: '#24242C',
            content3: '#2E2E38',
            content4: '#3A3A44',
            primary: {
              50: '#fff2ec',
              100: '#ffd9c4',
              200: '#ffbf9c',
              300: '#ff9a6a',
              400: '#ff8047',
              500: '#FF6B2B',
              600: '#e5531a',
              700: '#c4400d',
              800: '#9a3208',
              900: '#6f2305',
              DEFAULT: '#FF6B2B',
              foreground: '#F5F0EB',
            },
            secondary: {
              50: '#ebf4ff',
              100: '#cee4ff',
              200: '#a8d1ff',
              300: '#79b8ff',
              400: '#4A9EFF',
              500: '#2383e8',
              600: '#1868c4',
              700: '#104fa0',
              800: '#0c3c7a',
              900: '#082a56',
              DEFAULT: '#4A9EFF',
              foreground: '#0D0D0F',
            },
            success: {
              50: '#e6faf5',
              100: '#b3f0e2',
              200: '#80e6cf',
              300: '#4dddbc',
              400: '#2DD4A0',
              500: '#1eba88',
              600: '#179e72',
              700: '#10815c',
              800: '#096547',
              900: '#044933',
              DEFAULT: '#2DD4A0',
              foreground: '#0D0D0F',
            },
            warning: {
              50: '#fff8ec',
              100: '#ffecc8',
              200: '#ffe0a4',
              300: '#ffd07a',
              400: '#FFB547',
              500: '#e89a2b',
              600: '#c47e1a',
              700: '#a06310',
              800: '#7a4a09',
              900: '#553203',
              DEFAULT: '#FFB547',
              foreground: '#0D0D0F',
            },
            danger: {
              50: '#ffe8ea',
              100: '#ffbcc0',
              200: '#ff9097',
              300: '#ff636d',
              400: '#FF4757',
              500: '#e83040',
              600: '#c41e2d',
              700: '#a01020',
              800: '#7a0815',
              900: '#54030d',
              DEFAULT: '#FF4757',
              foreground: '#F5F0EB',
            },
            // Dark-mode scale: 50 = darkest surface, ascending to 900 = light.
            // HeroUI flat inputs/chips use default-100 as their fill, so it MUST
            // be a subtle dark (was #e8e8ef, which rendered inputs as white boxes
            // on the dark modal). 200/300 give visible borders; 400+ for muted
            // text/icons.
            default: {
              50: '#16161A',
              100: '#24242C',
              200: '#2E2E38',
              300: '#3A3A44',
              400: '#58587a',
              500: '#7a7a98',
              600: '#a8a8c0',
              700: '#d0d0df',
              800: '#e8e8ef',
              900: '#f5f5f8',
              DEFAULT: '#24242C',
              foreground: '#F5F0EB',
            },
          },
        },
      },
    }),
  ],
};

export default config;
