<!-- ABOUT THE PROJECT -->
## About The Project

This is a NodeJS Based home-controller project which I built in my spare time. It can interface with Mosquitto, or HTTP based home automation devices. It is designed as a boilerplate, not a ready to go system. Build in support for your own devices in devices/controllers.
NOTE: this is just the backend. Frontend is a separate repo.

### Built With

* [NodeJS](https://getbootstrap.com)


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
        "stairwellRoomName": "Stairwell",
        "ventBaseUrl": "http://192.168.2.110",
        "ventOpenRaw": 100,
        "ventClosedRaw": 0,
        "roomVentMap": {
            "Guest Room": 2,
            "Peter's Room": 0,
            "Burton's Room": 1
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
| `ventAutomation` | Optional vent automation: targets, hysteresis, manual override window, stairwell room name, vent HTTP base URL, open/closed raw positions, room-to-vent index map, action log retention. |
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

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/your_username_/Project-Name.git
   ```
2. Install NPM packages
   ```sh
   npm install
   ```
3. Setup `env.config.js` (see getting started)

### Docker installation
Create directory: `/mnt/user/appdata/home-app-backend/`.
Add your env.config.js into this folder.
Install via docker.
Ensure /config volume was created. (create it manually if it wasn't `/config` > `/mnt/user/appdata/home-app-backend/` ).

### Docker builder setup
Install Docker Desktop on PC.
Clone repo to a folder somewhere.
Open a terminal in that folder and run.
```sh
docker buildx create --name mybuilder
docker buildx use mybuilder
docker buildx inspect --bootstrap
```
Then proceed to build and push.

Note: If not logged in to Docker Hub, run: `docker login -u pierowheelz` using Access Token generated from Docker Hub account (Account Settings > Security).


### Docker build
Master build is on Peter-PC at: `Documents/apps/home-app-backend`.

Run:
```sh
git pull
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t pierowheelz/home-app-backend:latest --push .
```


<!-- LICENSE -->
## License

Distributed under the MIT License.
