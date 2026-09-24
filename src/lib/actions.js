// What a remote, a game controller or a key of your own choosing can do in a
// library, shared by the extension (controls.js) and the preferences, and so
// nothing but data: the preferences run in a GTK process, where the shell's
// modules cannot be loaded.
//
// Each action has two settings: `keys-<key>`, a list of (keyval, modifiers)
// pairs, and `pad-<key>`, a list of controller inputs ("button:304",
// "axis:1-", "hat:17+"). Keys are stored as numbers rather than names because
// the shell has no way to read a name: Clutter's table of key symbols lacks
// half of what a remote sends (XF86OK, XF86Select, XF86HomePage).
//
// `stands` is the key the action stands in for. The first six are nothing
// but that key — a remote's OK is Enter — and are replayed as it, so they do
// exactly what the keyboard does wherever the keyboard is; the rest are ours.

export const ACTIONS = [
    {key: 'up', title: 'Up', stands: 'Up'},
    {key: 'down', title: 'Down', stands: 'Down'},
    {key: 'left', title: 'Left', stands: 'Left'},
    {key: 'right', title: 'Right', stands: 'Right'},
    {key: 'select', title: 'Select', subtitle: 'Opens or plays what is highlighted, as Enter does', stands: 'Return'},
    {key: 'back', title: 'Back', subtitle: 'Backs out one level, as Escape does', stands: 'Escape'},
    {key: 'home', title: 'Home', subtitle: 'Straight back out to the home menu, or out of the library altogether'},
    {key: 'page-previous', title: 'Previous page', subtitle: 'Turns a library back a page'},
    {key: 'page-next', title: 'Next page', subtitle: 'Turns a library on a page'},
    {key: 'watched', title: 'Mark watched', subtitle: 'Ticks the highlighted episode or film on or off'},
];

// The keys that already do these things in GNOME, and always will: a binding
// adds a key, it never takes one of these away, so none of them is offered.
export const NATIVE_KEYS = [
    'Up', 'Down', 'Left', 'Right', 'Return', 'KP_Enter', 'ISO_Enter', 'space',
    'Escape', 'Tab', 'ISO_Left_Tab',
];

// A controller's inputs by the Linux input codes libmanette reports for a
// pad it has a mapping for (an Xbox or PlayStation pad, most others): what
// the preferences call them. The face buttons are by position, as the kernel's
// gamepad spec has them — 307 is the top one, 308 the left — which on an Xbox
// pad is Y and X, whatever the driver itself sends for them. A pad it has no
// mapping for — a Pico running as a gamepad — reports its own codes, which
// show as numbers.
export const PAD_BUTTONS = {
    304: 'A', 305: 'B', 307: 'Y', 308: 'X',
    310: 'LB', 311: 'RB', 312: 'LT', 313: 'RT',
    314: 'View', 315: 'Menu', 316: 'Guide',
    317: 'Left stick press', 318: 'Right stick press',
    544: 'D-pad up', 545: 'D-pad down', 546: 'D-pad left', 547: 'D-pad right',
};

export const PAD_AXES = {
    0: ['Left stick left', 'Left stick right'],
    1: ['Left stick up', 'Left stick down'],
    3: ['Right stick left', 'Right stick right'],
    4: ['Right stick up', 'Right stick down'],
    16: ['D-pad left', 'D-pad right'],
    17: ['D-pad up', 'D-pad down'],
};

// "button:304" → "A", "axis:1-" → "Left stick up".
export function padLabel(input) {
    const [kind, code] = input.split(':');
    const number = parseInt(code);
    if (kind === 'button')
        return PAD_BUTTONS[number] ?? `Button ${number}`;
    const [minus, plus] = PAD_AXES[number] ?? [`Axis ${number} −`, `Axis ${number} +`];
    return code.endsWith('-') ? minus : plus;
}
