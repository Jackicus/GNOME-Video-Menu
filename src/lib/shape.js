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
// badges the tightest.

const MIN = 0;
const MAX = 40;
export const DEFAULT_RADIUS = 18;

const PART = {
    art: r => r,
    tile: r => r + 2,
    hero: r => r + 4,
    thumb: r => r - 2,
    pane: r => r + 12,
    row: r => r,
    badge: r => Math.round(r / 2),
};

let base = DEFAULT_RADIUS;

// Called once per build from the `corner-radius` setting.
export function setCornerRadius(px) {
    base = Math.max(MIN, Math.min(MAX, Math.round(px) || 0));
}

export function cornerRadius(part = 'art') {
    return Math.max(0, (PART[part] ?? PART.art)(base));
}

// The declaration to hand St, ready to concatenate with another inline style.
export function radiusStyle(part = 'art') {
    return `border-radius: ${cornerRadius(part)}px;`;
}
