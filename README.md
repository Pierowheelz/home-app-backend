<!-- ABOUT THE PROJECT -->
## About The Project

This is a NodeJS Based home-controller API which I built in my spare time. It can interface with Mosquitto, or HTTP based home automation devices. It is designed as a boilerplate, not a ready to go system. Build in support for your own devices in devices/controllers.
NOTE: this is just the backend API. Frontend is a separate repo.

Pages, nav, and which device cards appear in the app are defined here in `env.config.js` (`devices` + `appLayout`). The frontend loads that via `GET /layout` after login, so a second house can look completely different without a frontend rebuild.

### Built With

* NodeJS
* Docker


<!-- GETTING STARTED -->
## Getting Started

Copy `common/config/env.config.js.sample` to `common/config/env.config.js` and adjust values, or create `common/config/env.config.js` with content like the below:

```javascript
module.exports = {
    "port": 3600,
    "appEndpoint": "https://example.com:3600",
    "apiEndpoint": "https://example.com:3600",
    "ssl_cert": "/etc/letsencrypt/live/example.com/cert.pem",
    "ssl_key": "/etc/letsencrypt/live/example.com/privkey.pem",
    "ca_cert": "/etc/letsencrypt/live/example.com/fullchain.pem",
    "jwt_secret": "replace-with-a-long-random-secret",
    "jwt_expiration_in_seconds": 36000,
    "ewelink_email": "john@example.com",
    "ewelink_password": "your-ewelink-password",
    "ewelink_region": "us",
    "mqtt": {
        "url": "localhost:1883",
        "username": "",
        "password": ""
    },
    "environment": "prod",
    "devices": {
        "garage": { "mqttName": "tas_garage" },
        "speakers": { "mqttName": "sonoff_speakers" },
        "blinds": { "baseUrl": "http://192.168.2.102" },
        "server": { "mqttName": "sonoff_server", "companionBaseUrl": "http://192.168.1.77:8200" }
    },
    "appLayout": { /* pages, nav, widgets: copy from env.config.js.sample */ },
    "ventAutomation": {
        "enabled": true,
        "coolTargetC": 23,
        "heatTargetC": 21,
        "roomHysteresisC": 0.5,
        "manualOverrideMs": 3600000,
        "roomTargetOverrideDurationMs": 72000000,
        "controllerRoomName": "Stairwell",
        "ventBaseUrl": "http://192.168.2.110",
        "ventOpenRaw": 100,
        "ventClosedRaw": 0,
        "roomVentMap": {
            "Guest Room": 2,
            "Peter's Room": 0,
            "Burton's Room": 1
        },
        "zigbeeSensorMap": {
            "0x954D": "Guest Room",
            "0xD7D5": "Stairwell",
            "0x9BBA": "Stairwell (alt)",
            "0xA33F": "Peter's Room",
            "0x8728": "Peter's Room (alt)",
            "0x2047": "Burton's Room"
        },
        "actionLogRetentionMs": 172800000
    },
    "permissionLevels": {
        "NORMAL_USER": 1,
        "ADMIN_USER": 4096
    },
    "users": [
        {
            _id: 0,
            firstName: "John",
            lastName: "Smith",
            email: "john@example.com",
            password: "...",
            permissionLevel: 1
        }
    ]
};
```

### Configuration variables

| Key | Purpose |
|-----|---------|
| `port` | HTTP(S) listen port. |
| `appEndpoint` / `apiEndpoint` | Public base URLs used by the app (scheme, host, port). |
| `ssl_cert` / `ssl_key` | TLS certificate and private key paths (empty strings if not using HTTPS). |
| `ca_cert` | Optional CA / full chain path for TLS (empty if unused). |
| `jwt_secret` / `jwt_expiration_in_seconds` | JWT signing secret and token lifetime. |
| `ewelink_email` / `ewelink_password` / `ewelink_region` | eWeLink account credentials and API region (e.g. `us`, `eu`, `cn`, `as`, `au`). |
| `mqtt.url` | Broker host and port (e.g. `192.168.1.1:1883`). |
| `mqtt.username` / `mqtt.password` | Broker auth (empty if anonymous). |
| `environment` | Runtime label (e.g. `dev`, `prod`). |
| `devices` | Optional singleton hardware. Presence of a key wires that device (MQTT/HTTP). See below. |
| `appLayout` | Frontend pages, sidebar, and widget layout served by `GET /layout`. See below. |
| `ventAutomation` | Optional vent automation: targets, hysteresis, manual override window, controller room name, vent HTTP base URL(s) (`ventBaseUrl` string or array), open/closed command values, room-to-vent map (`roomVentMap` number or `{ motorId, motorControllerId?, externalId? }`), action log retention, and optional HVAC Zigbee power sensor (see below). |
| `matter` | Optional Matter bridge for Google Home: pairing passcode / discriminator, test vendor / product id, storage path, and which devices to expose (see below). |
| `permissionLevels` | Numeric role flags (`NORMAL_USER`, `ADMIN_USER`). |
| `users` | Seed users; `password` must be the server-encoded hash (see below). |

The password can be generated from the "Add User" route. POST to /users with the below:
```JSON
{
    "firstName": "John",
    "lastName": "Smith",
    "email": "user@example.com",
    "password": "Y0urPa$$w0rd",
    "permissionLevel": 1
}
```
The terminal will display the encoded password which you can add to your "users" key in env.config.js.

### Devices and app layout

Copy `common/config/env.config.js.sample` for a full working layout. Restart the API after edits. No frontend rebuild unless you add a new widget *type* in code.

**`devices`.** Omit a key to leave that hardware unwired (no MQTT subscribe, no HTTP routes). Vents and Zigbee bulbs stay under `ventAutomation` / `bulbAutomation`.

| Key | Fields |
|-----|--------|
| `garage` | `mqttName` (Tasmota topic root, e.g. `tas_garage`) |
| `speakers` | `mqttName` |
| `blinds` | `baseUrl` (controller origin; `?a=1&b=1\|2\|5` is fixed in code) |
| `server` | `mqttName`, `companionBaseUrl` |

**`appLayout.pages`.** Each page:

- `id`, `path` (one URL segment, e.g. `/office`; `/` is home)
- `showInNav`, `navName`, `miniName`
- `visibleToUserIds`: omit for everyone, or `[0]` / `[1]` to match `users[]._id`
- `rows`: `{ className?, widgets: [...] }`

Widgets take `type`, optional `col` (`{ sm, md, lg, xl }`), and type-specific props:

| `type` | Props |
|--------|--------|
| `pageLink` | `pageId`, `title`, `button`, `icon`, `color` (home tiles) |
| `vent` | `deviceId`, `title` (title must match a `roomVentMap` room) |
| `ventController` / `ventSensorRooms` | none |
| `lightFixtures` | optional `titles` map (`{ bathroom: "Bathroom" }`) |
| `speakers` / `garage` / `blinds` / `server` | none |

Icon keys: `tachometer`, `bedEmpty`, `garage`, `blinds`, `server`, `wind`, `lightbulb`. Colors are Bootstrap gradient names (`info`, `primary`, `warning`, `dark`, `default`).

`pageLink` tiles pointing at a page the user cannot see are dropped automatically, as are widgets whose `devices.*` key is missing.

### HVAC power sensor (Tuya Zigbee PJ-1203A)

Vent automation can optionally gate itself on whether the HVAC is actively drawing power, using a Tuya Zigbee energy meter (TS0601 / `_TZE284_cjbofhxw`, a.k.a. PJ-1203A) clamped onto the HVAC feed and paired to a Tasmota Zigbee bridge. Relevant config keys in `ventAutomation`:

| Key | Purpose |
|-----|---------|
| `hvacPowerSensorZigbeeAddr` | Short address of the meter on the Tasmota bridge (e.g. `0x98C5`). Empty string disables power-based gating. |
| `hvacPowerActiveThresholdW` | Minimum instantaneous watts at which the HVAC is considered "running". |
| `hvacPowerStaleAfterMs` | After this many ms without a fresh reading, power data is treated as unknown (fails open so automation still runs). |

**One-time Tasmota bridge setup.** The `_TZE284_cjbofhxw` firmware will not emit any Tuya datapoints (voltage / current / power / kWh) until the coordinator acknowledges its `mcuGatewayConnectionStatus` heartbeats (Tuya cluster `0xEF00`, command `0x25`). Tasmota doesn't auto-respond to this command, so you must install a persistent rule on the bridge once — it survives reboots. Replace `0x98C5` with your meter's short address:

```
Rule1 ON ZbReceived#0x98C5#EF00?25 DO ZbSend {"Device":"0x98C5","Endpoint":1,"Send":"EF00!25/%value%0100"} ENDON
Rule1 1
```

Verify on `tele/<bridge>/SENSOR` that you start seeing real datapoints alongside the `EF00?25` heartbeats:

- `EF00/0213` — power, deci-watts (value ÷ 10 = W) — this is the one `vent.automation.service` consumes.
- `EF00/0214` — voltage, deci-volts (value ÷ 10 = V).
- `EF00/0212` — current, mA.

If only `EF00?25` keeps arriving and nothing with a `/`, the rule hasn't taken effect; re-run the two commands above and confirm the bridge log shows `RUL: ZBRECEIVED#<addr>#EF00?25 performs "ZbSend ..."` on every heartbeat.

### Google Home (Matter bridge)

With `matter.enabled`, the API also runs a Matter bridge. Google Home controls the devices locally through a Nest hub on the same network, so it needs no cloud integration or public endpoint.

| `matter` key | Shows up as | Supports |
|-----|---------|---------|
| `bulbFixtures` | Light (one per fixture) | On/off, brightness, white colour temperature (2000–6500 K). Brightness / colour changes set a manual override exactly like `POST /bulbs/:fixtureId`; on/off matches `POST /bulbs/:fixtureId/power`. Red (`colour: 0`) is not exposed. |
| `speakers` | Plug | On / off. |
| `blinds` | Blinds | Open / close / stop. The controller has no position feedback, so the position is assumed fully open / closed after each command, and partial percentages round to the nearest end. |
| `server` | Plug | **On only.** "Off" is rejected, so "Hey Google, turn everything off" can't shut the server down. |
| `roomSensors` | Temperature + humidity sensor (one per room) | Read-only. Keys are room names from `ventAutomation.zigbeeSensorMap`; readings are the same merged values as the vent dashboard (a room's "(alt)" sensor is combined with its primary). Shows offline after an hour with no reading. |

Omit a key to leave that device out. `speakers` / `blinds` / `server` also need their `devices.*` entry. Changes made elsewhere (app, schedules, Zigbee remotes, physical buttons) reach Google Home within ~2 s.

**Requirements**

- **Node 20+** (the Docker image uses `node:22`).
- **Host networking.** Matter uses mDNS and IPv6 on the LAN, which Docker's default bridge network blocks. Run the container with `--network host` (see [Raspberry Pi](#raspberry-pi-32-bit-arm-v7)).
- **IPv6 enabled on the host.** IPv6 from your internet provider is *not* needed: Matter only needs the automatic link-local (`fe80::`) addresses, which work on an IPv4-only network. Check with `ip -6 addr show eth0`. If there is no `fe80::` address, IPv6 is disabled in the kernel (`sysctl net.ipv6.conf.all.disable_ipv6` is `1`); re-enable it.
- **Google Home Developer Console project.** Google Home only pairs an uncertified device when its vendor / product id is registered to your account. At [console.home.google.com](https://console.home.google.com), create a project and add a Matter integration with Vendor ID `0xFFF1` and Product ID `0x8000` (or whatever `vendorId` / `productId` you configured). Use the same Google account as the Google Home app.

**Pairing**

1. Set `matter.enabled` to `true`, change `passcode` from the default, and restart.
2. The log prints a pairing QR code, a link to it, and an 11-digit manual code (also returned by `GET /matter`).
3. In the Google Home app (phone on the same network): **Devices → Add → Matter-enabled device**, then scan the QR code or enter the manual code. Accept the "uncertified device" prompt.
4. Assign the bridged devices to rooms.

Pairing data lives in `matter.storagePath` (default `/config/matter` in Docker, so it survives image updates). Deleting it means removing the bridge from Google Home and pairing again.

## Installation

1. Clone the repo
   ```sh
   git clone https://github.com/Pierowheelz/home-app-backend.git
   ```
2. Install NPM packages
   ```sh
   npm install
   ```
3. Setup `env.config.js` (see getting started)

### Docker installation
Create a config directory somewhere: (eg. `/opt/home-app/config` or `/mnt/user/appdata/home-app-backend/` for Unraid).
Add your env.config.js into this folder.
Install via docker.

Ensure /config volume was created. (create it manually if it wasn't eg. `/config` > `/mnt/user/appdata/home-app-backend/` ).

#### Raspberry Pi (32-bit ARM v7)

On Raspberry Pi OS (or other `linux/arm/v7` hosts), run the image with explicit platform, TLS keys, and config bind mounts. Host networking is required for the Matter bridge; the API then listens directly on the host at `port` from `env.config.js` (`-p` mappings are ignored).

```sh
docker pull pierowheelz/home-app-backend:latest 
docker run -d \
  --name pwhomecontroller \
  --platform linux/arm/v7 \
  --network host \
  -v /etc/letsencrypt:/keys \
  -v /opt/home-app/config:/config \
  --restart=unless-stopped \
  pierowheelz/home-app-backend:latest
```

With host networking, other containers can no longer reach the API by container name (e.g. a Cloudflare Tunnel service of `http://pwhomecontroller:3800`). Point them at the host instead: the Pi's LAN IP (e.g. `http://192.168.1.10:3800`), or `http://host.docker.internal:3800` after adding `--add-host=host.docker.internal:host-gateway` to that container.

Adjust volume paths and `env.config.js` TLS paths as needed (for example, if certificates live under `/keys/live/example.com/` inside the container, point `ssl_*` and `ca_cert` in config accordingly).


## Development
Clone to your local `git clone https://github.com/Pierowheelz/home-app-backend.git`. 
Install with `npm i`. 
Start the server with `npm start` (note: no hot reload, so ctrl+c and restart after changes). 

### Docker builder setup
Install Docker Desktop on PC (or run this on a Linux box with `docker` installed).
Clone repo to a folder somewhere.
Open a terminal in that folder and run.
```sh
docker buildx create --name home-app-backend
docker buildx use home-app-backend
docker buildx inspect --bootstrap
```
Then proceed to build and deploy.

Note: If not logged in to Docker Hub, run: `docker login -u pierowheelz` using Access Token generated from Docker Hub account (Account Settings > Security).


### Build and deploy to Docker Hub

Run:
```sh
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t pierowheelz/home-app-backend:latest --push .
```


<!-- LICENSE -->
## License

Distributed under the MIT License.
