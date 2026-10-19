# Sendspin over Cast

Chromecast receiver for Sendspin. It runs a custom Cast receiver web app that connects to a Sendspin server over WebSocket using the Sendspin JS SDK.

- Receiver app: `src/js/main.ts` (built to `dist/assets/receiver-*.js` and loaded by `dist/receiver.html`)
- Sender demo page: `src/index.html` (built to `dist/index.html`) to control the cast receiver.

## Quick Start

Prerequisites:

- Node 22.12+ (required by the existing Vite 8 build tooling)
- Yarn 1.x (or npm)
- A Chromecast/Google TV/Cast Audio device on your network

Install and build:

```
yarn
yarn build
```

Then open `dist/index.html` in Chrome to use the sender demo. It discovers Cast devices via the Cast sender SDK and sends configuration to the receiver app.

To preview the static build locally:

```
yarn preview
```

## How It Works

- The sender page (`dist/index.html`) lets you enter the Sendspin server host, preferred codec, and sync delay.
- When you cast, it launches the receiver app (`dist/receiver.html`) on the Cast device and sends a message over the custom namespace `urn:x-cast:sendspin` with `{ serverUrl, codecs, syncDelay }`.
- The receiver creates a Sendspin JS SDK player, connects to `${serverUrl}/sendspin`, and streams audio using Web Audio with hardware volume integration. The SDK selects direct output on non-mobile Cast runtimes and media-element mode with a silent keepalive on Android.

## Cast Message Protocol

All messages between sender and receiver use the custom namespace `urn:x-cast:sendspin`. Each message includes a `type` field to identify the message type.

### Sender → Receiver Messages

**Config message** (`type: "config"`): Sent to the receiver to configure the connection.

```json
{
  "type": "config",
  "serverUrl": "http://192.168.1.100:8927",
  "playerId": "cast-abc123",
  "playerName": "Living Room Speaker",
  "syncDelay": 0,
  "codecs": ["flac"]
}
```

| Field        | Type     | Required | Description                                                      |
| ------------ | -------- | -------- | ---------------------------------------------------------------- |
| `type`       | string   | No\*     | Message type (`"config"`). Optional for backwards compatibility. |
| `serverUrl`  | string   | No       | Sendspin server URL. Triggers connection when changed.           |
| `playerId`   | string   | No       | Player ID override.                                              |
| `playerName` | string   | No       | Friendly name for the player.                                    |
| `syncDelay`  | number   | No       | Sync delay in milliseconds (0-5000, positive = play earlier).    |
| `codecs`     | string[] | No       | Audio codecs: `["flac"]`, `["opus"]`, or `["pcm"]`.              |

### Receiver → Sender Messages

**Status message** (`type: "status"`): Sent periodically by the receiver to report player state.

```json
{
  "type": "status",
  "state": "playing",
  "message": "Ready to play",
  "volume": 75,
  "muted": false,
  "sync": { "synced": true, "offset": 5, "error": 2 },
  "syncInfo": {
    "clockDriftPercent": 0.01,
    "syncErrorMs": 1.5,
    "resyncCount": 0
  }
}
```

| Field      | Type    | Description                                                                 |
| ---------- | ------- | --------------------------------------------------------------------------- |
| `type`     | string  | Message type (`"status"`).                                                  |
| `state`    | string  | One of: `"connecting"`, `"connected"`, `"playing"`, `"stopped"`, `"error"`. |
| `message`  | string  | Human-readable status message.                                              |
| `volume`   | number  | Hardware volume (0-100).                                                    |
| `muted`    | boolean | Mute state.                                                                 |
| `sync`     | object  | Time sync info: `synced`, `offset` (ms), `error` (ms).                      |
| `syncInfo` | object  | Detailed sync metrics: `clockDriftPercent`, `syncErrorMs`, `resyncCount`.   |

### Error Handling

- Fatal errors send `state: "error"` with a human-readable message (including cause), then close the Cast app after ~1s.
- Fatal examples:
  - Unhandled JavaScript/runtime issues, such as `TypeError: Cannot read properties of undefined` and unhandled promise rejections like `NotSupportedError: Failed to construct 'AudioContext'`
  - Cast framework `ERROR` events
  - Setup capability failures, such as `"AudioContext is not implemented on this device"`
  - Reconnect exhaustion, such as `"Reconnect limit reached"`
- Non-fatal example: normal server connection failures (`Connection failed`) report `state: "error"` but do not immediately close the app.

## Development Setup

To develop and test the Cast receiver, you need to set up a Cast developer account and register a custom receiver app.

1. Go to the [Google Cast SDK Developer Console](https://cast.google.com/publish/#/overview) and sign in with your Google account.
2. Create a new application and select "Custom Receiver".
3. Set the receiver URL to a accessible URL where your dev server hosts the receiver (e.g., `http://<your-ip>:3001/receiver.html`).
4. Note the Application ID assigned to your app.

## Drift correction on the MA 2.9 receiver branch

This checkout pins `@sendspin/sendspin-js` to **3.2.0**, replacing 3.0.3.
The [3.2.0 release](https://github.com/Sendspin/sendspin-js/releases/tag/3.2.0)
contains sustained-drift recorrection (#117), signed-error smoothing to avoid
oscillating resyncs (#118), and sustained transient-jitter recorrection (#122).
The old SDK predates the separate recorrection monitor; upgrading avoids copying
the scheduler refactor into this receiver. No receiver API adaptation is needed:
the existing constructor, sync status getters, hardware volume callbacks, and
static-delay commands typecheck and are exercised against the installed SDK.
The runtime dependency remains `opus-encdec`; no Noise/5.x upgrade is involved.

The SDK still sends protocol version 1 with `player@v1`, `controller@v1`, and
`metadata@v1` roles. Version 3.2 also advertises player timing capabilities in
`client/state`. A mocked-transport test verifies the receiver's v1 messages,
2 MB buffer, codec preference, and hardware volume/static-delay round trips;
it does **not** establish a connection to Music Assistant 2.10.7.

Existing audio policy is preserved: non-mobile Cast user agents use direct Web
Audio; Android user agents select the SDK's media-element mode (Web Audio still
routes to the hardware destination, with silent audio for Android keepalive).
Cast detection uses `CrKey` in the user agent. On detected Cast runtimes the SDK
keeps the estimated audio clock rather than promoting firmware
`getOutputTimestamp()` readings, which can cause rate oscillations. Output
latency compensation remains enabled. Neither the SHIELD's actual user agent,
firmware timing accuracy, HDMI latency, nor long-running audible synchronization
has been measured by these tests. A static delay corrects fixed latency, not
progressively accumulating drift.

Verification commands (no dev server needed):

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build
```

The regression tests exercise the published SDK's drift/jitter monitor and signed
smoothing, plus receiver configuration with synthetic Linux/Android Cast user
agents. Internal test seams intentionally follow the exact SDK pin. The published
SDK references missing TypeScript sources in its source maps; test runs may warn
about those missing sources, without affecting execution.

### Deployment prerequisites (not performed here)

Music Assistant 2.10.7 selects Cast app `DD107DDB`; building this repository does
not change that hosted receiver. Testing this build on a SHIELD requires hosting
the **entire** `dist/` directory at a Cast-reachable HTTPS URL, registering a
**custom receiver** in the Google Cast SDK Developer Console pointing to
`receiver.html`, and registering the test Cast device for an unpublished app.
The sender must launch that new application ID and supply the existing Sendspin
configuration. MA's built-in Cast route continues launching `DD107DDB` unless
explicitly adapted to use the custom app; custom registration alone does not
redirect it. The receiver must also reach MA's Sendspin WebSocket endpoint.
Real MA 2.10.7 negotiation, device playback, and a sustained drift listening test
remain deployment acceptance checks. Keep the working SendspinDroid fallback
unchanged until those checks pass.

## Development

Run a dev server and hack on the receiver UI (requires network for Cast SDK):

```
yarn dev
```

This serves the sender page on localhost (with the Cast sender SDK) and builds receiver assets for the target device.

## License

Apache-2.0
