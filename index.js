const fs = require('fs');
const args = process.argv;
const isDocker = args[2] ?? '';
global.appconfig = {};
if( 'docker' == isDocker ){
    appconfig = require('/config/env.config.js');
} else {
    appconfig = require('./common/config/env.config.js');
}
const express = require('express');
const https = require('https');
const bodyParser = require('body-parser');
// const WebSocket = require('ws');

const AuthorizationRouter = require('./authorization/routes.config');
const UsersRouter = require('./users/routes.config');
const DevicesRouter = require('./devices/routes.config');
// const wsPort = 80801;

const hskey = fs.readFileSync( appconfig.ssl_key );
const hscert = fs.readFileSync( appconfig.ssl_cert );
const cacert = fs.readFileSync( appconfig.ca_cert );
const options = {
    key: hskey,
    cert: hscert,
    ca: cacert,
    timeout: 15000
};

const app = express();

app.use(function (req, res, next) {
    req.setTimeout(15001);
    
    console.log('Request received...');
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,POST,OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Length');
    res.header('Access-Control-Allow-Headers', 'accept,authorization,content-type,x-requested-with,range,credentials');
    res.header('Cache-Control', 'public, max-age=0');
    //res.header('Access-Control-Expose-Headers', 'Content-Length');
    if (req.method === 'OPTIONS') {
        console.log('Options request received.');
        //res.sendStatus(200);
        res.status(200).send('ok');
        return;
    }
    
    return next();
});

app.use(bodyParser.json());
AuthorizationRouter.routesConfig(app);
UsersRouter.routesConfig(app);
DevicesRouter.routesConfig(app);

app.get('/*', (req, res) => {
    console.log('Error: failed to parse request');
    
    res.send('No Route!');
    return;
});

const server = https.createServer(options,app);
server.listen(appconfig.port, function () {
    console.log('app listening at port %s', appconfig.port);
});
