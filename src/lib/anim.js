// Motion vocabulary borrowed from GNOME Shell itself.
//
// The shell animates almost everything with ease-out-quad over 250ms (overview,
// workspace switch, app grid pages) and pops windows in with ease-out-expo over
// 150ms from 94% scale. Using the same handful of curves and durations is what
// makes the extension feel native rather than "animated".
//
// actor.ease() is the shell's own helper: it honours the "enable animations"
// setting and the slow-down factor, so nothing here needs to check them.

import Clutter from 'gi://Clutter';

export const Duration = {
    FAST: 120,     // hover, pressed state, things leaving
    NORMAL: 200,   // page change, things arriving
    SLOW: 260,     // hero flight between views
};

export const Ease = {
    OUT: Clutter.AnimationMode.EASE_OUT_QUAD,
    OUT_CUBIC: Clutter.AnimationMode.EASE_OUT_CUBIC,
    OUT_EXPO: Clutter.AnimationMode.EASE_OUT_EXPO,
    IN: Clutter.AnimationMode.EASE_IN_QUAD,
    IN_OUT: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
};

// The scale the shell shrinks a window to while it fades in or out.
export const POP_SCALE = 0.94;

// Fade and scale an actor in around its centre, like a window opening.
export function popIn(actor, {delay = 0, duration = Duration.NORMAL, fromScale = POP_SCALE, fromY = 0, onComplete} = {}) {
    actor.remove_all_transitions();
    actor.set_pivot_point(0.5, 0.5);
    actor.set_scale(fromScale, fromScale);
    actor.translation_y = fromY;
    actor.opacity = 0;
    actor.show();
    actor.ease({
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
        translation_y: 0,
        delay,
        duration,
        mode: Ease.OUT_EXPO,
        onComplete,
    });
}

// Fade and shrink an actor out, then hide it and restore its transform so it
// is ready to be shown again untouched.
export function popOut(actor, {duration = Duration.FAST, toScale = POP_SCALE, toY = 0, onComplete} = {}) {
    actor.remove_all_transitions();
    actor.set_pivot_point(0.5, 0.5);
    actor.ease({
        opacity: 0,
        scale_x: toScale,
        scale_y: toScale,
        translation_y: toY,
        duration,
        mode: Ease.OUT,
        onComplete: () => {
            actor.hide();
            actor.set_scale(1, 1);
            actor.translation_y = 0;
            actor.opacity = 255;
            onComplete?.();
        },
    });
}

// Reveal a list of actors one after another, the way the app grid settles.
// The stagger is capped so a long list never feels slow; later items simply
// arrive together.
export function staggerIn(actors, {step = 12, cap = 150, fromY = 10, duration = Duration.NORMAL, start = 0} = {}) {
    actors.forEach((actor, i) => {
        actor.remove_all_transitions();
        actor.opacity = 0;
        actor.translation_y = fromY;
        actor.ease({
            opacity: 255,
            translation_y: 0,
            delay: start + Math.min(i * step, cap),
            duration,
            mode: Ease.OUT,
        });
    });
}

// Slide one actor out and another in along x, like switching app grid pages.
// direction is +1 (moving right) or -1 (moving left).
export function slideSwap(outgoing, incoming, direction, {distance = 32, onComplete} = {}) {
    if (outgoing) {
        outgoing.remove_all_transitions();
        outgoing.ease({
            opacity: 0,
            translation_x: -direction * distance,
            duration: Duration.FAST,
            mode: Ease.OUT,
            onComplete: () => {
                outgoing.hide();
                outgoing.translation_x = 0;
                outgoing.opacity = 255;
            },
        });
    }
    incoming.remove_all_transitions();
    incoming.translation_x = direction * distance;
    incoming.opacity = 0;
    incoming.show();
    incoming.ease({
        opacity: 255,
        translation_x: 0,
        duration: Duration.NORMAL,
        mode: Ease.OUT,
        onComplete,
    });
}

export function fadeTo(actor, opacity, {duration = Duration.NORMAL, delay = 0, onComplete} = {}) {
    actor.remove_all_transitions();
    if (opacity > 0)
        actor.show();
    actor.ease({
        opacity,
        duration,
        delay,
        mode: Ease.OUT,
        onComplete: () => {
            if (opacity === 0)
                actor.hide();
            onComplete?.();
        },
    });
}

// Grow a visual copy of `source` from `from` to `to` (rects relative to
// `layer`), then destroy it. The clone paints the source regardless of the
// source's own opacity or transform, so the real actors can be hidden while
// the copy is in flight. Resolves when the flight lands.
export function flyClone(layer, source, from, to, {duration = Duration.SLOW} = {}) {
    return new Promise(resolve => {
        const clone = new Clutter.Clone({
            source,
            x: from.x,
            y: from.y,
            width: from.width,
            height: from.height,
        });
        layer.add_child(clone);
        clone.ease({
            x: to.x,
            y: to.y,
            width: to.width,
            height: to.height,
            duration,
            mode: Ease.OUT_EXPO,
            onComplete: () => {
                clone.destroy();
                resolve();
            },
        });
    });
}

// Lay `actor` out into its parent's allocation right now. A freshly shown
// actor has no allocation until the next frame, so measuring it (to aim a
// clone at it) would yield NaN. Its parent must already be allocated.
export function allocateNow(actor) {
    const parent = actor.get_parent();
    if (!parent)
        return;
    const box = parent.get_allocation_box();
    actor.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: box.x2 - box.x1, y2: box.y2 - box.y1}));
}

// The rectangle an actor paints into, relative to `ancestor`.
export function rectIn(actor, ancestor) {
    const [ax, ay] = ancestor.get_transformed_position();
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x: x - ax, y: y - ay, width, height};
}
