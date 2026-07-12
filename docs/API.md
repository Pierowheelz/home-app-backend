# Home App Backend — Web App API Reference

This document describes the HTTP API exposed by the Node/express server so you can integrate it from a browser or any JavaScript client. Route definitions live in `authorization/routes.config.js`, `users/routes.config.js`, and `devices/routes.config.js`.

## Base URL and transport

- Default listen port is configured in `common/config/env.config.js` as `port` (sample: `3600`). The same config may set `apiEndpoint` / `appEndpoint` for documentation; clients should use your deployed host and scheme (`http` or `https`).
- If `ssl_cert` is set to a non-empty path, the server uses **HTTPS** with that certificate Material; otherwise it uses plain **HTTP**.
- **CORS** is enabled for all origins (`Access-Control-Allow-Origin: *`). `OPTIONS` preflight returns `200` with body `ok`.
- Request timeout on the server is **15 seconds** per request.
- Use **`Content-Type: application/json`** for JSON request bodies.

## Authentication

Most routes require a **JWT access token** issued by `POST /auth` or `POST /auth/refresh`.

Send the token on each request:

```http
Authorization: Bearer <accessToken>
```

### Token errors (no JSON body)

The JWT middleware returns **empty bodies** on failure:

| Status | Meaning |
|--------|---------|
| `401` | No `Authorization` header, or scheme is not `Bearer`. |
| `403` | Token missing after `Bearer`, verification failed, or token expired. |

### Permission model

JWT payload includes at least `userId`, `email`, `permissionLevel`, etc. Middleware enforces:

- **`minimumPermissionLevelRequired(NORMAL_USER)`** — user must have permission bit `NORMAL_USER` **or** the admin bit (`4096`).
- **`onlyUserCanDoThisAction(0)`** — only the user whose JWT `userId` is **numeric `0`** may call the route (other users get `403` with empty body).
- **`onlySameUserOrAdminCanDoThisAction`** — for `/users/:userId`, the caller must match `userId` or have the admin bit.

Configurable bits are in `env.config.js` under `permissionLevels` (e.g. `NORMAL_USER: 1`, admin is `4096`).

---

## Sample client helper (JavaScript)

Use this pattern in the browser or Node 18+ (`fetch`). Replace `BASE_URL` with your server origin (no trailing slash).

```javascript
const BASE_URL = 'https://your-host:3600'; // or http://...

/**
 * @param {string} path - e.g. '/garage' or '/users?page=0'
 * @param {{ method?: string, body?: object, token?: string }} [opts]
 */
async function api(path, opts = {}) {
  const { method = 'GET', body, token } = opts;
  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    // @ts-ignore
    err.status = res.status;
    // @ts-ignore
    err.body = data;
    throw err;
  }
  return data;
}

// Login then call a protected route
async function example() {
  const auth = await api('/auth', {
    method: 'POST',
    body: {
      email: 'user@example.com',
      password: 'secret',
    },
  });
  const { accessToken } = auth;
  const garage = await api('/garage', { token: accessToken });
  console.log(garage);
}
```

---

## Auth

### `POST /auth`

**Auth:** none.

**Body:**

```json
{
  "email": "user@example.com",
  "password": "plain-text-password"
}
```

**Behavior:** Validates email/password against configured users (`env.config.js` `users` array). On success, issues JWT and refresh material.

**Responses:**

- `201` — success:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<base64-encoded-hmac>",
  "userId": 0
}
```

- `400` — `{ "errors": "Missing email field" | "..." | ["Invalid e-mail or password"] }`
- `500` — `{ "errors": ... }` on server error

**Sample:**

```javascript
const { accessToken, refreshToken, userId } = await api('/auth', {
  method: 'POST',
  body: { email: 'user@example.com', password: 'secret' },
});
```

### `POST /auth/refresh`

**Auth:** `Authorization: Bearer <expired-or-valid-access-token>` (the middleware still verifies JWT signature/expiry — use this before access token expires, or your deployment’s policy).

**Body:**

```json
{
  "refresh_token": "<base64 string matching login response refreshToken>"
}
```

**Behavior:** Verifies `refresh_token` against the HMAC derived from the JWT’s `refreshKey` and `userId`. On success, runs the same token issuance as login (`AuthorizationController.login`).

**Responses:**

- `201` — same shape as login: `{ accessToken, refreshToken, userId }`
- `400` — `{ "error": "need to pass refresh_token field" }` or `{ "error": "Invalid refresh token" }`

**Sample:**

```javascript
const refreshed = await api('/auth/refresh', {
  method: 'POST',
  token: accessToken,
  body: { refresh_token: refreshToken },
});
```

---

## Users

### `POST /users`

**Auth:** none (intended as a **utility** to hash a password for manual copy into `env.config.js`).

**Body:** user fields, e.g. `firstName`, `lastName`, `email`, `password` (plain). `permissionLevel` is forced to `1` in code.

**Responses:**

- `201` — `{ "success": true }`
- Server logs the hashed user document; persist users in config per project README.

**Sample:**

```javascript
await api('/users', {
  method: 'POST',
  body: {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    password: 'generate-and-copy-hash',
  },
});
```

### `GET /users`

**Auth:** JWT + `NORMAL_USER` permission bit.

**Query:** optional `limit` (max 100, default 10), `page` (integer, default 0). Note: the in-memory model returns all users in the array regardless of pagination parameters.

**Responses:**

- `200` — JSON array of users with `_id`, `firstName`, `lastName`, `email`, `permissionLevel` (passwords omitted).

**Sample:**

```javascript
const users = await api('/users?limit=50&page=0', { token: accessToken });
```

### `GET /users/:userId`

**Auth:** JWT + caller must be the same `userId` **or** have admin permission.

**Responses:**

- `200` — user object from store (includes fields as stored in `users` model for that id)
- `403` — empty body if not allowed

**Sample:**

```javascript
const me = await api(`/users/${userId}`, { token: accessToken });
```

---

## Devices — Garage

### `GET /garage`

**Auth:** JWT + `NORMAL_USER`.

**Behavior:** Returns last known garage door state from MQTT (`open` | `closed` | `middle` | `unknown`).

**Response `200`:**

```json
{ "state": "closed" }
```

**Sample:**

```javascript
const { state } = await api('/garage', { token: accessToken });
```

### `POST /garage`

**Auth:** JWT + `NORMAL_USER`.

**Behavior:** Publishes MQTT command to pulse the garage opener (`cmnd/tas_garage/POWER` → `1`).

**Responses:**

- `200` — body is boolean `true` if publish succeeded
- `503` — body is boolean `false` if MQTT command could not be sent

**Sample:**

```javascript
const ok = await api('/garage', { method: 'POST', token: accessToken });
```

---

## Devices — Blinds

All three routes require JWT and **`onlyUserCanDoThisAction(0)`** (user id `0` only).

Each calls a local HTTP device (`fetchWithTimeout` ~4s). Responses are JSON.

### `POST /blinds/open` | `POST /blinds/close` | `POST /blinds/stop`

**Responses:**

- `200` — `{ "success": true, "error": "" }`
- `500` — `{ "success": false, "error": "offline" }`

**Sample:**

```javascript
await api('/blinds/open', { method: 'POST', token: accessToken });
```

---

## Devices — Speakers

### `GET /speakers`

**Auth:** JWT + `NORMAL_USER`.

**Response `200`:** `{ "state": "on" | "off" | "unknown" }` (from MQTT).

**Sample:**

```javascript
const { state } = await api('/speakers', { token: accessToken });
```

### `POST /speakers/on` and `POST /speakers/off`

**Auth:** JWT + **`onlyUserCanDoThisAction(0)`**.

**Responses:** `200` + boolean `true`, or `503` + boolean `false` (MQTT not attached / failed).

**Sample:**

```javascript
await api('/speakers/on', { method: 'POST', token: accessToken });
```

### `GET /speakers/on/p7tvhtekg4942iw4tv` and `GET /speakers/off/p7tvhtekg4942iw4tv`

**Auth:** none (hard-coded path segments for simple triggers).

Same response pattern as POST variants (boolean body).

**Sample:**

```javascript
await fetch(`${BASE_URL}/speakers/on/p7tvhtekg4942iw4tv`);
```

---

## Devices — Room temperatures (Zigbee / Tasmota)

### `GET /temperatures`

**Auth:** JWT + `NORMAL_USER`.

**Behavior:** Returns the last readings cached from MQTT for mapped rooms (Temperature °C, optional humidity, battery, link quality, `lastUpdateMs`).

**Response `200`:**

```json
{
  "device": "tasmota_zigbee",
  "sensors": {
    "Guest Room": {
      "temperature": 21.3,
      "humidity": 45,
      "lastUpdateMs": 1712000000000,
      "batteryLevel": 100,
      "linkQuality": 120
    }
  }
}
```

`null` values are possible when no data has been received yet.

**Sample:**

```javascript
const temps = await api('/temperatures', { token: accessToken });
```

---

## Devices — Zigbee bulbs (Tasmota / fixtures)

Fixture-level control of Zigbee Light Link bulbs on the same `tasmota_zigbee` bridge. Schedule and manual override are **per fixture**; individual bulbs only report `deviceState`. At fixture brightness `1` with two or more bulbs, the secondary bulb is turned off to further dim the fixture.

Config lives under `bulbAutomation` in `env.config.js` (`fixtures`, per-fixture `schedules`, `manualOverrideMs`, `timezone`). Example fixture id: `bathroom` with bulbs `0x16EE` (primary) and `0x2DDC` (secondary; off at 1% brightness).

### `GET /bulbs`

**Auth:** JWT + `NORMAL_USER`.

**Behavior:** Returns all fixtures. Runs reconcile-on-read (pushes `ZbSend` when cached device state mismatches desired).

**Response `200`:**

```json
{
  "device": "tasmota_zigbee",
  "fixtures": [
    {
      "fixtureId": "bathroom",
      "bulbs": ["0x16EE", "0x2DDC"],
      "enabled": true,
      "targetState": { "brightness": 80, "colour": 5500 },
      "overrideState": null,
      "overrideExpiry": null,
      "desiredState": { "brightness": 80, "colour": 5500 },
      "deviceStateByBulb": {
        "0x16EE": {
          "brightness": 80,
          "colour": 5500,
          "power": "on",
          "lastUpdateMs": 1712000000000,
          "linkQuality": 100
        },
        "0x2DDC": {
          "brightness": null,
          "colour": null,
          "power": null,
          "lastUpdateMs": null,
          "linkQuality": null
        }
      },
      "lastPushAtMs": 1712000001000
    }
  ]
}
```

`colour: 0` means red (RGB mode); any positive value is Kelvin (white CT).

**Sample:**

```javascript
const { fixtures } = await api('/bulbs', { token: accessToken });
```

### `GET /bulbs/:fixtureId`

**Auth:** JWT + `NORMAL_USER`.

**Behavior:** One fixture snapshot; reconcile-on-read.

**Responses:**

- `200` — same object shape as one entry in `fixtures` above
- `404` — `{ "error": "unknown_fixture" }`

**Sample:**

```javascript
const fixture = await api('/bulbs/bathroom', { token: accessToken });
```

### `POST /bulbs/:fixtureId`

**Auth:** JWT + only user id `0` (`onlyUserCanDoThisAction(0)`).

**Body:**

```json
{
  "brightness": 40,
  "colour": 4000
}
```

- `brightness` — integer `0`–`100`
- `colour` — `0` for red RGB, or Kelvin `2000`–`6500` for white CT

**Behavior:** Sets a fixture-level `overrideState` for `manualOverrideMs` (default 90 minutes), then pushes commands immediately. After expiry, automation returns to that fixture’s schedule `targetState`.

**Responses:**

- `200` — updated fixture snapshot
- `400` — `{ "error": "invalid_brightness" | "invalid_colour", "message": "..." }`
- `404` — `{ "error": "unknown_fixture" }`

**Sample:**

```javascript
await api('/bulbs/bathroom', {
  method: 'POST',
  token: accessToken,
  body: { brightness: 1, colour: 0 },
});
```

### `POST /bulbs/:fixtureId/reset`

**Auth:** JWT + only user id `0` (`onlyUserCanDoThisAction(0)`).

**Behavior:** Clears that fixture’s `overrideState` / `overrideExpiry`, refreshes `targetState` from the fixture’s schedule, then pushes commands for the schedule desired immediately.

**Responses:**

- `200` — fixture snapshot (`overrideState` / `overrideExpiry` null; `desiredState` matches `targetState`)
- `404` — `{ "error": "unknown_fixture" }`

**Sample:**

```javascript
await api('/bulbs/bathroom/reset', { method: 'POST', token: accessToken });
```

---

## Devices — Zigbee remotes (buttons / dimmers)

Config-driven Zigbee remotes on the same `tasmota_zigbee` bridge. There is **no HTTP API**; presses and turns are handled over MQTT when `zigbeeControls` is enabled in `env.config.js`.

### Config (`zigbeeControls`)

| Field | Meaning |
|-------|---------|
| `enabled` | Master switch (default `true` when the block exists) |
| `dimmerStepPerPercent` | DimmerStep units per 1% brightness (default `10`; ~1000 units ≈ one revolution) |
| `colorTempFullScaleSteps` | Hardware steps for a full colour-axis revolution (default `1000`) |
| `devices` | Map of Zigbee short address → device spec |

**Device types**

- `button` — press keys only: `single` / `double` / `long`
- `dimmer` — press keys plus relative turn control via `fixtureId`

**Press action objects** (exactly one per key; omit unused keys):

| `type` | Fields | Effect |
|--------|--------|--------|
| `bulb` | `fixtureId`, `brightness` (1–100), `colour` (`0` = red, or Kelvin) | Manual fixture override + immediate push |
| `bulbReset` | `fixtureId` | Clear override → schedule + immediate push |
| `vent` | `percent` (0–100) and either `motorId` or `room` (`roomVentMap` label; `motorId` wins if both set) | Set vent position + record manual override |

**Event mapping**

| Telegram | Event |
|----------|--------|
| `LidlPower` 0 / 1 / 2 | `single` / `double` / `long` (e.g. Lidl button `0xFB8C`) |
| `Power: 2` | `single` (dimmer press, e.g. `0x891A`) |
| `DimmerStepUp` / `DimmerStepDown` | Relative brightness on the dimmer’s `fixtureId` (clamped **1–100**, never 0) |
| `ColorTempStepUp` / `ColorTempStepDown` | Relative colour on that fixture |

**Colour axis (hold + turn):** one full revolution spans virtual positions `0…3310` — `0–10` → red (`colour: 0`), then Kelvin `2700–6000`. Turning down through 2700K enters red; turning up from red exits into 2700K. Rapid step telegrams are coalesced (~120ms) into one override push.

**Example**

```js
"zigbeeControls": {
  "enabled": true,
  "dimmerStepPerPercent": 10,
  "colorTempFullScaleSteps": 1000,
  "devices": {
    "0xFB8C": {
      "type": "button",
      "single": { "type": "vent", "room": "Peter's Room", "percent": 100 },
      "double": { "type": "vent", "motorId": 0, "percent": 50 },
      "long": { "type": "vent", "room": "Peter's Room", "percent": 0 }
    },
    "0x891A": {
      "type": "dimmer",
      "fixtureId": "bathroom",
      "single": { "type": "bulb", "fixtureId": "bathroom", "brightness": 1, "colour": 3000 },
      "long": { "type": "bulbReset", "fixtureId": "bathroom" }
    }
  }
}
```

---

## Devices — Lights (eWelink)

Path suffix is taken from the URL **after the first path segment** (device **name** for lookup; device **id** string for status and power). Use `encodeURIComponent` for names with spaces.

### `GET /elookup/:deviceName`

**Auth:** JWT + `NORMAL_USER`.

**Response `200`:**  
`{ "success": true, "device": "<ewelinkDeviceId>", "error": "" }`  
or  
`{ "success": false, "device": false, "error": "not_found" }`

**Sample:**

```javascript
const name = encodeURIComponent('Office Lamp');
const info = await api(`/elookup/${name}`, { token: accessToken });
```

### `GET /estatus/:deviceId`

**Auth:** JWT + `NORMAL_USER`.

**Response `200`:** `{ "success": true, "error": "", ... }` merged with eWelink `getDevicePowerState` result.

**Sample:**

```javascript
const status = await api(`/estatus/${deviceId}`, { token: accessToken });
```

### `POST /eturnon/:deviceId` and `POST /eturnoff/:deviceId`

**Auth:** JWT + `NORMAL_USER`.

**Response `200`:** `{ "success": true, "error": "", ... }` merged with eWelink `setDevicePowerState` result.

**Sample:**

```javascript
await api(`/eturnon/${deviceId}`, { method: 'POST', token: accessToken });
```

---

## Devices — Vents

### `GET /vents`

**Auth:** JWT + `NORMAL_USER`.

**Response `200`:** `{ "success": true, "error": "", "status": <cachedPayload> }`  
`status` is whatever the vent client last cached from hardware (may be `null` until first poll).

**Sample:**

```javascript
const { status } = await api('/vents', { token: accessToken });
```

### `GET /vents/actions`

**Auth:** JWT + `NORMAL_USER`.

**Behavior:** Returns automation dashboard data plus action log (newest first). On dashboard failure, still returns `200` with Actions and safe defaults for dashboard fields.

**Response `200`:** includes at least:

- `success`, `error`
- `actions` — array of log entries
- `mode`, `automationEnabled`, `controllerRoom`, `controllerTempC`, `targets`, `rooms`, `lastAutomationEvaluationAt`, `statistics` (when automation runs)

**Sample:**

```javascript
const dashboard = await api('/vents/actions', { token: accessToken });
```

### `POST /vents/:motorId/:percent`

**Auth:** JWT + `NORMAL_USER`.

**Path:** `motorId` — numeric id as string; `percent` — **0–100** (clamped and rounded server-side). Example: `/vents/2/75`.

**Responses:**

- `200` — `{ "success": true, "error": "", "status": <cachedPayload> }`
- `400` — `{ "success": false, "error": "bad_route", "status": "{}" }`
- `500` — `{ "success": false, "error": "offline", "status": ... }`

**Sample:**

```javascript
await api('/vents/0/100', { method: 'POST', token: accessToken });
```

---

## Devices — Server control (Sonoff + companion HTTP service)

All routes require JWT and **`onlyUserCanDoThisAction(0)`**.

### `GET /server`

**Behavior:** Requests MQTT state updates and, when power is `on`, may query a companion HTTP service for shutdown flags.

**Response `200`:**

```json
{
  "success": true,
  "error": "",
  "state": "on",
  "consumption": {},
  "prevent": 0,
  "immediate": 0,
  "controller": "online"
}
```

- `500` — `{ "success": false, "error": "offline", "status": "{}" }` when companion fetch fails in some branches.

**Sample:**

```javascript
const server = await api('/server', { token: accessToken });
```

### `POST /server/boot`

**Behavior:** If state is already `on` or `unknown`, responds `500` with `error: "already_on"`. Otherwise sends MQTT POWER on.

**Sample:**

```javascript
await api('/server/boot', { method: 'POST', token: accessToken });
```

### `POST /server/shutdown`

**Behavior:** If already `off` or `unknown`, `500` with `error: "already_off"`. Otherwise calls companion `setimmediate` endpoint and returns updated flags.

**Sample:**

```javascript
await api('/server/shutdown', { method: 'POST', token: accessToken });
```

### `POST /server/preventshutdown/:state`

**Path:** `:state` is `0` or `1` (string digit). Calls companion `set?state=...`.

**Response `200`:** same general shape as `GET /server`.

**Sample:**

```javascript
await api('/server/preventshutdown/1', { method: 'POST', token: accessToken });
```

---

## Catch-all

Any path not matched above hits `GET /*`, which responds with plain text **`No Route!`** (not JSON).

---

## Security notes for web apps

- Prefer **HTTPS** in production so JWTs are not sent in clear text.
- The **GET** speaker URLs and **POST /users** are weakly protected or unauthenticated; treat your network and reverse proxy accordingly.
- Store **`accessToken`** in memory; avoid localStorage if XSS is a concern (use secure httpOnly cookies only if you add a BFF/cookie-based flow — this API is Bearer-oriented).
- Refresh tokens must be sent with a valid JWT on `/auth/refresh`; plan token rotation before `jwt_expiration_in_seconds` from config.
