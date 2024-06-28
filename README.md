<h1 align="center">
    <a href="https://webtorrent.io">
        <img src="https://webtorrent.io/img/WebTorrent.png" alt="WebTorrent" width="200">
    </a>
    <br>
    WebTorrent Desktop api
</h1>

The repository is a branch (fork) of the original version of ❤️ [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop), which add a remote control mechanism via the **REST API** on base [Express](https://github.com/expressjs/express).

The source code (as well as telemetry) **has not changed**; the description provides instructions for merging and assembling with the original version.

## Build

#### Clone this and the original repository:

```
git clone https://github.com/webtorrent/webtorrent-desktop.git
git clone https://github.com/Lifailon/webtorrent-desktop-api.git
```

#### Copy the files that were updated to the original repository:

```
cp "webtorrent-desktop-api/src/renderer/main.js" "webtorrent-desktop/src/renderer/main.js"
cp "webtorrent-desktop-api/src/renderer/pages/preferences-page.js" "webtorrent-desktop/src/renderer/pages/preferences-page.js"
```

#### Install dependencies:

```
cd webtorrent-desktop
npm install
```

#### Compare changes:

```
git diff
```

#### Run the app:

```
npm start
npm run watch
```

#### Run tests:

```
npm test
npm run test-integration
```

The integration tests use Spectron and Tape. They click through the app, taking screenshots and comparing each one to a reference. When running integration tests, keep the mouse on the edge of the screen and don't touch the mouse or keyboard while the tests are running.

#### Package the app for all platform:

```
npm run package
```
