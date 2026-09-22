# One-shot showcase validation

Validated: 2026-09-22

## Frozen record

- Content and behavior contract SHA-256:
  `20BCAF28DD87A82BC9A5F5D01A2B0EB006C394060C9E26478C6DDF89D09CB202`
- Direction input SHA-256:
  `3D2AED7427783022B21423DBE7524C10375AD37B3AE036447B4D9A83528DB720`
- Deterministic replay SHA-256:
  `E008D391EA5224D9F09880C137B6F767EA12BFF1B809766980A7F63C5C547DE7`
- `painterly-evidence-dossier` was the only selected direction, with policy
  score `0.9149`.
- Both pages use local HTML, CSS, and JavaScript with no external runtime
  dependency.
- The routed page's transparent negative skull is derived from the committed
  JevRev banner. No new source image was introduced.

## Automated contract

`npm run demo:oneshot` passed and checked:

- every frozen copy string appears in both pages;
- required anchors and links exist;
- the direct page contains no image element;
- the routed page uses the recorded local skull asset;
- no external page assets are loaded;
- both pages define system color-scheme and reduced-motion behavior;
- both pages implement the command-copy action;
- neither page contains a visible em dash or en dash;
- deterministic Sift selects only `painterly-evidence-dossier`.

The generated campaign is written to the ignored
`benchmarks/results/one-shot-showcase/` directory.

## Browser inspection

Both pages were rendered in Chromium and inspected at:

- 1440 x 1000, light color scheme;
- 1440 x 1000, dark color scheme;
- 390 x 844, light color scheme;
- 390 x 844, dark color scheme;
- reduced-motion mode.

Observed results:

- no clipping or horizontal overflow at the tested widths;
- navigation remains one line at desktop width and reduces cleanly on mobile;
- the direct page preserves its light, centered, rounded hierarchy, omits
  imagery, and limits purple-black color to the ambient field;
- direct primary and copy controls measure 5.26:1 contrast in light mode and
  7.85:1 in dark mode;
- the routed skull shares the page background in both modes and retains its
  negative treatment in dark mode;
- a faint rust ambient source sits behind the skull's upper-right field without
  altering the transparent line art;
- red paint, graffiti overlays, and non-functional image labels are absent;
- `Sift`, `Probe`, and `Decide` states update the functional evidence panel;
- arrow keys move through the decision tabs;
- proposal and evidence lenses expose the ranking reversal in place;
- the evidence trail expands and its local links resolve;
- both `See the proof` links resolve to `#proof`;
- both copy controls reach `Copied` after activation;
- reduced motion exposes all content without transitions;
- fresh browser sessions report zero console errors and zero warnings.

Committed visual evidence:

- `.github/assets/one-shot-showcase/direct-hero.png`
- `.github/assets/one-shot-showcase/direct-structure.png`
- `.github/assets/one-shot-showcase/direct-mobile.png`
- `.github/assets/one-shot-showcase/routed-hero.png`
- `.github/assets/one-shot-showcase/routed-decision.png`
- `.github/assets/one-shot-showcase/routed-mobile.png`
- `.github/assets/one-shot-showcase/routed-workflow.png`

## Interaction and README verification

The final Chromium matrix covers both pages at 1440 x 1000, 390 x 844,
and 360 x 844, each in light and dark mode and with normal and reduced
motion: 24 combinations. All passed with no horizontal page overflow,
broken page images, console errors, or console warnings.

- The stage rail connects Sift, Probe, and Decide. The selected segment and
  S, P, or D mark identify the current state; the question and facts move as
  one short transition.
- Arrow keys, Home, and End select and focus the matching tab. Tab reaches
  the labelled panel, which has a visible focus outline.
- The evidence lens puts the passing state machine first in the DOM and on
  screen. Switching back restores proposal order. Repeated switching retains
  the correct candidate states, reading order, and control focus.
- A concise status region announces the result. The native source disclosure
  works with Enter and Space, and both source links return successfully.
- Copy controls write the exact install command. All anchor targets resolve.
- Reduced motion updates facts and ordering immediately. Enabling the setting
  while a transition is running also cancels motion.
- Direct action contrast remains 5.26:1 in light mode and 7.85:1 in dark mode.
  Routed action contrast is 6.48:1 and 4.68:1 respectively.

The workflow capture is an unmodified 1320 x 571 element screenshot from a
1440 x 1000 dark viewport with Probe selected. The evidence capture is a
1440 x 816 crop with the evidence winner first. Routed hero and mobile captures
were refreshed after the contrast correction. The original three direct
captures remain unchanged. Mobile captures remain available here but are not
displayed in README.

README was rendered locally using Marked 18.0.14 and github-markdown-css 5.9.0
at 1280 x 900 and 360 x 900, in both themes, with the disclosure closed and
expanded. These are GitHub-like canvases, not a published GitHub preview.
Content widths were 900 and 328 CSS pixels. The hero pair retained equal
widths and its native 1440:1000 aspect ratio. Every comparison image loaded
from its repository-relative path with specific alt text.

Two narrow-table defects were corrected in the first integration pass: the
six-row trace previously needed 346 pixels, and the four-column interaction
contract needed 413 pixels inside the 328-pixel content area. A later narrative
pass replaced the trace with four candidate-direction tradeoffs derived from
the committed Sift input and three rendered decision examples. The examples use
the existing direct structure, routed workflow, and routed decision captures in
an alternating single-column sequence, so desktop keeps image rhythm while the
328-pixel canvas retains readable line lengths. The remaining interaction table
fits without horizontal scrolling. Stable headings, source links, setup order,
selection facts, and the interpretation boundary remain intact.

The later pass was inspected again at 900 and 328 CSS pixels in GitHub-like
light and dark rendering. The expanded section had zero page overflow, both
remaining tables matched their client width, all five public comparison images
loaded, and the direct and routed hero captures retained equal dimensions.

The decision-gate SVG was XML-validated and inspected at its 680 x 490 native
size, on both README themes, and at 328 CSS pixels within the 360-pixel view.
Its text bounds remain inside the viewBox. It contains a specific title and
description, uses no external resources or scripts, and communicates rejection
and the winning route through text as well as color.

## Interpretation boundary

The comparison demonstrates a visible difference between two committed outputs
under the recorded setup. It is not evidence that JevRev universally improves
design quality, nor does it measure model quality, API cost, elapsed generation
time, conversion, business lift, or production reliability. The deterministic
replay proves repeatable routing behavior, not a live-provider result.
