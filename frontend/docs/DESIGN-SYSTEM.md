# WorkEasy360 design system — Helpdesk

All WorkEasy360 products share one design system: CRM, HRMS, Helpdesk, AI Agent Platform,
AI Form Builder and Commerce. Each product has its own navigation and screens, but they all
use the same colours, type, spacing, components and interaction rules.

This file is the Helpdesk copy. The shared sections are identical in every product; the
sections marked **Per product** are filled in for Helpdesk.

## The code behind it

Helpdesk is a single Next.js app, not a monorepo, so the design system lives inside
`frontend/` rather than in a `packages/ui` folder. The files map one to one onto the shared
package:

| File | Shared package equivalent | What it holds |
|---|---|---|
| `app/tokens.css` | `src/tokens.ts` | Every colour, size, radius, shadow and motion value, as `--we-*` CSS custom properties, light and dark |
| `app/components.css` | `src/admin-css.ts` | The `c-*` component classes. They read only tokens |
| `lib/design/tokens.ts` | `src/tokens.ts` (JS half) | The token *names* for code that needs a token in JS (chart series, status tones). No values — `app/tokens.css` is the only place values live |
| `components/brand/logo.tsx` | `src/components/logo.tsx` | `BrandMark`, `BrandLockup`, `BRAND_NAME` and `PRODUCT_NAME` |
| `components/ui/page.tsx` | `src/components/page.tsx` | `Page`, `PageHeader`, `StatCard`, `EmptyState` |
| `components/ui/` (rest) | `src/components/` (rest) | Button, badge, card, input, table, tabs, dialog, states, pagination |
| `components/layout/` | — | The shell: sidebar, top bar, workspace switcher, module search, theme toggle |
| `components/assistant/assistant-avatar.tsx` | `src/components/` (agent avatar) | The assistant's robot face, drawn from tokens so it also works on a customer-branded help centre |
| `lib/modules.tsx` | the product's own module list | Every module and page, declared once |
| `public/brand/logo.jpg` | `assets/logo.jpg` | The original logo artwork |
| `public/brand/logo.svg` | `assets/` | The traced vector as a standalone file, for anywhere that needs a URL rather than a component |
| `app/icon.svg`, `app/apple-icon.png` | `assets/` | The favicons, drawn from the same traced path as `BrandMark`. Next.js accepts SVG for `icon` but only PNG or JPG for `apple-icon` |

`tailwind.config.ts` is the bridge: every Tailwind colour name resolves to a `--we-*` token,
so `bg-surface`, `text-body` and `border-border` are all token reads. The legacy names the
app already used (`card`, `muted`, `primary`, `destructive`, `input`, `ring`) are kept as
aliases onto the right tokens, so existing pages inherit the system without being rewritten.

**Rule:** never hardcode a colour, size or radius in a page. If a token is missing, add it to
`app/tokens.css` and expose it in `tailwind.config.ts`.

Tailwind's slash-opacity syntax (`bg-primary/10`) is not available on these colours, because
the tokens hold hex values rather than channel triples. That is deliberate: every tint the
app needs already has a token (`--we-accent-soft`, `--we-surface-muted`, `--we-error-soft`),
and naming the intent beats improvising an alpha.

## Name and logo

- **Per product:** `PRODUCT_NAME` is `'Helpdesk'` and `BRAND_NAME` is `'Workeasy'`, both in
  `components/brand/logo.tsx`. The lockup shows "Workeasy" with "Helpdesk" beneath it. These
  two constants are the only place the product's visible name is written — change them and
  the sidebar, the sign-in screen, the page titles and the help-center footer all follow.
- `BrandMark` and the `icon.svg` favicons draw a vector traced from
  `public/brand/logo.jpg`, the original artwork. The logo is a single flat colour, so the
  trace is exact to within 0.4% of pixels; it is one even-odd path, which is what keeps
  the counters inside the ring open.
- The mark is always the logo green `#00BF62` (`--we-brand-logo`). **Use that green for
  the mark and the favicons only, never for UI** — the interface greens are
  `--we-accent` and `--we-accent-strong`. If the artwork ever changes, replace
  `public/brand/logo.jpg` and re-trace it into `BrandMark`, `public/brand/logo.svg` and
  the two favicons — those four are the only places the path lives.
- **Never write a `--we-*` token name inside an SVG comment.** A pair of hyphens is
  illegal in an XML comment, so the file stops being well-formed XML; the browser then
  drops it silently and falls back to its own default tab icon. Nothing errors, the file
  still serves with a 200 and `image/svg+xml`, and the only symptom is a tab that never
  updates. `python -c "import xml.etree.ElementTree as ET; ET.parse('app/icon.svg')"`
  catches it in a second.
- Existing technical identifiers are deliberately unchanged: the `@digisoft/shared` package,
  the `digisoft-theme` storage key, the `digisoft360-helpdesk-frontend` package name, the
  `/api/v1` routes and every database mark stay as they are, so nothing that already exists
  breaks.

## Colour

Aim for roughly **70% white and neutral surfaces, 20% navy structure and 10% green accents**.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--we-primary` | `#1B3040` navy | `#27455A` | Navigation, headings, high-emphasis structure (bulk bar, hero, badges) |
| `--we-primary-hover` | `#112532` | `#315770` | Hover on navy fills |
| `--we-accent` | `#4ADE80` green | `#4ADE80` | Primary buttons, active indicators, progress, "done" ticks |
| `--we-accent-hover` | `#22C55E` | `#22C55E` | Hover on green fills |
| `--we-on-accent` | `#1B3040` | `#112532` | Text on green (7.8:1). White on green fails contrast |
| `--we-accent-soft` / `--we-accent-strong` | `#DCFCE7` / `#166534` | `#13341F` / `#6EE7A7` | Pale green background / green text |
| `--we-accent-ring` | 52% accent over the surface | same | The halo around the assistant launcher. Translucent, so it composites correctly in dark mode and on a customer's own accent |
| `--we-background` | `#F8FAFC` | `#0B1620` | Application canvas, table headers |
| `--we-surface` | `#FFFFFF` | `#112532` | Cards, top bar, inputs, menus, dialogs |
| `--we-surface-muted` | `#F1F5F9` | `#16303F` | Hover, selected rows, tags, segmented tracks |
| `--we-border` / `--we-border-strong` | `#E2E8F0` / `#CBD5E1` | `#27455A` / `#36576E` | Card and table lines / button outlines and dashed edges |
| `--we-border-input` | `#7D8BA0` | `#5A7A91` | Text field outlines: at least 3:1 against every surface they sit on (WCAG 1.4.11) |
| `--we-text-primary` | `#1B3040` | `#F1F5F9` | Headings, titles, values |
| `--we-text-body` | `#334155` | `#CBD5E1` | Body text |
| `--we-text-secondary` | `#64748B` | `#94A3B8` | Hints, labels, metadata |
| `--we-link` | `#166534` | `#4ADE80` | Text links, always underlined |
| `--we-focus` | `#1B3040` | `#4ADE80` | Focus rings. Green on navy surfaces (sidebar, bulk bar) |

**Never use brand green for small text on white** (1.9:1). For green text, use
`--we-accent-strong` or `--we-success-text`. Secondary text passes AA on white and on the
canvas, but not on `--we-surface-muted` (4.3:1), so don't put it there.

### Status colours

Each status has three steps:
- **base**, for icons, dots and borders
- **`-soft`**, a pale background
- **`-text`**, a dark foreground that passes AA on the soft background (6.4–7.6:1)

Badges and alerts always pair the colour with a label and a dot, so status never depends on
colour alone.

| Status | Base | Soft | Text |
|---|---|---|---|
| success | `#16A34A` | `#DCFCE7` | `#166534` |
| info | `#2563EB` | `#DBEAFE` | `#1E40AF` |
| warning | `#D97706` | `#FEF3C7` | `#92400E` |
| error | `#DC2626` | `#FEE2E2` | `#991B1B` |
| ai | `#7C3AED` | `#EDE9FE` | `#5B21B6` |

In dark mode the three steps invert: the base lightens to clear 3:1 on `--we-surface`, soft
becomes a dark tint of the hue and text becomes the light step (8.1–9.7:1 on its soft).

`--we-rating` (`#B45309`) is for star ratings and CSAT scores only.

Two more tokens sit outside the light/dark split on purpose: `--we-on-color-dark`
(`#1B3040`) and `--we-on-color-light` (`#F8FAFC`). They are the two candidates for text on
a colour a *customer* chose — see **Customer-facing pages** — and which one applies depends
on that colour's luminance, not on the theme, so neither is redefined in dark mode.

**Helpdesk tones.** The ticket tones map onto the statuses: an open ticket is `info`, a
resolved or closed one `success`, a breached SLA `error`, an SLA due within the hour
`warning`, and anything the assistant produced — a summary, a sentiment score, a drafted
reply — `ai`. Statuses, priorities and tags that the organization configures itself carry
their own stored colour; those render through `c-badge` with an inline colour rather than a
tone, so a custom workflow needs no code change.

### Charts

- Charts sit on white surfaces with `--we-border` grid lines and secondary-text axes.
- Series take `--we-chart-1…3` in a fixed order:

  | Mode | Navy-blue | Green | Violet |
  |---|---|---|---|
  | Light | `#235E9C` | `#16A34A` | `#8B5CF6` |
  | Dark | `#5A93D8` | `#1FAF55` | `#9F7AEA` |

- Both sets pass the dataviz palette validator: lightness band, chroma, colour-blind and
  normal-vision separation, and 3:1 contrast. Brand navy is too grey to separate as a series,
  so series 1 is a more saturated navy-blue.
- Green and amber are hard to tell apart for colour-blind users, so amber is kept for ratings
  and is not a series colour.
- A fourth series folds into "Other" — and takes a fourth marker shape, so it is still
  told apart from the first.
- Text in charts uses text tokens, never the series colour.
- **Per product:** the ticket-volume trend is created → series 1, resolved → series 2,
  reopened → series 3. Every series also carries a label in the legend, and each line a
  distinct marker shape, so the chart reads without colour.

### Dark mode

Dark mode follows the operating system until someone chooses with the theme toggle. The
choice is saved per browser (`digisoft-theme`) and applied before first paint by the inline
script in `components/theme-provider.tsx`. Dark values are their own steps, not an automatic
inversion.

## Type, spacing and shape

- **Font:** Inter, self-hosted by `next/font`. Numbers in tables, stats and charts use
  tabular numerals (`.c-num`, or `tabular-nums`).
- **Type scale** (`--we-font-size-*`): page heading 24/600 (`xl`), section heading 18/600
  (`lg`), component heading 16/600 (`md`), body 14/400 (`base`), secondary 13 (`sm`),
  metadata 12 (`xs`). Weights are 400, 500 and 600 only.
- **Spacing:** a 4px grid (`--we-space-1…12`: 4, 8, 12, 16, 20, 24, 32, 48).
- **Radii:**
  - `--we-radius-sm` 6px: tags and small chips
  - `--we-radius-md` 8px: inputs, buttons, menu items
  - `--we-radius-lg` 12px: cards, tables, popovers
  - `--we-radius-xl` 16px: dialogs
- **Shadows:** `--we-shadow-sm` for cards and `--we-shadow-md` for tooltips, both nearly
  flat. `--we-shadow-lg` is for floating layers only (menus, dialogs, the mobile drawer).
- **Sizes:**
  - sidebar 248px (`--we-size-sidebar`)
  - top bar 56px
  - controls 36px (small 30px)
  - nav items 36px
  - icons 18px
- **Motion:** 150ms for hover and focus changes, 200ms for the drawer, both using
  `--we-motion-ease`. Transitions and animations are removed under `prefers-reduced-motion`.

## Components

| Component | Classes | Notes |
|---|---|---|
| Buttons | `c-btn` (secondary), `c-btn-primary` (green), `c-btn-dark` (navy), `c-btn-danger`, `c-btn-ghost`, `c-btn-sm`, `c-btn-icon` | One primary button per view. Disabled at 50% |
| Inputs | `c-input`, `c-select`, `c-textarea`, `c-input-group`, `c-tags`, `c-search` | Navy focus border plus ring; `aria-invalid` turns them red |
| Choices | `c-check-input`, `c-radio-card`, `c-segmented`, `c-range` | |
| Navigation | `c-nav`, `c-tabs`, `c-back`, `c-pager` | Active means navy text plus a green indicator |
| Content | `c-card`, `c-stat`, `c-table`, `c-kv`, `c-checklist`, `c-feature-list` | `c-card-header` stacks title over description; a header that also carries an action adds `flex-row justify-between`. Tables opt into stacking on phones with `c-table-stack` plus a `data-label` per cell |
| Status | `c-badge[data-tone]`, `c-alert[data-tone]`, `c-progress`, `c-skeleton`, `c-empty` | Tones: success, warning, danger, info, brand, ai |
| Floating | `c-menu`, `c-listbox`, `c-dialog`, `c-drawer`, `c-chart-tip`, `c-fab`, `c-chatbox` | `c-fab` is the AI assistant launcher, fixed to the bottom-right corner: a navy disc in an accent halo (`--we-accent-ring`), 56px (`--we-size-fab`), scaling its own glyph. `c-chatbox` is its chat window (full screen on phones). See [backend/docs/AI-ASSISTANT.md](../../backend/docs/AI-ASSISTANT.md) |
| Charts | `c-chart`, `c-barlist`, `c-funnel` | |

The React components in `components/ui/` are thin wrappers over these classes. A page should
reach for `<Button>`, `<Card>` or `<DataTable>` rather than writing `c-btn` by hand; the
classes exist for the places that are not components yet, and for the help center, which is
rendered from the organization's own settings.

## Application shell

Every product uses this shell; only the navigation items differ.

- **Sidebar** (navy, 248px): product lockup, then the navigation in groups. The active item
  has a lighter fill, a green bar and a green icon. On screens narrower than 960px the
  sidebar becomes a drawer. Focus rings inside it are green, since it is a navy surface.
- **Top bar** (white, 56px):
  - Left: the workspace switcher and search. Search jumps to any module or page the role can
    open; press `/` or Ctrl+K to focus it.
  - Right: product actions, notifications, settings, the theme toggle and the account menu.
- **Notifications** list what needs attention, using the counts the module pages already
  show. Each role sees only what it can act on.

## The page contract

Every page has the same skeleton, built from `components/ui/page.tsx`:

1. `<Page>`: centred container, 1200px wide. A `narrow` page keeps the same left edge and
   caps its content at 880px.
2. `<PageHeader eyebrow title subtitle actions>`. The primary action sits at the right edge.
3. An optional `.c-toolbar` (search, filters) or `.c-tabs`.
4. Content: `<Card>`, `.c-stats` with `<StatCard>`, `.c-table-wrap` tables, `.c-form` forms.
5. Before there is data: `<EmptyState icon title actions>`.

**Inside the application shell, `<main>` is step 1.** `app/(app)/layout.tsx` puts `.c-page`
on `<main>` itself, so a module page starts straight in at its `<PageHeader>` and gets the
container, the padding and the 16px gap between sections for free. `<Page>` is the component
for the screens outside that shell — the help center, the sign-in screens and the error
pages — and for anywhere that wants the `narrow` cap.

One screen opts out: the agent workspace at `/tickets/[id]` fills the viewport and manages
its own scrolling, so the layout gives it a plain flex column instead of the container. That
is a list in `isFullBleed()`, not a negative-margin hack in the page.

The product's modules are declared once, in `lib/modules.tsx`, with each module's label,
path, group, icon, permission, summary, primary action and feature list. The sidebar, the
search and the module pages all read from that list, so a module's name or icon can't drift
between places.

The sidebar shows only the modules the user's role can open. The API enforces the same
permissions on every request — `lib/modules.tsx` is presentation, never authorisation.

## Per product

- **Product name:** `Helpdesk` (`PRODUCT_NAME` in `components/brand/logo.tsx`).

- **Workspace:** an organization. The top-bar switcher shows the signed-in agent's
  organization; Helpdesk is single-organization per session, so the switcher is a label with
  a link to Settings → Organization rather than a menu.

- **Modules and sidebar groups**, in order:

  | Group | Modules | Permission |
  |---|---|---|
  | Work | Dashboard | — |
  | | Tickets | `ticket.read` |
  | | Live chat | `chat.handle` |
  | | Activities | `activity.read` |
  | Customers | Customers | `contact.read` |
  | | Accounts | `account.read` |
  | Self-service | Knowledge base | `kb.read` |
  | | Community | `community.moderate` |
  | Operations | Automation | `operations.read` |
  | | Reports | `report.read` |

  **Settings** (`organization.read`) is pinned to the bottom of the sidebar, below a rule.

- **Top-bar product actions:** "View help center", which opens the organization's own help
  center at `/help/{slug}` in a new tab. Shown when the role has `portal.read`.

- **Notifications:** ticket assigned to you, a reply from a customer on a ticket you own, an
  SLA breach or an escalation on a ticket in your queue, a new live chat waiting, and a
  community post awaiting moderation. Agents see their own tickets and their departments'
  queues; the unassigned and SLA counts need `ticket.read.all`; moderation notices need
  `community.moderate`.

- **Customer-facing pages:** yes — the help center at `/help/[slug]`, which covers the
  knowledge base, the community, request submission, "my requests" and the one-time CSAT
  survey link. **It wears the organization's brand, not Workeasy's.** `PortalShell` remaps
  `--we-accent`, `--we-primary`, `--we-link` and `--we-focus` to the organization's stored
  `primaryColor`, and keeps every neutral token and every `c-*` primitive. `--we-on-accent`
  is recomputed from the chosen colour's luminance so the text on a merchant's accent still
  clears 4.5:1, whatever colour they pick. The only Workeasy mark on those pages is the
  "powered by" line in the footer, and an organization can replace that with its own
  `footerText`.
