// The shape vocabulary: one corner radius, scaled into the handful of related
// radii the views use — the counterpart to anim.js for motion.
//
// St CSS has no variables, so a radius that follows a setting cannot live in
// the stylesheet. Every rounded surface therefore takes its radius from here,
// as an inline style; the stylesheet keeps the same numbers as fallbacks for
// the instant before that is applied.
//
// The parts are offsets from the artwork's radius, in the proportions the
// stylesheet already used: the detail pane is the roundest thing on screen,
// badges the tightest. There are only as many as the eye can tell apart —
// posters and list rows both asked for a radius within two pixels of each
// other, so they share the artwork's and anything unnamed falls back to it.

const MAX = 40;
const DEFAULT_RADIUS = 18;

// The frame the pop-up panel keeps around the pane inside it, so the artwork
// reads as held by the folder's panel rather than running to its edge — the
// shell's own $base_padding (_common.scss). Logical pixels, and it goes into a
// CSS string, so it is never scaled here.
export const PANE_INSET = 6;

const PART = {
    art: r => r,
    hero: r => r + 4,
    pane: r => r + 12,
    // The pane when something else draws the frame around it: the outer curve
    // less the frame, which is what keeps the two concentric. Anything else
    // leaves the corner reading as either too tight or too slack against the
    // panel's own (detailDialog.js sets the pair).
    paneInner: r => Math.max(0, r + 12 - PANE_INSET),
    badge: r => Math.round(r / 2),
};

// The declarations are built once per radius rather than once per surface: a
// library grid asks for one per tile and they are all the same string, and an
// identical inline style is also what lets St share one theme node between them.
let styles = {};

// Called once per build from the `corner-radius` setting.
export function setCornerRadius(px) {
    const base = Math.max(0, Math.min(MAX, Math.round(px) || 0));
    styles = {};
    for (const [part, scale] of Object.entries(PART))
        styles[part] = `border-radius: ${Math.max(0, scale(base))}px;`;
}
setCornerRadius(DEFAULT_RADIUS);

// The declaration to hand St, ready to concatenate with another inline style.
export function radiusStyle(part = 'art') {
    return styles[part] ?? styles.art;
}
