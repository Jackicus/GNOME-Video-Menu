// Remotes, game controllers and keys of your own choosing, turned into what
// the keyboard already does in a library.
//
// Everything in a library is St's focus handling underneath — the arrows walk
// it, Enter opens, Escape backs out — so an action that stands for one of
// those keys (actions.js `stands`) is simply that key, replayed through a
// virtual keyboard of our own: it lands wherever the keyboard would, in the
// wallpaper's pages, the overview's grid, a pop-up panel, and does exactly
// what the key does there. Paging, Home and marking watched have no key, and
// are done here.
//
// Two ways in. A key bound to an action is handed over by the view it reached
// (`handleBoundKey`, from each view's own key handler), so a binding only
// ever means something while a library holds the keyboard — a remote's Back
// is still the browser's Back everywhere else. A controller is read here,
// through libmanette, GNOME's gamepad library, and acted on only while a
// library is up; with one exception, Home, which opens the library when
// nothing else has the keyboard. The shell itself has no gamepad support at
// all, so without this a controller does nothing on the desktop.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {ACTIONS} from './actions.js';

// What counts as "start moving around" when nothing is focused yet.
export const NAVIGATION_KEYS = [
    Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab,
    Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Left, Clutter.KEY_Right,
];

// A controller held in a direction repeats, as a held arrow key does.
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 110;
// A stick counts as pushed past this, and as let go under the second, so it
// does not chatter at the edge.
const AXIS_ON = 0.6;
const AXIS_OFF = 0.35;

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// The modifiers a binding can carry, in the values GTK stores them as — which
// for Shift, Control, Alt and Super are Clutter's too.
const SHIFT = Clutter.ModifierType.SHIFT_MASK;
const CONTROL = Clutter.ModifierType.CONTROL_MASK;
const ALT = Clutter.ModifierType.MOD1_MASK;
const SUPER = Clutter.ModifierType.SUPER_MASK;

// A key and its modifiers as one comparable value; letters lowered, as the
// preferences store them.
function keyId(keyval, state) {
    let mods = state & (SHIFT | CONTROL | ALT);
    if (state & (SUPER | Clutter.ModifierType.MOD4_MASK))
        mods |= SUPER;
    if (keyval >= 0x41 && keyval <= 0x5a)
        keyval += 0x20;
    return `${keyval}:${mods}`;
}

// The live instance, for the views' key handlers to hand keys to.
let current = null;

// A key a view had no use for. If a binding names it, it is that action and
// the view is told to stop there.
export function handleBoundKey(event) {
    return current?._onKey(event) ?? false;
}

export class Controls {
    // `isActive` is whether a library is what has the keyboard; `onHome` is
    // Home inside one, `onOpen` Home from a controller with nothing up;
    // `currentView` is the grid a page turn is for when the keyboard is not
    // on one of its tiles.
    constructor(settings, {isActive, onHome, onOpen, currentView}) {
        this._settings = settings;
        this._isActive = isActive;
        this._onHome = onHome;
        this._onOpen = onOpen;
        this._currentView = currentView;
        this._keys = new Map();
        this._pad = new Map();
        this._device = null;
        this._monitor = null;
        this._pads = new Set();
        // What each pad's inputs are held at: axis states, and the actions
        // being held, with their repeat timers.
        this._axes = new Map();
        this._held = new Map();
        this._starting = null;
    }

    enable() {
        current = this;
        this._device = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        for (const action of ACTIONS) {
            this._settings.connectObject(`changed::keys-${action.key}`, () => this._readKeys(), this);
            this._settings.connectObject(`changed::pad-${action.key}`, () => this._readPad(), this);
        }
        this._settings.connectObject('changed::gamepad-enabled', () => this._syncPads(), this);
        this._readKeys();
        this._readPad();
        this._syncPads();
    }

    disable() {
        if (current === this)
            current = null;
        this._settings.disconnectObject(this);
        this._stopPads();
        this._device = null;
    }

    // ------------------------------------------------------------------
    // Bindings
    // ------------------------------------------------------------------
    // A binding is the setting's, which the preferences refuse the keys an
    // action is replayed as (actions.js NATIVE_KEYS) — but a setting written
    // by hand is not, and an unmodified Escape bound to Back would replay
    // itself back here without end. So the replayed keys are never bindings.
    _readKeys() {
        this._keys.clear();
        const replayed = new Set(ACTIONS.filter(a => a.stands).map(a => Clutter[`KEY_${a.stands}`]));
        for (const action of ACTIONS) {
            for (const [keyval, mods] of this._settings.get_value(`keys-${action.key}`).deep_unpack()) {
                if (!(mods === 0 && replayed.has(keyval)))
                    this._keys.set(keyId(keyval, mods), action);
            }
        }
    }

    _readPad() {
        this._pad.clear();
        for (const action of ACTIONS) {
            for (const input of this._settings.get_strv(`pad-${action.key}`))
                this._pad.set(input, action);
        }
    }

    _onKey(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return false;
        const action = this._keys.get(keyId(event.get_key_symbol(), event.get_state()));
        if (!action)
            return false;
        this._do(action);
        return true;
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    _do(action) {
        if (action.stands) {
            this._press(Clutter[`KEY_${action.stands}`]);
            return;
        }
        switch (action.key) {
        case 'home':
            this._onHome();
            break;
        case 'page-previous':
            this._turnPage(-1);
            break;
        case 'page-next':
            this._turnPage(1);
            break;
        case 'watched':
            global.stage.get_key_focus()?.toggleWatched?.();
            break;
        }
    }

    // The key itself, as though it had been pressed: it arrives wherever
    // the keyboard is, after this event, and is handled as the real one is.
    _press(keyval) {
        const time = GLib.get_monotonic_time();
        this._device?.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
        this._device?.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
    }

    // The grid around the keyboard, or the one on show when the keyboard has
    // not gone into it yet.
    _turnPage(delta) {
        let view = global.stage.get_key_focus();
        while (view && !view.pageBy)
            view = view.get_parent();
        (view ?? this._currentView())?.pageBy(delta);
    }

    // ------------------------------------------------------------------
    // Controllers
    // ------------------------------------------------------------------
    _syncPads() {
        if (this._settings.get_boolean('gamepad-enabled'))
            this._startPads();
        else
            this._stopPads();
    }

    // libmanette is loaded when first wanted, and its absence is not an
    // error: it comes with WebKitGTK on most desktops but nothing guarantees
    // it, and the extension works without it.
    async _startPads() {
        if (this._monitor || this._starting)
            return;
        const starting = this._starting = {};
        let Manette;
        try {
            ({default: Manette} = await import('gi://Manette'));
        } catch {
            console.log('[Media Libraries] libmanette is not installed; game controllers are not read.');
            return;
        } finally {
            if (this._starting === starting)
                this._starting = null;
        }
        // Stopped, or disabled, while it loaded.
        if (current !== this || !this._settings.get_boolean('gamepad-enabled') || this._monitor)
            return;
        this._monitor = new Manette.Monitor();
        this._monitor.connectObject('device-connected', (_monitor, device) => this._addPad(device), this);
        const devices = this._monitor.iterate();
        let device;
        while (([, device] = devices.next()) && device)
            this._addPad(device);
    }

    _stopPads() {
        this._starting = null;
        for (const pad of this._pads)
            pad.disconnectObject(this);
        this._pads.clear();
        this._monitor?.disconnectObject(this);
        this._monitor = null;
        this._axes.clear();
        for (const held of this._held.values()) {
            if (held.timer)
                GLib.source_remove(held.timer);
        }
        this._held.clear();
    }

    _addPad(device) {
        this._pads.add(device);
        device.connectObject(
            'button-press-event', (_d, event) => this._onButton(device, event, true),
            'button-release-event', (_d, event) => this._onButton(device, event, false),
            'absolute-axis-event', (_d, event) => {
                const [ok, axis, value] = event.get_absolute();
                if (ok)
                    this._onAxis(device, axis, value);
            },
            'hat-axis-event', (_d, event) => {
                const [ok, axis, value] = event.get_hat();
                if (ok)
                    this._onAxis(device, axis, value);
            },
            'disconnected', () => {
                device.disconnectObject(this);
                this._pads.delete(device);
                for (const [id, held] of this._held) {
                    if (held.device === device)
                        this._release(id);
                }
            },
            this);
    }

    // A pad libmanette has a mapping for reports the standard code for each
    // button; one it has none for, its own — which is what the preferences
    // recorded when it was bound, either way.
    _onButton(device, event, pressed) {
        const [ok, button] = event.get_button();
        const input = `button:${ok ? button : event.get_hardware_code()}`;
        if (pressed)
            this._hold(device, input);
        else
            this._release(`${device.get_guid()}/${input}`);
    }

    // A stick or a D-pad as two inputs per axis, one each way.
    _onAxis(device, axis, value) {
        const id = `${device.get_guid()}/${axis}`;
        const was = this._axes.get(id) ?? 0;
        let now = was;
        if (Math.abs(value) >= AXIS_ON)
            now = Math.sign(value);
        else if (Math.abs(value) < AXIS_OFF)
            now = 0;
        if (now === was)
            return;
        this._axes.set(id, now);
        if (was)
            this._release(`${device.get_guid()}/axis:${axis}${was < 0 ? '-' : '+'}`);
        if (now)
            this._hold(device, `axis:${axis}${now < 0 ? '-' : '+'}`);
    }

    _hold(device, input) {
        const action = this._pad.get(input);
        if (!action)
            return;
        if (!this._isActive()) {
            if (action.key === 'home')
                this._onOpen();
            return;
        }
        this._do(action);
        if (!DIRECTIONS.has(action.key))
            return;
        const id = `${device.get_guid()}/${input}`;
        this._release(id);
        const held = {device, timer: 0};
        this._held.set(id, held);
        held.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_DELAY, () => {
            held.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_INTERVAL, () => {
                if (!this._isActive()) {
                    held.timer = 0;
                    this._held.delete(id);
                    return GLib.SOURCE_REMOVE;
                }
                this._do(action);
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _release(id) {
        const held = this._held.get(id);
        if (!held)
            return;
        if (held.timer)
            GLib.source_remove(held.timer);
        this._held.delete(id);
    }
}
