# Design system

The visual layer is a small set of tokens in `public/css/style.css` plus Bootstrap 5 for
grid and form primitives. Everything below is the contract.

## Tokens

No colour literal appears outside the `:root` block. A rebrand is one edit.

| Token | Value | Use |
|---|---|---|
| `--sf-navy` | `#032d60` | headers, footer, headings on dark |
| `--sf-blue` | `#0b5cab` | primary actions, links |
| `--sf-cyan` | `#00a1e0` | accent, focus ring, gradients |
| `--sf-coral` | `#ff5d2d` | notification count only |
| `--ink-900 … --ink-100` | greys | text, borders, fills |
| `--ground` / `--paper` | `#f6f8fa` / `#fff` | page and card surfaces |
| `--ok` / `--warn` / `--danger` | semantic | status, never decoration |

Radius: `10px` for controls, `16px` for cards. Two shadow levels, no more.

## Typography

Inter, with a system fallback stack that is a real stack rather than a single family.
Headings are 650 weight with `-0.015em` tracking. Body is 15px/1.55 — a job description is
read, not skimmed.

## Page anatomy

1. Sticky navigation.
2. A `.page-header` gradient band carrying the `<h1>` and one sentence of orientation.
3. Content: a `.filter-panel` sidebar for browsable things, cards for lists.
4. Footer.

Cards are `.card-hub`. They lift by 1px on hover only when the whole card is a link.

## Status colour

Pipeline stages have their own pills (`.status-submitted` … `.status-withdrawn`). Colour is
never the only signal — the stage name is always in the pill.

## The suppressed-data pattern

This one is load-bearing rather than decorative. When the rate index cannot publish a
figure it must **look** different from a zero:

- The value is replaced by "Not published" in `.suppressed` (grey, italic).
- The contributor count is still shown, so the reader knows why.
- In a trend, a suppressed month renders as `.bar.gap` — a hatched placeholder at full
  height. It is never a short bar and never an interpolated point.

Anyone changing the chart must keep the gap visually distinct from a low value.

## Accessibility floor

- `:focus-visible` is a 3px cyan outline. Removing the outline is never the fix for how it
  looks.
- A skip link is the first focusable element on every page.
- Every input has a real `<label>`; placeholders are examples, never labels.
- Icons that carry meaning are paired with text. Decorative icons get `alt=""`.
- Charts carry a `role="img"` and an `aria-label` describing what they show, including how
  suppression is drawn.
- `prefers-reduced-motion` disables every transition.

## Responsiveness

Mobile-first. The filter sidebar stops being sticky below `768px` and moves above the
results. Tables live in `.table-responsive`. The page body never scrolls horizontally.

## Writing

- Sentence case everywhere, including buttons.
- Buttons name the action: "Send application", not "Submit".
- Errors say what to do next, not just what went wrong.
- Never claim scale we cannot verify. "23 contributors" is better than "thousands of
  data points".
