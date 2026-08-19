const GarageController = require('./controllers/garage.controller');
const BlindsController = require('./controllers/blinds.controller');
const SpeakersController = require('./controllers/speakers.controller');
const LightsController = require('./controllers/lights.controller');
const VentsController = require('./controllers/vents.controller');
const ServerController = require('./controllers/server.controller');
const LayoutController = require('./controllers/layout.controller');
const TasmotaZigbeeController = require('./controllers/tasmota.zigbee.controller');
const TasmotaZigbeeBulbsController = require('./controllers/tasmota.zigbee.bulbs.controller');
const TasmotaZigbeeControlsController = require('./controllers/tasmota.zigbee.controls.controller');

const PermissionMiddleware = require('../common/middlewares/auth.permission.middleware');
const ValidationMiddleware = require('../common/middlewares/auth.validation.middleware');

const USER = appconfig.permissionLevels.NORMAL_USER;

const MqttHandler = require('./mqttHandler');

const devices = appconfig.devices || {};

const mqttSession = new MqttHandler();
if (devices.garage) {
    GarageController.attachMqtt( mqttSession );
}
if (devices.speakers) {
    SpeakersController.attachMqtt( mqttSession );
}
if (devices.server) {
    ServerController.attachMqtt( mqttSession );
}
TasmotaZigbeeController.attachMqtt( mqttSession );
TasmotaZigbeeBulbsController.attachMqtt( mqttSession );
TasmotaZigbeeControlsController.attachMqtt( mqttSession );
mqttSession.connect();

exports.routesConfig = function (app) {
    app.get('/layout', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        LayoutController.getLayout
    ]);

    if (devices.garage) {
        app.get('/garage', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.minimumPermissionLevelRequired(USER),
            GarageController.getState
        ]);
        app.post('/garage', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.minimumPermissionLevelRequired(USER),
            GarageController.triggerButton
        ]);
    }
    
    if (devices.blinds) {
        app.post('/blinds/open', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            BlindsController.openBlinds
        ]);
        app.post('/blinds/close', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            BlindsController.closeBlinds
        ]);
        app.post('/blinds/stop', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            BlindsController.stopBlinds
        ]);
    }
    
    if (devices.speakers) {
        app.get('/speakers', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.minimumPermissionLevelRequired(USER),
            SpeakersController.getState
        ]);
        app.post('/speakers/on', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            SpeakersController.turnOn
        ]);
        app.post('/speakers/off', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            SpeakersController.turnOff
        ]);
        app.get('/speakers/on/p7tvhtekg4942iw4tv', [
            SpeakersController.turnOn
        ]);
        app.get('/speakers/off/p7tvhtekg4942iw4tv', [
            SpeakersController.turnOff
        ]);
    }

    // Zigbee room temperatures (Tasmota bridge)
    app.get('/temperatures', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        TasmotaZigbeeController.getState
    ]);

    // Zigbee bulbs (Tasmota bridge, fixture-level)
    app.get('/bulbs', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        TasmotaZigbeeBulbsController.listFixtures
    ]);
    app.get('/bulbs/:fixtureId', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        TasmotaZigbeeBulbsController.getFixture
    ]);
    app.post('/bulbs/:fixtureId/reset', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
        TasmotaZigbeeBulbsController.resetFixture
    ]);
    app.post('/bulbs/:fixtureId', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
        TasmotaZigbeeBulbsController.setFixture
    ]);
    
    // Lights
    app.get('/elookup/*', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        LightsController.lookupDevice
    ]);
    app.get('/estatus/*', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        LightsController.getStatus
    ]);
    app.post('/eturnon/*', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        LightsController.turnOn
    ]);
    app.post('/eturnoff/*', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        LightsController.turnOff
    ]);
    
    // Vents
    app.get('/vents', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        VentsController.getStatus
    ]);
    app.get('/vents/actions', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        VentsController.getActionLog
    ]);
    app.post('/vents/room-target', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        VentsController.setRoomTarget
    ]);
    app.post('/vents/hvac-mode', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        VentsController.setHvacMode
    ]);
    app.post('/vents/*/*', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        VentsController.updateStatus
    ]);
    
    if (devices.server) {
        app.get('/server', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            ServerController.getState
        ]);
        app.post('/server/boot', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            ServerController.bootServer
        ]);
        app.post('/server/shutdown', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            ServerController.shutdownServer
        ]);
        app.post('/server/preventshutdown/*', [
            ValidationMiddleware.validJWTNeeded,
            PermissionMiddleware.onlyUserCanDoThisAction( 0 ),
            ServerController.togglePreventShutdown
        ]);
    }
};
