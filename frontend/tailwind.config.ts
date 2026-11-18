import type { Config } from 'tailwindcss';

/**
 * Every value here resolves to a `--we-*` token from app/tokens.css. Nothing in this
 * file holds a literal colour or size — see docs/DESIGN-SYSTEM.md.
 *
 * The legacy shadcn-style names (card, muted, primary, destructive, input, ring) are
 * kept as aliases onto the right tokens so the pages written against them inherit the
 * design system without being rewritten. New code should prefer the token names:
 * `bg-surface` over `bg-card`, `text-secondary` over `text-muted-foreground`.
 *
 * Slash opacity (`bg-primary/10`) does not work on these colours, because the tokens
 * hold hex values rather than channel triples. Every tint the product needs already has
 * a token of its own — `accent-soft`, `surface-muted`, `error-soft`.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ---- Tokens -------------------------------------------------------
        'brand-logo': 'var(--we-brand-logo)',

        primary: {
          DEFAULT: 'var(--we-primary)',
          hover: 'var(--we-primary-hover)',
          'hover-soft': 'var(--we-primary-hover-soft)',
          active: 'var(--we-primary-active)',
          foreground: 'var(--we-on-primary)',
          nav: 'var(--we-primary-nav)',
          'nav-muted': 'var(--we-primary-nav-muted)',
        },
        accent: {
          DEFAULT: 'var(--we-accent)',
          hover: 'var(--we-accent-hover)',
          soft: 'var(--we-accent-soft)',
          strong: 'var(--we-accent-strong)',
          foreground: 'var(--we-on-accent)',
        },
        'on-accent': 'var(--we-on-accent)',

        background: 'var(--we-background)',
        surface: {
          DEFAULT: 'var(--we-surface)',
          muted: 'var(--we-surface-muted)',
        },

        border: {
          DEFAULT: 'var(--we-border)',
          strong: 'var(--we-border-strong)',
          input: 'var(--we-border-input)',
        },

        foreground: 'var(--we-text-primary)',
        body: 'var(--we-text-body)',
        secondary: 'var(--we-text-secondary)',
        link: 'var(--we-link)',
        focus: {
          DEFAULT: 'var(--we-focus)',
          'on-primary': 'var(--we-focus-on-primary)',
        },

        success: {
          DEFAULT: 'var(--we-success)',
          soft: 'var(--we-success-soft)',
          text: 'var(--we-success-text)',
        },
        info: {
          DEFAULT: 'var(--we-info)',
          soft: 'var(--we-info-soft)',
          text: 'var(--we-info-text)',
        },
        warning: {
          DEFAULT: 'var(--we-warning)',
          soft: 'var(--we-warning-soft)',
          text: 'var(--we-warning-text)',
        },
        error: {
          DEFAULT: 'var(--we-error)',
          soft: 'var(--we-error-soft)',
          text: 'var(--we-error-text)',
        },
        ai: {
          DEFAULT: 'var(--we-ai)',
          soft: 'var(--we-ai-soft)',
          text: 'var(--we-ai-text)',
        },
        rating: 'var(--we-rating)',

        chart: {
          1: 'var(--we-chart-1)',
          2: 'var(--we-chart-2)',
          3: 'var(--we-chart-3)',
          other: 'var(--we-chart-other)',
        },

        // ---- Legacy aliases ------------------------------------------------
        card: { DEFAULT: 'var(--we-surface)', foreground: 'var(--we-text-primary)' },
        muted: { DEFAULT: 'var(--we-surface-muted)', foreground: 'var(--we-text-secondary)' },
        input: 'var(--we-border-input)',
        ring: 'var(--we-focus)',
        destructive: { DEFAULT: 'var(--we-error)', foreground: 'var(--we-on-primary)' },
      },

      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        xs: ['var(--we-font-size-xs)', { lineHeight: 'var(--we-line-height-base)' }],
        sm: ['var(--we-font-size-sm)', { lineHeight: 'var(--we-line-height-base)' }],
        base: ['var(--we-font-size-base)', { lineHeight: 'var(--we-line-height-base)' }],
        md: ['var(--we-font-size-md)', { lineHeight: 'var(--we-line-height-tight)' }],
        lg: ['var(--we-font-size-lg)', { lineHeight: 'var(--we-line-height-tight)' }],
        xl: ['var(--we-font-size-xl)', { lineHeight: 'var(--we-line-height-tight)' }],
      },
      fontWeight: {
        normal: 'var(--we-font-weight-regular)',
        medium: 'var(--we-font-weight-medium)',
        semibold: 'var(--we-font-weight-semibold)',
      },

      spacing: {
        1: 'var(--we-space-1)',
        2: 'var(--we-space-2)',
        3: 'var(--we-space-3)',
        4: 'var(--we-space-4)',
        5: 'var(--we-space-5)',
        6: 'var(--we-space-6)',
        8: 'var(--we-space-8)',
        12: 'var(--we-space-12)',
        control: 'var(--we-size-control)',
        'control-sm': 'var(--we-size-control-sm)',
        'nav-item': 'var(--we-size-nav-item)',
        icon: 'var(--we-size-icon)',
        sidebar: 'var(--we-size-sidebar)',
        topbar: 'var(--we-size-topbar)',
      },

      borderRadius: {
        sm: 'var(--we-radius-sm)',
        md: 'var(--we-radius-md)',
        lg: 'var(--we-radius-lg)',
        xl: 'var(--we-radius-xl)',
        full: 'var(--we-radius-full)',
      },
      boxShadow: {
        sm: 'var(--we-shadow-sm)',
        DEFAULT: 'var(--we-shadow-sm)',
        md: 'var(--we-shadow-md)',
        lg: 'var(--we-shadow-lg)',
      },
      maxWidth: {
        page: 'var(--we-size-page)',
        'page-narrow': 'var(--we-size-page-narrow)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--we-motion-ease)',
        we: 'var(--we-motion-ease)',
      },
      transitionDuration: {
        DEFAULT: 'var(--we-motion-fast)',
        fast: 'var(--we-motion-fast)',
        drawer: 'var(--we-motion-drawer)',
      },
      // 960px is where the sidebar becomes a drawer.
      screens: {
        shell: '960px',
      },
    },
  },
  plugins: [],
};

export default config;
