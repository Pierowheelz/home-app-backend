const config = require('./common/config/env.config.js');
const express = require('express');
// const https = require('https')
const bodyParser = require('body-parser');
// const WebSocket = require('ws');

const AuthorizationRouter = require('./authorization/routes.config');
const UsersRouter = require('./users/routes.config');
const DevicesRouter = require('./devices/routes.config');
// const wsPort = 80801;

// const hskey = fs.readFileSync('mywebsite-key.pem');
// const hscert = fs.readFileSync('mywebsite-cert.pem')
// const options = {
//     key: hskey,
//     cert: hscert
// };

const app = express();
// const server = https.createServer(options,app);

app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,POST');
    res.header('Access-Control-Expose-Headers', 'Content-Length');
    res.header('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type, X-Requested-With, Range');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    } else {
        return next();
    }
});

app.use(bodyParser.json());
AuthorizationRouter.routesConfig(app);
UsersRouter.routesConfig(app);
DevicesRouter.routesConfig(app);


app.listen(config.port, function () {
    console.log('app listening at port %s', config.port);
});
