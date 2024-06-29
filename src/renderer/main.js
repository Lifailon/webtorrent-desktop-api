/**
 * Perf optimization: Hook into require() to modify how certain modules load:
 *
 * - `inline-style-prefixer` (used by `material-ui`) takes ~40ms. It is not
 *   actually used because auto-prefixing is disabled with
 *   `darkBaseTheme.userAgent = false`. Return a fake object.
 */
const Module = require('module')
const _require = Module.prototype.require
Module.prototype.require = function (id) {
    if (id === 'inline-style-prefixer') return {}
    return _require.apply(this, arguments)
}

console.time('init')

// Perf optimization: Start asynchronously read on config file before all the
// blocking require() calls below.

const State = require('./lib/state')
State.load(onState)

const createGetter = require('fn-getter')
const debounce = require('debounce')
const dragDrop = require('drag-drop')
const electron = require('electron')
const fs = require('fs')
const React = require('react')
const ReactDOM = require('react-dom')

const config = require('../config')
const telemetry = require('./lib/telemetry')
const sound = require('./lib/sound')
const TorrentPlayer = require('./lib/torrent-player')

// Perf optimization: Needed immediately, so do not lazy load it below
const TorrentListController = require('./controllers/torrent-list-controller')

const App = require('./pages/app')

// Electron apps have two processes: a main process (node) runs first and starts
// a renderer process (essentially a Chrome window). We're in the renderer process,
// and this IPC channel receives from and sends messages to the main process
const ipcRenderer = electron.ipcRenderer

// Yo-yo pattern: state object lives here and percolates down thru all the views.
// Events come back up from the views via dispatch(...)
require('./lib/dispatcher').setDispatch(dispatch)

// From dispatch(...), events are sent to one of the controllers
let controllers = null

// This dependency is the slowest-loading, so we lazy load it
let Cast = null

// All state lives in state.js. `state.saved` is read from and written to a file.
// All other state is ephemeral. First we load state.saved then initialize the app.
let state

// Root React component
let app

// Called once when the application loads. (Not once per window.)
// Connects to the torrent networks, sets up the UI and OS integrations like
// the dock icon and drag+drop.
function onState(err, _state) {
    if (err) return onError(err)

    // Make available for easier debugging
    state = window.state = _state
    window.dispatch = dispatch

    telemetry.init(state)
    sound.init(state)

    // Log uncaught JS errors
    window.addEventListener(
        'error', (e) => telemetry.logUncaughtError('window', e), true /* capture */
    )

    // Create controllers
    controllers = {
        media: createGetter(() => {
            const MediaController = require('./controllers/media-controller')
            return new MediaController(state)
        }),
        playback: createGetter(() => {
            const PlaybackController = require('./controllers/playback-controller')
            return new PlaybackController(state, config, update)
        }),
        prefs: createGetter(() => {
            const PrefsController = require('./controllers/prefs-controller')
            return new PrefsController(state, config)
        }),
        subtitles: createGetter(() => {
            const SubtitlesController = require('./controllers/subtitles-controller')
            return new SubtitlesController(state)
        }),
        audioTracks: createGetter(() => {
            const AudioTracksController = require('./controllers/audio-tracks-controller')
            return new AudioTracksController(state)
        }),
        torrent: createGetter(() => {
            const TorrentController = require('./controllers/torrent-controller')
            return new TorrentController(state)
        }),
        torrentList: createGetter(() => new TorrentListController(state)),
        update: createGetter(() => {
            const UpdateController = require('./controllers/update-controller')
            return new UpdateController(state)
        }),
        folderWatcher: createGetter(() => {
            const FolderWatcherController = require('./controllers/folder-watcher-controller')
            return new FolderWatcherController()
        })
    }

    // Add first page to location history
    state.location.go({
        url: 'home',
        setup: (cb) => {
            state.window.title = config.APP_WINDOW_TITLE
            cb(null)
        }
    })

    // Give global trackers
    setGlobalTrackers()

    // Restart everything we were torrenting last time the app ran
    resumeTorrents()

    // Initialize ReactDOM
    ReactDOM.render(
        <App state={state} ref={elem => { app = elem }} />,
        document.querySelector('#body')
    )

    // Calling update() updates the UI given the current state
    // Do this at least once a second to give every file in every torrentSummary
    // a progress bar and to keep the cursor in sync when playing a video
    setInterval(update, 1000)

    // Listen for messages from the main process
    setupIpc()

    // Drag and drop files/text to start torrenting or seeding
    dragDrop('body', {
        onDrop: onOpen,
        onDropText: onOpen
    })

    // ...same thing if you paste a torrent
    document.addEventListener('paste', onPaste)

    // Add YouTube style hotkey shortcuts
    window.addEventListener('keydown', onKeydown)

    const debouncedFullscreenToggle = debounce(() => {
        dispatch('toggleFullScreen')
    }, 1000, true)

    document.addEventListener('wheel', event => {
        // ctrlKey detects pinch to zoom, http://crbug.com/289887
        if (event.ctrlKey) {
            event.preventDefault()
            debouncedFullscreenToggle()
        }
    })

    // ...focus and blur. Needed to show correct dock icon text ('badge') in OSX
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    if (electron.remote.getCurrentWindow().isVisible()) {
        sound.play('STARTUP')
    }

    // To keep app startup fast, some code is delayed.
    window.setTimeout(delayedInit, config.DELAYED_INIT)

    // Done! Ideally we want to get here < 500ms after the user clicks the app
    console.timeEnd('init')
}

// Runs a few seconds after the app loads, to avoid slowing down startup time
function delayedInit() {
    telemetry.send(state)

    // Send telemetry data every 12 hours, for users who keep the app running
    // for extended periods of time
    setInterval(() => telemetry.send(state), 12 * 3600 * 1000)

    // Warn if the download dir is gone, eg b/c an external drive is unplugged
    checkDownloadPath()

    // ...window visibility state.
    document.addEventListener('webkitvisibilitychange', onVisibilityChange)
    onVisibilityChange()

    lazyLoadCast()
}

// Lazily loads Chromecast and Airplay support
function lazyLoadCast() {
    if (!Cast) {
        Cast = require('./lib/cast')
        Cast.init(state, update) // Search the local network for Chromecast and Airplays
    }
    return Cast
}

// React loop:
// 1. update() - recompute the virtual DOM, diff, apply to the real DOM
// 2. event - might be a click or other DOM event, or something external
// 3. dispatch - the event handler calls dispatch(), main.js sends it to a controller
// 4. controller - the controller handles the event, changing the state object
function update() {
    controllers.playback().showOrHidePlayerControls()
    app.setState(state)
    updateElectron()
}

// Some state changes can't be reflected in the DOM, instead we have to
// tell the main process to update the window or OS integrations
function updateElectron() {
    if (state.window.title !== state.prev.title) {
        state.prev.title = state.window.title
        ipcRenderer.send('setTitle', state.window.title)
    }
    if (state.dock.progress.toFixed(2) !== state.prev.progress.toFixed(2)) {
        state.prev.progress = state.dock.progress
        ipcRenderer.send('setProgress', state.dock.progress)
    }
    if (state.dock.badge !== state.prev.badge) {
        state.prev.badge = state.dock.badge
        ipcRenderer.send('setBadge', state.dock.badge || 0)
    }
}

const dispatchHandlers = {
    // Torrent list: creating, deleting, selecting torrents
    openTorrentFile: () => ipcRenderer.send('openTorrentFile'),
    openFiles: () => ipcRenderer.send('openFiles'), /* shows the open file dialog */
    openTorrentAddress: () => { state.modal = { id: 'open-torrent-address-modal' } },

    addTorrent: (torrentId) => controllers.torrentList().addTorrent(torrentId),
    showCreateTorrent: (paths) => controllers.torrentList().showCreateTorrent(paths),
    createTorrent: (options) => controllers.torrentList().createTorrent(options),
    toggleTorrent: (infoHash) => controllers.torrentList().toggleTorrent(infoHash),
    pauseAllTorrents: () => controllers.torrentList().pauseAllTorrents(),
    resumeAllTorrents: () => controllers.torrentList().resumeAllTorrents(),
    toggleTorrentFile: (infoHash, index) =>
        controllers.torrentList().toggleTorrentFile(infoHash, index),
    confirmDeleteTorrent: (infoHash, deleteData) =>
        controllers.torrentList().confirmDeleteTorrent(infoHash, deleteData),
    deleteTorrent: (infoHash, deleteData) =>
        controllers.torrentList().deleteTorrent(infoHash, deleteData),
    openTorrentListContextMenu: () => onPaste(),
    confirmDeleteAllTorrents: (deleteData) =>
        controllers.torrentList().confirmDeleteAllTorrents(deleteData),
    deleteAllTorrents: (deleteData) =>
        controllers.torrentList().deleteAllTorrents(deleteData),
    toggleSelectTorrent: (infoHash) =>
        controllers.torrentList().toggleSelectTorrent(infoHash),
    openTorrentContextMenu: (infoHash) =>
        controllers.torrentList().openTorrentContextMenu(infoHash),
    startTorrentingSummary: (torrentKey) =>
        controllers.torrentList().startTorrentingSummary(torrentKey),
    saveTorrentFileAs: (torrentKey) =>
        controllers.torrentList().saveTorrentFileAs(torrentKey),
    prioritizeTorrent: (infoHash) => controllers.torrentList().prioritizeTorrent(infoHash),
    resumePausedTorrents: () => controllers.torrentList().resumePausedTorrents(),

    // Playback
    playFile: (infoHash, index) => controllers.playback().playFile(infoHash, index),
    playPause: () => controllers.playback().playPause(),
    nextTrack: () => controllers.playback().nextTrack(),
    previousTrack: () => controllers.playback().previousTrack(),
    skip: (time) => controllers.playback().skip(time),
    skipTo: (time) => controllers.playback().skipTo(time),
    preview: (x) => controllers.playback().preview(x),
    clearPreview: () => controllers.playback().clearPreview(),
    changePlaybackRate: (dir) => controllers.playback().changePlaybackRate(dir),
    changeVolume: (delta) => controllers.playback().changeVolume(delta),
    setVolume: (vol) => controllers.playback().setVolume(vol),
    openPath: (infoHash, index) => controllers.playback().openPath(infoHash, index),

    // Subtitles
    openSubtitles: () => controllers.subtitles().openSubtitles(),
    selectSubtitle: (index) => controllers.subtitles().selectSubtitle(index),
    toggleSubtitlesMenu: () => controllers.subtitles().toggleSubtitlesMenu(),
    checkForSubtitles: () => controllers.subtitles().checkForSubtitles(),
    addSubtitles: (files, autoSelect) => controllers.subtitles().addSubtitles(files, autoSelect),

    // Audio Tracks
    selectAudioTrack: (index) => controllers.audioTracks().selectAudioTrack(index),
    toggleAudioTracksMenu: () => controllers.audioTracks().toggleAudioTracksMenu(),

    // Local media: <video>, <audio>, external players
    mediaStalled: () => controllers.media().mediaStalled(),
    mediaError: (err) => controllers.media().mediaError(err),
    mediaSuccess: () => controllers.media().mediaSuccess(),
    mediaTimeUpdate: () => controllers.media().mediaTimeUpdate(),
    mediaMouseMoved: () => controllers.media().mediaMouseMoved(),
    mediaControlsMouseEnter: () => controllers.media().controlsMouseEnter(),
    mediaControlsMouseLeave: () => controllers.media().controlsMouseLeave(),
    openExternalPlayer: () => controllers.media().openExternalPlayer(),
    externalPlayerNotFound: () => controllers.media().externalPlayerNotFound(),

    // Remote casting: Chromecast, Airplay, etc
    toggleCastMenu: (deviceType) => lazyLoadCast().toggleMenu(deviceType),
    selectCastDevice: (index) => lazyLoadCast().selectDevice(index),
    stopCasting: () => lazyLoadCast().stop(),

    // Preferences screen
    preferences: () => controllers.prefs().show(),
    updatePreferences: (key, value) => controllers.prefs().update(key, value),
    checkDownloadPath,
    updateGlobalTrackers: (trackers) => setGlobalTrackers(trackers),
    startFolderWatcher: () => controllers.folderWatcher().start(),
    stopFolderWatcher: () => controllers.folderWatcher().stop(),

    // Update (check for new versions on Linux, where there's no auto updater)
    updateAvailable: (version) => controllers.update().updateAvailable(version),
    skipVersion: (version) => controllers.update().skipVersion(version),

    // Navigation between screens (back, forward, ESC, etc)
    exitModal: () => { state.modal = null },
    backToList,
    escapeBack,
    back: () => state.location.back(),
    forward: () => state.location.forward(),
    cancel: () => state.location.cancel(),

    // Controlling the window
    setDimensions,
    toggleFullScreen: (setTo) => ipcRenderer.send('toggleFullScreen', setTo),
    setTitle: (title) => { state.window.title = title },
    resetTitle: () => { state.window.title = config.APP_WINDOW_TITLE },

    // Everything else
    onOpen,
    error: onError,
    uncaughtError: (proc, err) => telemetry.logUncaughtError(proc, err),
    stateSave: () => State.save(state),
    stateSaveImmediate: () => State.saveImmediate(state),
    update: () => { } // No-op, just trigger an update
}

// Events from the UI never modify state directly. Instead they call dispatch()
function dispatch(action, ...args) {
    // Log dispatch calls, for debugging, but don't spam
    if (!['mediaMouseMoved', 'mediaTimeUpdate', 'update'].includes(action)) {
        console.log('dispatch: %s %o', action, args)
    }

    const handler = dispatchHandlers[action]
    if (handler) handler(...args)
    else console.error('Missing dispatch handler: ' + action)

    // Update the virtual DOM, unless it's just a mouse move event
    if (action !== 'mediaMouseMoved' ||
        controllers.playback().showOrHidePlayerControls()) {
        update()
    }
}

// Listen to events from the main and webtorrent processes
function setupIpc() {
    ipcRenderer.on('log', (e, ...args) => console.log(...args))
    ipcRenderer.on('error', (e, ...args) => console.error(...args))

    ipcRenderer.on('dispatch', (e, ...args) => dispatch(...args))

    ipcRenderer.on('fullscreenChanged', onFullscreenChanged)
    ipcRenderer.on('windowBoundsChanged', onWindowBoundsChanged)

    const tc = controllers.torrent()
    ipcRenderer.on('wt-parsed', (e, ...args) => tc.torrentParsed(...args))
    ipcRenderer.on('wt-metadata', (e, ...args) => tc.torrentMetadata(...args))
    ipcRenderer.on('wt-done', (e, ...args) => tc.torrentDone(...args))
    ipcRenderer.on('wt-done', () => controllers.torrentList().resumePausedTorrents())
    ipcRenderer.on('wt-warning', (e, ...args) => tc.torrentWarning(...args))
    ipcRenderer.on('wt-error', (e, ...args) => tc.torrentError(...args))

    ipcRenderer.on('wt-progress', (e, ...args) => tc.torrentProgress(...args))
    ipcRenderer.on('wt-file-modtimes', (e, ...args) => tc.torrentFileModtimes(...args))
    ipcRenderer.on('wt-file-saved', (e, ...args) => tc.torrentFileSaved(...args))
    ipcRenderer.on('wt-poster', (e, ...args) => tc.torrentPosterSaved(...args))
    ipcRenderer.on('wt-audio-metadata', (e, ...args) => tc.torrentAudioMetadata(...args))
    ipcRenderer.on('wt-server-running', (e, ...args) => tc.torrentServerRunning(...args))

    ipcRenderer.on('wt-uncaught-error', (e, err) => telemetry.logUncaughtError('webtorrent', err))

    ipcRenderer.send('ipcReady')

    State.on('stateSaved', () => ipcRenderer.send('stateSaved'))
}

// Quits any modal popovers and returns to the torrent list screen
function backToList() {
    // Exit any modals and screens with a back button
    state.modal = null
    state.location.backToFirst(() => {
        // If we were already on the torrent list, scroll to the top
        const contentTag = document.querySelector('.content')
        if (contentTag) contentTag.scrollTop = 0
    })
}

// Quits modals, full screen, or goes back. Happens when the user hits ESC
function escapeBack() {
    if (state.modal) {
        dispatch('exitModal')
    } else if (state.window.isFullScreen) {
        dispatch('toggleFullScreen')
    } else {
        dispatch('back')
    }
}

function setGlobalTrackers() {
    controllers.torrentList().setGlobalTrackers(state.getGlobalTrackers())
}

// Starts all torrents that aren't paused on program startup
function resumeTorrents() {
    state.saved.torrents
        .map((torrentSummary) => {
            // Torrent keys are ephemeral, reassigned each time the app runs.
            // On startup, give all torrents a key, even the ones that are paused.
            torrentSummary.torrentKey = state.nextTorrentKey++
            return torrentSummary
        })
        .filter((s) => s.status !== 'paused')
        .forEach((s) => controllers.torrentList().startTorrentingSummary(s.torrentKey))
}

// Set window dimensions to match video dimensions or fill the screen
function setDimensions(dimensions) {
    // Don't modify the window size if it's already maximized
    if (electron.remote.getCurrentWindow().isMaximized()) {
        state.window.bounds = null
        return
    }

    // Save the bounds of the window for later. See restoreBounds()
    state.window.bounds = {
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight
    }
    state.window.wasMaximized = electron.remote.getCurrentWindow().isMaximized

    // Limit window size to screen size
    const screenWidth = window.screen.width
    const screenHeight = window.screen.height
    const aspectRatio = dimensions.width / dimensions.height
    const scaleFactor = Math.min(
        Math.min(screenWidth / dimensions.width, 1),
        Math.min(screenHeight / dimensions.height, 1)
    )
    const width = Math.max(
        Math.floor(dimensions.width * scaleFactor),
        config.WINDOW_MIN_WIDTH
    )
    const height = Math.max(
        Math.floor(dimensions.height * scaleFactor),
        config.WINDOW_MIN_HEIGHT
    )

    ipcRenderer.send('setAspectRatio', aspectRatio)
    ipcRenderer.send('setBounds', { contentBounds: true, x: null, y: null, width, height })
    state.playing.aspectRatio = aspectRatio
}

// Called when the user adds files (.torrent, files to seed, subtitles) to the app
// via any method (drag-drop, drag to app icon, command line)
function onOpen(files) {
    if (!Array.isArray(files)) files = [files]

    // File API seems to transform "magnet:?foo" in "magnet:///?foo"
    // this is a sanitization
    files = files.map(file => {
        if (typeof file !== 'string') return file
        return file.replace(/^magnet:\/+\?/i, 'magnet:?')
    })

    const url = state.location.url()
    const allTorrents = files.every(TorrentPlayer.isTorrent)
    const allSubtitles = files.every(controllers.subtitles().isSubtitle)

    if (allTorrents) {
        // Drop torrents onto the app: go to home screen, add torrents, no matter what
        dispatch('backToList')
        // All .torrent files? Add them.
        files.forEach((file) => controllers.torrentList().addTorrent(file))
    } else if (url === 'player' && allSubtitles) {
        // Drop subtitles onto a playing video: add subtitles
        controllers.subtitles().addSubtitles(files, true)
    } else if (url === 'home') {
        // Drop files onto home screen: show Create Torrent
        state.modal = null
        controllers.torrentList().showCreateTorrent(files)
    } else {
        // Drop files onto any other screen: show error
        return onError('Please go back to the torrent list before creating a new torrent.')
    }

    update()
}

function onError(err) {
    console.error(err.stack || err)
    sound.play('ERROR')
    state.errors.push({
        time: new Date().getTime(),
        message: err.message || err
    })

    update()
}

const editableHtmlTags = new Set(['input', 'textarea'])

function onPaste(e) {
    if (e && editableHtmlTags.has(e.target.tagName.toLowerCase())) return
    controllers.torrentList().addTorrent(electron.clipboard.readText())

    update()
}

function onKeydown(e) {
    // prevent event fire on user input elements
    if (editableHtmlTags.has(e.target.tagName.toLowerCase())) return

    const key = e.key

    if (key === 'ArrowLeft') {
        dispatch('skip', -5)
    } else if (key === 'ArrowRight') {
        dispatch('skip', 5)
    } else if (key === 'ArrowUp') {
        dispatch('changeVolume', 0.1)
    } else if (key === 'ArrowDown') {
        dispatch('changeVolume', -0.1)
    } else if (key === 'j') {
        dispatch('skip', -10)
    } else if (key === 'l') {
        dispatch('skip', 10)
    } else if (key === 'k') {
        dispatch('playPause')
    } else if (key === '>') {
        dispatch('changePlaybackRate', 1)
    } else if (key === '<') {
        dispatch('changePlaybackRate', -1)
    } else if (key === 'f') {
        dispatch('toggleFullScreen')
    }

    update()
}

function onFocus(e) {
    state.window.isFocused = true
    state.dock.badge = 0
    update()
}

function onBlur() {
    state.window.isFocused = false
    update()
}

function onVisibilityChange() {
    state.window.isVisible = !document.hidden
}

function onFullscreenChanged(e, isFullScreen) {
    state.window.isFullScreen = isFullScreen
    if (!isFullScreen) {
        // Aspect ratio gets reset in fullscreen mode, so restore it (Mac)
        ipcRenderer.send('setAspectRatio', state.playing.aspectRatio)
    }

    update()
}

function onWindowBoundsChanged(e, newBounds) {
    if (state.location.url() !== 'player') {
        state.saved.bounds = newBounds
        dispatch('stateSave')
    }
}

function checkDownloadPath() {
    fs.stat(state.saved.prefs.downloadPath, (err, stat) => {
        if (err) {
            state.downloadPathStatus = 'missing'
            return console.error(err)
        }
        if (stat.isDirectory()) state.downloadPathStatus = 'ok'
        else state.downloadPathStatus = 'missing'
    })
}

// Express API start

let expressApi;

function startExpressApi(port) {
    const express = require('express');
    const api = express();

    api.use((req, res, next) => {
        req.headers['content-type'] = 'application/json';
        next();
    });

    api.use(express.json());

    // GET /stats
    api.get('/stats', (req, res) => {
        const torrentList = ({
            Version: state.saved.version,
            Startup: state.saved.startup,
            DownloadPath: state.saved.prefs.downloadPath,
            AutoAddTorrents: state.saved.prefs.autoAddTorrents,
            PathAutoAddTorrents: state.saved.prefs.torrentsFolderPath,
            Trackers: state.saved.prefs.globalTrackers,
            System: state.saved.telemetry.system,
            TorrentStats: state.saved.telemetry.torrentStats
        });
        res.json(torrentList);
    });

    // curl -s http://localhost:9099/stats | jq

    // GET /torrents
    api.get('/torrents', (req, res) => {
        const torrentList = state.saved.torrents.map(torrent => ({
            Hash: torrent.infoHash,
            Name: torrent.name,
            Status: torrent.status,
            Ready: torrent.progress.ready,
            Progress: (torrent.progress.progress).toFixed(2)*100,
            Downloaded: torrent.progress.downloaded,
            Size: torrent.progress.length,
            DownloadSpeed: torrent.progress.downloadSpeed,
            UploadSpeed: torrent.progress.uploadSpeed,
            Peers: torrent.progress.numPeers,
            Path: torrent.path,
            Magnet: torrent.magnetURI
        }));
        res.json(torrentList);
    });

    // curl -s http://localhost:9099/torrents | jq

    // GET /torrent/<hash>
    api.get('/torrent/:hash', (req, res) => {
        const { hash } = req.params;
        hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            const torrentStatus = ({
                Hash: torrent.infoHash,
                Name: torrent.name,
                Status: torrent.status,
                Ready: torrent.progress.ready,
                Progress: (torrent.progress.progress).toFixed(2)*100,
                Downloaded: torrent.progress.downloaded,
                Size: torrent.progress.length,
                DownloadSpeed: torrent.progress.downloadSpeed,
                UploadSpeed: torrent.progress.uploadSpeed,
                Peers: torrent.progress.numPeers,
                Path: torrent.path,
                Magnet: torrent.magnetURI
            });
            res.json(torrentStatus);
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s http://localhost:9099/torrent/e62cfb63067092bea3f952c94d1c4b1a66af866a | jq

    // GET /torrentFiles/<hash>
    api.get('/torrentFiles/:hash', (req, res) => {
        const { hash } = req.params;
        hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            const torrentFiles = torrent.files.map((file, index) => ({
                Index: index,
                Name: file.name,
                Status: torrent.selections[index] ? 'ok' : 'skip',
                Progress: (torrent.progress.files[index].numPiecesPresent) / (torrent.progress.files[index].numPieces) * 100,
                Size: file.length,
                Path: file.path
            }));
            res.json({ torrentFiles });
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s http://localhost:9099/torrentFiles/e62cfb63067092bea3f952c94d1c4b1a66af866a | jq

    // POST /pauseAllTorrents
    api.post('/pauseAllTorrents', async (req, res) => {
        controllers.torrentList().pauseAllTorrents();
        const torrentList = state.saved.torrents.map(torrent => ({
            Hash: torrent.infoHash,
            Name: torrent.name,
            Status: torrent.status
        }));
        res.json(torrentList);
    });

    // curl -s -X POST http://localhost:9099/pauseAllTorrents | jq

    // POST /resumeAllTorrents
    api.post('/resumeAllTorrents', async (req, res) => {
        controllers.torrentList().resumeAllTorrents();
        const torrentList = state.saved.torrents.map(torrent => ({
            Hash: torrent.infoHash,
            Name: torrent.name,
            Status: torrent.status
        }));
        res.json(torrentList);
    });

    // POST /prioritizeTorrent <hash: hash>
    api.post('/prioritizeTorrent', async (req, res) => {
        const { hash } = req.body;
        hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            controllers.torrentList().resumePausedTorrents()
            await new Promise(resolve => setTimeout(resolve, 1000));
            controllers.torrentList().prioritizeTorrent(hashLowerCase)
            const torrentList = state.saved.torrents.map(torrent => ({
                Hash: torrent.infoHash,
                Name: torrent.name,
                Status: torrent.status
            }));
            res.json(torrentList);
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s -X POST http://localhost:9099/prioritizeTorrent -d '{"hash": "e62cfb63067092bea3f952c94d1c4b1a66af866a"}' | jq

    // POST /resumePausedTorrents
    api.post('/resumePausedTorrents', (req, res) => {
        controllers.torrentList().resumePausedTorrents()
        const torrentList = state.saved.torrents.map(torrent => ({
            Hash: torrent.infoHash,
            Name: torrent.name,
            Status: torrent.status
        }));
        res.json(torrentList);
    });

    // curl -s -X POST http://localhost:9099/resumePausedTorrents | jq

    // curl -s -X POST http://localhost:9099/resumeAllTorrents | jq

    // POST /toggleTorrent <hash: hash>
    api.post('/toggleTorrent', async (req, res) => {
        const { hash } = req.body;
        hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            controllers.torrentList().toggleTorrent(torrent.infoHash);
            await new Promise(resolve => setTimeout(resolve, 1000));
            const torrentStatus = ({
                Hash: torrent.infoHash,
                Name: torrent.name,
                Status: torrent.status
            });
            res.json(torrentStatus);
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s -X POST http://localhost:9099/toggleTorrent -d '{"hash": "e62cfb63067092bea3f952c94d1c4b1a66af866a"}' | jq

    // POST /toggleTorrentFile <hash: hash> <index: num>
    api.post('/toggleTorrentFile', (req, res) => {
        const { hash, index } = req.body;
        hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            controllers.torrentList().toggleTorrentFile(hashLowerCase, index);
            const torrentFiles = torrent.files.map((file, index) => ({
                Index: index,
                Name: file.name,
                Status: torrent.selections[index] ? 'ok' : 'skip',
            }));
            res.json({ torrentFiles });
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s -X POST http://localhost:9099/toggleTorrentFile -d '{"hash": "e62cfb63067092bea3f952c94d1c4b1a66af866a", "index": "0"}' | jq
    // curl -s -X POST http://localhost:9099/toggleTorrentFile -d '{"hash": "e62cfb63067092bea3f952c94d1c4b1a66af866a", "index": "1"}' | jq

    // POST /toggleAllTorrentFile <hash: hash>
    api.post('/toggleAllTorrentFile', (req, res) => {
        const { hash } = req.body;
        const hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            for (let index = 0; index < torrent.files.length; index++) {
                controllers.torrentList().toggleTorrentFile(hashLowerCase, index);
            }
            const torrentFiles = torrent.files.map((file, index) => ({
                Index: index,
                Name: file.name,
                Status: torrent.selections[index] ? 'ok' : 'skip',
            }));
            res.json({ torrentFiles });
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s -X POST http://localhost:9099/toggleAllTorrentFile -d '{"hash": "e62cfb63067092bea3f952c94d1c4b1a66af866a"}' | jq

    // POST /addTorrent <hash: hash/url>
    api.post('/addTorrent', async (req, res) => {
        const { source } = req.body;
        hashLowerCase = source.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (!(torrent)) {
            controllers.torrentList().addTorrent(hashLowerCase);
            await new Promise(resolve => setTimeout(resolve, 1000));
            const torrentList = state.saved.torrents.map(torrent => ({
                Hash: torrent.infoHash,
                Name: torrent.name,
                Status: torrent.status
            }));
            res.json(torrentList);
        } else {
            res.status(404).json({ Response: `Torrent already added (${hash})` });
        }
    });

    // curl -s -X POST http://localhost:9099/addTorrent -d '{"source": "E62CFB63067092BEA3F952C94D1C4B1A66AF866A"}' | jq
    // curl -s -X POST http://localhost:9099/addTorrent -d '{"source": "https://d.rutor.info/download/885515"}' | jq

    // POST /deleteTorrent <hash: hash> <deleteData: true/false>
    api.post('/deleteTorrent', (req, res) => {
        const { hash, deleteData } = req.body;
        hashLowerCase = hash.toLowerCase();
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            controllers.torrentList().deleteTorrent(hashLowerCase, deleteData);
            const torrentList = state.saved.torrents.map(torrent => ({
                Hash: torrent.infoHash,
                Name: torrent.name,
                Status: torrent.status
            }));
            res.json(torrentList);
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s -X POST http://localhost:9099/deleteTorrent -d '{"hash": "E62CFB63067092BEA3F952C94D1C4B1A66AF866A", "deleteData": false}' | jq
    // curl -s -X POST http://localhost:9099/deleteTorrent -d '{"hash": "E62CFB63067092BEA3F952C94D1C4B1A66AF866A", "deleteData": true}' | jq
    
    // POST /createTorrent <path: directory/file>
    api.post('/createTorrent', async (req, res) => {
        const { path } = req.body;
        const options = {
            files: [
                { path: path }
            ]
        };        
        controllers.torrentList().createTorrent(options);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const torrentList = state.saved.torrents.map(torrent => ({
            Hash: torrent.infoHash,
            Name: torrent.name,
            Status: torrent.status
        }));
        res.json(torrentList);
    });

    // curl -s -X POST http://localhost:9099/createTorrent -d '{"path": "D:/plex-content/River"}' | jq
    // curl -s -X POST http://localhost:9099/createTorrent -d '{"path": "D:/plex-content/River/Riverdale.S02E22.rus.LostFilm.TV.avi"}' | jq

    // POST /saveTorrentFile <hash: hash>
    api.post('/saveTorrentFile', (req, res) => {
        const { hash } = req.body;
        const hashLowerCase = hash.toLowerCase();
        const path = require('path');
        const pathJoin = path.join(process.env.LOCALAPPDATA, 'WebTorrent', 'Torrents', `${hashLowerCase}.torrent`);
        const torrent = state.saved.torrents.find(t => t.infoHash === hashLowerCase);
        if (torrent) {
            fs.readFile(pathJoin, (err, data) => {
                if (err) {
                    res.status(500).json({ Response: "Error read torrent file" });
                    return;
                }
                res.send(data);
            });
        } else {
            res.status(404).json({ Response: `Torrent not found (${hashLowerCase})` });
        }
    });

    // curl -s -X POST http://localhost:9099/saveTorrentFile -d '{"hash": "E62CFB63067092BEA3F952C94D1C4B1A66AF866A"}' -o E62CFB63067092BEA3F952C94D1C4B1A66AF866A.torrent

    api.use((req, res, next) => {
        res.status(404).json({ Response: "Endpoint not found" });
    });

    expressApi = api.listen(port, () => {
        console.log(`API started on http://localhost:${port}`);
    });
}

function stopExpressApi() {
    if (expressApi) {
        expressApi.close(() => {
            console.log('API stopped');
        });
    }
}

// // Applying settings after restart the application
// async function checkStartApi() {
//     await new Promise(resolve => {
//         const checkInterval = setInterval(() => {
//             if (state.saved.prefs.api !== undefined && state.saved.prefs.port !== undefined) {
//                 clearInterval(checkInterval);
//                 resolve();
//             }
//         }, 1000);
//     });
//     if (state.saved.prefs.api) {
//         startExpressApi(state.saved.prefs.port);
//     }
// }
// 
// checkStartApi();

// Monitoring Checkbox status to apply settings
let statusExpressApi = undefined;

async function checkStartStopApi() {
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (state.saved.prefs.api !== statusExpressApi && state.saved.prefs.port != undefined) {
            statusExpressApi = state.saved.prefs.api;
            if (statusExpressApi) {
                startExpressApi(state.saved.prefs.port);
            } else {
                stopExpressApi();
            }
        }
    }
}

checkStartStopApi();

// Express API end