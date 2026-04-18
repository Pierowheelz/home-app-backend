<!-- ABOUT THE PROJECT -->
## About The Project

This is a NodeJS Based home-controller API which I built in my spare time. It can interface with Mosquitto, or HTTP based home automation devices. It is designed as a boilerplate, not a ready to go system. Build in support for your own devices in devices/controllers.
NOTE: this is just the backend API. Frontend is a separate repo.

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
| `ventAutomation` | Optional vent automation: targets, hysteresis, manual override window, controller room name, vent HTTP base URL, open/closed command endpoints, room-to-vent index map, action log retention, and optional HVAC Zigbee power sensor (see below). |
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

On Raspberry Pi OS (or other `linux/arm/v7` hosts), run the image with explicit platform, TLS keys, and config bind mounts. The container listens on **3800**; the example maps host **3600** to that port (match `port` in `env.config.js`).

```sh
docker pull pierowheelz/home-app-backend:latest 
docker run -d \
  --name pwhomecontroller \
  --platform linux/arm/v7 \
  -p 3600:3800 \
  -v /etc/letsencrypt:/keys \
  -v /opt/home-app/config:/config \
  --restart=unless-stopped \
  -e NODE_VERSION="16.15.0" \
  -e YARN_VERSION="1.22.18" \
  pierowheelz/home-app-backend:latest
```

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
