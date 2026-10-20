# DESIGN.md — Salesforce Hub brand & UI reference

The single source of truth for how anything user-facing should look. **Read this before
building any new page, form, card or widget.** The implementation is
`public/css/style.css` (tokens at the top, components by section); this file states the
rules that are not visible in the CSS.

Ported from the DynamicsHub design system. The structure, component names and rules are
theirs; the palette is not, because a teal-and-navy Salesforce site reads as a Dynamics
site.

## Brand essence

- **Name:** Salesforce Hub. The wordmark is two words with a space, matching the logo —
  `Salesforce` in navy, `Hub` in the blue gradient (`.navbar-brand .cloud`), or
  `.brand-accent` on a dark ground where a gradient would disappear. It sits beside the
  S-cube mark on a white `.brand-tile`, in the header and the footer alike.
- **Personality:** professional, modern, calm. Premium glassmorphism — frosted white cards
  over soft navy/blue washes. No loud colour, no gimmicks.
- **Not affiliated with Salesforce, Inc.** The footer says so on every page. Never imply
  otherwise in copy, and never use Salesforce's own logo or Astro/Codey characters.

## Colour system (use the variables, never a raw hex)

| Token | Value | Use |
|---|---|---|
| `--primary-navy` | `#032D60` | Headings, dark surfaces, brand primary |
| `--primary-navy-light` / `-dark` | `#0B5CAB` / `#01203F` | Gradient stops |
| `--primary-blue` | `#0176D3` | **Link colour and primary CTA.** 4.63:1 on white |
| `--primary-blue-light` | `#00A1E0` | Accent and gradient stop only |
| `--primary-blue-bright` | `#6FD3FF` | Accent on dark grounds only |
| `--accent-gradient` | `#0176D3 → #0B5CAB` | `.btn-primary`, icon tiles, highlights |
| `--navy-gradient` / `--hero-gradient` | navy 135° gradients | `.page-header`, `.hero` |
| `--text-dark` / `--text-medium` / `--text-light` | `#16191D` / `#444C56` / `#5A6673` | Body tiers — all pass AA on white |
| `--text-muted` | `#8A94A0` | 3.08:1 — **large text and non-essential marks only** |
| `--grad-blue/navy/navyblue/violet/amber/success/info/rose` | sanctioned accents | **Only** for `.icon-tile` colour modifiers |

Rules:

- **`#00A1E0` must never sit behind white text.** It scores 2.93:1. Cyan is an accent, a
  gradient stop, and a ring colour — never a button fill. This is the one place this
  system deliberately diverges from the one it was ported from, whose primary button has
  the same defect.
- **Never introduce a foreign palette.** No Tailwind emerald, no Material purple, no
  Bootstrap-4 `#28a745`/`#17a2b8`/`#007bff`.
- Bootstrap's `--bs-primary` is remapped to `#0176D3` globally, so `.text-primary`,
  `.bg-primary` and `.badge.bg-primary` are on-brand and safe.
- Selected card state is **blue border + blue tint** (`.glass-card.is-selected`), never a
  navy wash.
- Links **darken** on hover (`--primary-blue-dark`). Never lighten — a lighter link on
  white loses contrast at the moment the user is aiming at it.
- Documents (SOW, WBS, deck) use `utils/documents/brand.js`, not this file. That is the
  *document* voice. The hexes are kept in step by hand; if you change one, change both.

## Typography

- **Inter** only, weights 400/500/600/700/800 — all five self-hosted from `/vendor/inter`
  and all five actually downloaded. A weight a stylesheet sets but the page never loads is
  a faux bold, which is what every h1 here was until it was checked in a real browser.
- Headings are navy, 700 (h1 is 800), `letter-spacing: -0.02em`.
- Desktop scale: h1 `clamp(2rem, 5vw, 3rem)`, h2 `clamp(1.75rem, 4vw, 2.5rem)`,
  h3 `clamp(1.5rem, 3vw, 1.875rem)`, h4 `1.5rem`, h5 `1.25rem`, h6 `1rem`.
- Mobile (≤767.98px) steps the scale down **in full** — h1 1.875rem through h6 0.875rem.
  If you override one heading level in a media query, override them all, or the hierarchy
  inverts at some width.
- No interactive text below 12px.

## Page anatomy

- **Landing pages** (home) open with the full `.hero`.
- **Every other page** opens with the `partials/page-header` band:
  ```ejs
  <%- include('../partials/page-header', {
        heading: 'Your jobs',                  // required
        sub: 'Publish, pause and close roles', // optional, escaped
        icon: 'bi-briefcase',                  // optional
        label: 'HIRING'                        // optional eyebrow, renders a .section-badge
      }) %>
  ```
  Nothing else goes in the header. A shared component that grows a slot for arbitrary
  markup stops being shared.
- Content sections use `.section-padding` inside a `.container`.
- Never greet someone with their raw email — `User.buildSessionUser` already falls back to
  the local part for the display name, and that is as far as it should ever go.

## Where the wash goes

Glass only reads as glass when there is colour behind it. A frosted card on a plain white
page is just a white card, and a permanent full-page wash greys the whole app.

So the body is a clean white base, and the wash is applied deliberately:

- `.glass-section` — the mesh behind a run of content. Every interior page wraps its
  container in one, sitting directly under the navy header band.
- `.glass-section-tall` — adds a full-viewport minimum height and vertical centring, for
  pages whose content does not fill the screen. The auth pages use it.
- `.hero` and `.page-header` carry their own navy gradient plus a mesh overlay.

**Anything that FLOATS over arbitrary page content is opaque, never glass.** A navbar
dropdown, the assistant panel, and anything else that opens on top of whatever happens to
be underneath it: the wash works because the thing behind it is a known background, and a
floating panel has no such thing. The menu dropdowns were `rgba(255,255,255,0.85)` with a
blur and the home hero's `h1` read straight through them, across the item labels. A blur
does not rescue it — the only background that works over every page is one that lets
nothing through. Separation comes from the border and the shadow instead.

Neither the header band nor the footer has an outside margin. The washed section supplies
the spacing, so the three meet without a white seam. If you add a page that ends in
something other than a `.glass-section`, give it bottom padding rather than putting the
margin back.

## Components (reuse, do not reinvent)

- **Cards:** `.glass-card` is the primary surface. Inside it, Bootstrap's
  `.card-header`/`.card-body`/`.card-footer` get real padding from this stylesheet —
  bare Bootstrap variables would collapse them to 0. Hover lift is **-4px**, and only on
  a card that is itself a link (`a.glass-card`) or one marked `.glass-card-hover`. A
  static panel that moves under the cursor suggests an affordance that is not there.
- **Panels:** `.glass-panel` for sidebars and filter rails.
- **Icon medallions:** `.icon-tile` (or `.icon-circle`) + optional size (`-sm`/`-lg`) +
  colour (`.icon-blue/.icon-navy/.icon-navyblue/.icon-violet/.icon-amber/.icon-success/
  .icon-info/.icon-rose`). The base class is required; modifiers are additive.
- **Buttons:** `.btn-primary` (the one CTA per section), `.btn-outline-primary`,
  `.btn-navy`, `.btn-outline-light` on dark. Buttons lift **-2px**.
- **Badges:** `.badge-hub` plus a tone (`.cloud/.ok/.warn/.danger/.muted`). Work modes use
  the `.job-badge` family. Pipeline stages use `.status-*` — and the stage name is always
  inside the pill, because colour is never the only signal.
- **Forms:** Bootstrap controls restyled globally (radius-xl, blue focus ring at 15%).
  Required marker is `<span class="text-danger">*</span>`; help text is `.form-text`.
- **Empty states:** `.empty-state` — one icon, one line, one action. Hide a section rather
  than showing a braggy zero.
- **Icons:** Bootstrap Icons (`bi-*`) only. No emoji as icons.

## Motion & feel

- **No full-screen page loaders.** Ever. They make a 25ms server feel slow.
- Scroll reveals use `.animate-on-scroll` (16px rise, 0.35s, once). The hidden start state
  is gated behind `.js-reveal`, which `views/partials/head.ejs` sets before first paint —
  so with scripting off the content is simply visible. **An animation must never be the
  reason someone cannot read the page.** Do not add a second reveal system.
- Above-the-fold content is revealed on load rather than waiting for a scroll that may
  never come.
- `prefers-reduced-motion` is handled globally. Do not bypass it with inline animation.

## Accessibility floor (non-negotiable)

- Body text ≥ 4.5:1. The text tokens are measured, not guessed — `--text-muted` is the
  only one below it and is for large text and decorative marks.
- Visible keyboard focus on everything interactive. The `:focus-visible` ring is global;
  never `outline: none` without an equal replacement.
- `<%= %>` for all dynamic text. `<%- %>` only for `sanitizeRichText()` output.
- Charts carry `role="img"` and an `aria-label` that says how missing data is drawn.
- `prefers-contrast: more` and `forced-colors: active` drop the blur for a solid surface —
  frosted glass over a busy background loses effective contrast.
- Media queries use Bootstrap's `.98` breakpoints (575.98 / 767.98 / 991.98), never
  integer max-widths.

## The suppressed-data pattern

Load-bearing rather than decorative. When the rate index cannot publish a figure it must
*look* different from a zero:

- The value is replaced by "Not published" in `.suppressed`.
- The contributor count is still shown, so the reader knows why.
- In a trend, a suppressed month is `.bar.gap` — a hatched, dashed, full-height placeholder.
  Never a short bar, never an interpolated point.

Anyone changing the chart must keep the gap visually distinct from a low value.

## Where styles live

- Shared styling → `public/css/style.css`.
- Page-specific tweaks may live in a small `<style>` block at the top of a view — but if a
  second page needs it, promote it.
- **Never use inline `style=""` for a brand colour or gradient.** There is a token or a
  class. The one exception is `views/email/`: email clients strip `<style>` and do not
  support custom properties, so those templates inline everything by necessity.

## New-feature checklist

1. Page header: `.hero` (landing) or `partials/page-header` (everything else).
2. Colours and type only via tokens and existing classes.
3. Empty and error states designed, not just the happy path.
4. Mobile pass at 375px — no horizontal overflow, hierarchy intact.
5. Focus visible on every new control.
6. Update this file and `CLAUDE.md` with anything durable.
