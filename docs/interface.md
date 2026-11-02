# Interface, charts and offline

Three things the browser made us build differently: colour that is measured
rather than asserted, charts drawn by hand, and an app that installs and keeps
working with no network.

## Contrast is enforced, not asserted

The accent colours are not `orange` and `teal`. Stock palettes are tuned to look
right, not to pass a threshold, and measured against a white card the usual ones
land between **2.20:1 and 4.13:1** — every one of them below the 4.5:1 that WCAG
2.2 AA requires for text, and three below even the 3:1 that applies to chart
marks. So the lines and bars were unreadable, not just the labels.

`src/domain/accessiblePalette.ts` replaces them with values that clear the bar on
all three surfaces a colour can land on: the card, the page behind it, and its
own 15% tint wash. Colours are stored as **numeric components rather than CSS
strings**, for one reason — a string cannot be measured. `contrast.ts` recomputes
every ratio from those components on each CI run, against both the 4.5 standard
and the palette's own 4.7 margin, so a palette edit that breaks the promise fails
the build.

The wash is the trap worth knowing about. It is mixed from *the colour being
chosen*, so darkening the ink darkens its own background and the pair moves
together — it is the binding constraint every time, and the measured worst case
in the whole palette is **4.80:1**. Score a candidate against a wash mixed from
the stock colour instead and it reads 0.4 higher than what the app renders. That
mistake shipped once upstream and only CI caught it; two tests now pin the
recursion so a re-derivation cannot quietly optimise the looser problem.

## Charts, and why they are hand-drawn

Six charts, in plain SVG, for **2.5 KB gzipped**. A charting library would have
been roughly forty times that — about double the whole bundle — for six simple
series, on an app meant to work offline on a phone.

The other reason is the accessibility tree. The iOS app pairs each chart with an
**audio graph**: VoiceOver plays the shape of a series as sound. The web has no
equivalent, so that has to be made up elsewhere, and owning the markup is what
makes it possible:

- the drawing is one `role="img"` labelled with a **spoken summary** — how many
  points, the range, the average, the latest value, and the direction — so the
  gist arrives in one sentence instead of after walking every mark;
- the SVG itself is `aria-hidden`, because dozens of unlabelled `path` and
  `circle` nodes are an obstacle, not information;
- beside it sits a real `<table>` of every point, behind a "Show the numbers"
  disclosure. A table announces its own row and column headers and can be read
  in any order, which a bag of labelled SVG marks cannot.

Three drawing decisions are about honesty rather than looks. **Lines are
straight**, not splined — a smooth curve invents values between marks that were
never measured. **Bars start at zero**, because a bar's length is read as a
quantity and a truncated one lies about proportion. **The weekday price plot
uses dots on a zoomed axis**, because gas is never $0: a zero-based bar chart
would bury the cent-level differences that are the entire point, while a
truncated bar would exaggerate them. A dot makes no claim about proportion, so
the axis is free to start where the data does.

And the economy chart is **converted, not relabelled**. L/100km is the
reciprocal of MPG, so the same car's curve genuinely inverts: 35 → 45 MPG
"trending up" is 6.7 → 5.2 L/100km "trending down". Swapping the axis label over
the same points would draw the opposite of the truth.

## Installing it, and using it offline

It is a progressive web app: install it from your browser's menu and it gets a
home-screen icon and its own window, with no app store in between. Once
installed it works with **no network at all** — the shell is precached and the
data was never on a server to begin with. Verified rather than assumed: with the
network cut, the app loads, shows your history, and logs a new fill-up.

Updates **ask before they apply**. The conventional setting activates a new
version and reloads the moment one arrives, which would discard a fill-up
someone was halfway through typing — and since this app holds the only copy of
their data, that is a bad trade for saving them a click.
