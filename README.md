<h1 align="center">
    <a href="https://webtorrent.io">
        <img src="https://webtorrent.io/img/WebTorrent.png" alt="WebTorrent" width="200">
    </a>
    <br>
    WebTorrent Desktop api
</h1>

The repository is a branch (fork) of the original version of ❤️ [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop), which add a remote control mechanism via the **REST API** on base [Express](https://github.com/expressjs/express).

The original code (as well as the telemetry) **not been changed**, the main branch contains only the source code with changes, you can check it out, the description provides instructions for merging and assembling with the original version.

### Build

Clone the source code and install dependencies:

```
git clone https://github.com/webtorrent/webtorrent-desktop.git
git clone https://github.com/Lifailon/webtorrent-desktop-api.git
cd webtorrent-desktop
npm install
```

Run the app:

```
npm start
```

Restart the app automatically every time code changes:

```
npm run watch
```

Run linters:

```
npm test
```

Run integration tests:

```
npm run test-integration
```