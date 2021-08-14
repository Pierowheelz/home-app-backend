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

<!-- LICENSE -->
## License

Distributed under the MIT License.
