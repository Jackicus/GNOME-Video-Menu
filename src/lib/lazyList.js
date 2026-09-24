// Filling a scroll view a batch at a time.
//
// The library grid and the detail lists are both "one actor per thing you own",
// and a section can hold thousands of things while the screen shows a couple
// of dozen. Building all of them costs a St.Button subtree each,
// laid out and styled in one go on the compositor's own main loop — the stall
// lands exactly when a section is opened or switched, which is the moment the
// surface is meant to be animating.
//
// So: build enough to cover what is on screen, then more as the view nears its
// end. Each batch is its own main-loop iteration rather than one long block.

import GLib from 'gi://GLib';

// How close to the bottom the view has to come before the next batch is built.
const MARGIN = 600;

// `buildBatch()` appends the next batch and returns false when nothing is left.
// It is called once immediately, then again whenever the view is scrolled near
// its end or turns out not to be full.
export function fillOnScroll(scroll, buildBatch, {margin = MARGIN} = {}) {
    const adjustment = scroll.vadjustment ?? scroll.get_vadjustment?.() ?? null;
    if (!adjustment) {
        // Nothing to drive the top-ups. The first batch is a screenful, which
        // is all a view with no adjustment can show anyway — building the whole
        // library instead would be exactly the stall this module exists to
        // avoid, for rows nobody can scroll to.
        buildBatch();
        return;
    }

    let more = buildBatch();
    let pending = 0;

    // page_size is 0 until the view is first allocated; before that there is
    // nothing to measure against and the initial batch has to stand alone.
    const wantsMore = () => adjustment.page_size > 0 &&
        (adjustment.upper <= adjustment.page_size + 1 ||
         adjustment.value + adjustment.page_size >= adjustment.upper - margin);

    const topUp = () => {
        if (pending || !more)
            return;
        pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pending = 0;
            if (more && wantsMore()) {
                more = buildBatch();
                topUp();   // keep going until the view is covered
            }
            return GLib.SOURCE_REMOVE;
        });
    };

    adjustment.connect('notify::value', topUp);
    adjustment.connect('notify::upper', topUp);
    adjustment.connect('notify::page-size', topUp);
    // The adjustment belongs to the scroll view and is disposed with it — by
    // the time this runs it is already gone, so disconnecting here would throw
    // rather than tidy anything. Only the idle outlives the actors, and only
    // that has to be taken back.
    scroll.connect('destroy', () => {
        if (pending)
            GLib.source_remove(pending);
        pending = 0;
        more = false;
    });

    topUp();
}
