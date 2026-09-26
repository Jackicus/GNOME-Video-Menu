// Following playback, so that what is watched marks itself and what is left
// halfway picks up there again. Nothing here plays anything: it listens to
// whatever player is doing it over MPRIS, the D-Bus interface VLC, mpv (with
// mpv-mpris), Showtime and Celluloid all speak, and the shell's own media
// controls read. So a file counts however it was opened — from the library,
// from Files — as long as it is under one of the watched sections' folders.
//
// MPRIS says when a player comes and goes, what it has open (`xesam:url`),
// how long that is, whether it is playing, and when it seeks. It never says
// where playback has got to unless asked, and a player that has closed cannot
// be asked anything. So the position is read, and the clock reading it was
// taken at kept beside it; where playback is at any moment is that position
// moved on by the clock while playing. The poll only corrects drift and
// catches the watched mark on its way past; the moments that matter — a
// pause, a seek, another file, the player going — each carry their own.
//
// Nothing is written while a file plays. Where it stopped goes to the tracker
// when it stops, pauses or goes, and the mark when the position passes
// `watched-threshold`; the tracker does the writing, local and folder.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_NAMESPACE = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

// How often a playing file's position is read, in seconds. See above: this
// is drift and the watched mark, not the stopping point.
const POLL_SECONDS = 30;
// How long a launch's resume waits for the player to come up with the file.
const RESUME_WAIT = 60;
// Less than this far in, nothing is kept: a file opened and closed again.
const MIN_POSITION = 30;

const clock = () => GLib.get_monotonic_time() / 1e6;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// A file:// URI's path. A string operation for a local URI, so it is safe on
// a path to a share that is asleep.
function pathOf(url) {
    if (typeof url !== 'string' || !url.startsWith('file://'))
        return null;
    try {
        return Gio.File.new_for_uri(url).get_path();
    } catch (e) {
        return null;
    }
}

// One player on the bus, as far as it has told us.
class Player {
    constructor(owner) {
        this.owner = owner;
        this.path = null;
        this.trackId = null;
        this.length = 0;
        this.status = 'Stopped';
        this.rate = 1;
        this.canSeek = true;
        this.position = 0;
        this.readAt = clock();
        // The file in hand has been marked watched this time round, so
        // where it stops no longer matters.
        this.marked = false;
    }

    // Where playback is now, in seconds.
    get now() {
        let position = this.position;
        if (this.status === 'Playing')
            position += (clock() - this.readAt) * this.rate;
        return this.length ? Math.min(position, this.length) : position;
    }

    read(position) {
        this.position = Math.max(0, position);
        this.readAt = clock();
    }

    // Take the clock's reckoning as read, before what it runs on changes.
    settle() {
        this.read(this.now);
    }
}

export class PlaybackWatcher {
    constructor(settings, tracker) {
        this._settings = settings;
        this._tracker = tracker;
        this._bus = null;
        this._cancellable = null;
        this._subscriptions = [];
        // Unique bus name -> Player, and each well-known name -> its owner:
        // one process can hold two names (VLC takes a second per instance).
        this._players = new Map();
        this._names = new Map();
        this._pollId = 0;
        this._pending = null;
    }

    enable() {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        const bus = this._bus;
        this._subscriptions = [
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', MPRIS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
                (_bus, _sender, _path, _iface, _signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (oldOwner)
                        this._dropName(name);
                    if (newOwner)
                        this._addName(name, newOwner);
                }),
            bus.signal_subscribe(null, PROPERTIES, 'PropertiesChanged', MPRIS_PATH, PLAYER,
                Gio.DBusSignalFlags.NONE,
                (_bus, sender, _path, _iface, _signal, params) => {
                    const player = this._players.get(sender);
                    if (player)
                        this._apply(player, params.recursiveUnpack()[1]);
                }),
            bus.signal_subscribe(null, PLAYER, 'Seeked', MPRIS_PATH, null, Gio.DBusSignalFlags.NONE,
                (_bus, sender, _path, _iface, _signal, params) => {
                    const player = this._players.get(sender);
                    if (!player)
                        return;
                    player.read(params.recursiveUnpack()[0] / 1e6);
                    this._check(player);
                }),
        ];

        // The players already up: after an unlock, the one that was playing
        // through it.
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (_bus, result) => {
                let names;
                try {
                    [names] = bus.call_finish(result).deep_unpack();
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`[Media Libraries] Could not list media players: ${e.message}`);
                    return;
                }
                for (const name of names.filter(n => n.startsWith(`${MPRIS_NAMESPACE}.`)))
                    this._lookUpOwner(name);
            });
    }

    disable() {
        // Locking the screen lands here with a file playing; where it is goes
        // down now, and the unlock picks the player up again.
        for (const player of this._players.values())
            this._keep(player);
        for (const id of this._subscriptions)
            this._bus.signal_unsubscribe(id);
        this._subscriptions = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._players.clear();
        this._names.clear();
        this._pending = null;
        this._bus = null;
    }

    // The library is about to play `path`: once a player has it, send it to
    // where it was left, less `resume-rewind`.
    resumeNext(path) {
        const position = this._settings.get_boolean('resume-playback') ? this._tracker.positionOf(path) : 0;
        this._pending = position ? {path, position, until: clock() + RESUME_WAIT} : null;
    }

    // ------------------------------------------------------------------
    // Players coming and going
    // ------------------------------------------------------------------
    _lookUpOwner(name) {
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
            new GLib.Variant('(s)', [name]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (bus, result) => {
                try {
                    const [owner] = bus.call_finish(result).deep_unpack();
                    this._addName(name, owner);
                } catch (e) {
                    // Gone again already, or cancelled: nothing to follow.
                }
            });
    }

    _addName(name, owner) {
        this._names.set(name, owner);
        if (this._players.has(owner))
            return;
        const player = new Player(owner);
        this._players.set(owner, player);
        this._bus.call(owner, MPRIS_PATH, PROPERTIES, 'GetAll', new GLib.Variant('(s)', [PLAYER]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, result) => {
                let props;
                try {
                    [props] = bus.call_finish(result).recursiveUnpack();
                } catch (e) {
                    return;
                }
                if (this._players.get(owner) === player)
                    this._apply(player, props);
            });
    }

    _dropName(name) {
        const owner = this._names.get(name);
        this._names.delete(name);
        if (!owner || [...this._names.values()].includes(owner))
            return;
        const player = this._players.get(owner);
        this._players.delete(owner);
        if (player)
            this._keep(player);
        this._schedulePoll();
    }

    // ------------------------------------------------------------------
    // What a player says
    // ------------------------------------------------------------------
    _apply(player, props) {
        if ('Rate' in props) {
            player.settle();
            player.rate = props.Rate > 0 ? props.Rate : 1;
        }
        if ('CanSeek' in props)
            player.canSeek = !!props.CanSeek;
        if ('Metadata' in props) {
            const meta = props.Metadata ?? {};
            const path = pathOf(meta['xesam:url']);
            if (path !== player.path) {
                // The last file ends here, as far as it got.
                this._keep(player);
                player.path = path;
                player.marked = false;
                player.read(0);
            }
            player.trackId = meta['mpris:trackid'] ?? null;
            player.length = (meta['mpris:length'] ?? 0) / 1e6;
        }
        if ('PlaybackStatus' in props && props.PlaybackStatus !== player.status) {
            player.settle();
            const was = player.status;
            player.status = props.PlaybackStatus;
            // A pause is worth one exact reading. A stop is not: a stopped
            // player reports 0, so the clock's reckoning is what is kept.
            if (was === 'Playing' && player.status === 'Paused')
                this._readPosition(player, () => this._keep(player));
            else if (player.status === 'Stopped')
                this._keep(player);
        }
        if ('Position' in props)
            player.read(props.Position / 1e6);

        this._resume(player);
        this._check(player);
        this._schedulePoll();
    }

    _readPosition(player, then) {
        // The answer is for the file in hand now; one that has moved on by
        // the time it comes back would be given the old file's position.
        const {path} = player;
        this._bus.call(player.owner, MPRIS_PATH, PROPERTIES, 'Get', new GLib.Variant('(ss)', [PLAYER, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, result) => {
                if (this._players.get(player.owner) !== player || player.path !== path)
                    return;
                try {
                    player.read(bus.call_finish(result).recursiveUnpack()[0] / 1e6);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    // Not answered: the clock's reckoning stands.
                }
                then();
            });
    }

    _following(player) {
        return !!player.path && this._tracker.covers(player.path);
    }

    // ------------------------------------------------------------------
    // What it comes to
    // ------------------------------------------------------------------
    // Past `watched-threshold`: marked, and where it stopped forgotten.
    _check(player) {
        if (player.marked)
            return true;
        if (!player.length || !this._following(player))
            return false;
        if (player.now < player.length * this._settings.get_int('watched-threshold') / 100)
            return false;
        player.marked = true;
        this._tracker.setWatched(player.path, true);
        return true;
    }

    // Where the file in hand stopped, kept for next time. With resuming off,
    // anything kept before is forgotten. Stopped short of MIN_POSITION it is
    // left as it was: a file opened and closed again says nothing about where
    // it was left — and a resume the player did not take, or a look at the
    // start from Files, must not cost the place that was kept.
    _keep(player) {
        if (!this._following(player) || this._check(player))
            return;
        if (!this._settings.get_boolean('resume-playback')) {
            this._tracker.setPosition(player.path, 0);
            return;
        }
        const at = player.now;
        if (at >= MIN_POSITION)
            this._tracker.setPosition(player.path, at);
    }

    _resume(player) {
        const pending = this._pending;
        if (!pending || player.path !== pending.path || player.status !== 'Playing')
            return;
        this._pending = null;
        const target = pending.position - this._settings.get_int('resume-rewind');
        if (clock() > pending.until || !player.canSeek || target <= 0)
            return;
        // Absolute where the player names its track, relative where it
        // does not; either way in microseconds.
        const [method, args] = player.trackId && player.trackId !== NO_TRACK
            ? ['SetPosition', new GLib.Variant('(ox)', [player.trackId, Math.round(target * 1e6)])]
            : ['Seek', new GLib.Variant('(x)', [Math.round((target - player.now) * 1e6)])];
        this._bus.call(player.owner, MPRIS_PATH, PLAYER, method, args, null, Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`[Media Libraries] Could not resume ${player.path}: ${e.message}`);
                }
            });
        player.read(target);
    }

    // Read every playing file's position every POLL_SECONDS, for as long as
    // one is playing.
    _schedulePoll() {
        const playing = () => [...this._players.values()].filter(p => p.status === 'Playing' && this._following(p));
        if (playing().length && !this._pollId) {
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                const now = playing();
                for (const player of now)
                    this._readPosition(player, () => this._check(player));
                if (now.length)
                    return GLib.SOURCE_CONTINUE;
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            });
        } else if (!playing().length && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }
}
