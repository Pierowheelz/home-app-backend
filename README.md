<!-- ABOUT THE PROJECT -->
## About The Project

This is a NodeJS Based home-controller project which I built in my spare time. It can interface with Mosquitto, or HTTP based home automation devices. It is designed as a boilerplate, not a ready to go system. Build in support for your own devices in devices/controllers.
NOTE: this is just the backend. Frontend is a separate repo.

### Built With

* [NodeJS](https://getbootstrap.com)


<!-- GETTING STARTED -->
## Getting Started

Create a file common/config/env.config.js with content like the below:
```JS
module.exports = {
    "port": 3600,
    "appEndpoint": "http://localhost:3600",
    "apiEndpoint": "http://localhost:3600",
    "ssl_cert": "/etc/letsencrypt/live/{your_domain}/cert.pem",
    "ssl_key": "/etc/letsencrypt/live/{your_domain}/privkey.pem",
    "jwt_secret": "myS3creT",
    "jwt_expiration_in_seconds": 36000,
    "environment": "dev",
    "permissionLevels": {
        "NORMAL_USER": 1
    },
    "users": {
        {
            _id: 0,
            firstName: "John",
            lastName: "Smith",
            email: "user@example.com",
            password: "...",
            permissionLevel: 1
        }
    }
};

```
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
