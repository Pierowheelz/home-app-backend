const GarageController = require('./controllers/garage.controller');
const BlindsController = require('./controllers/blinds.controller');
const SpeakersController = require('./controllers/speakers.controller');
const LightsController = require('./controllers/lights.controller');
const VentsController = require('./controllers/vents.controller');

const PermissionMiddleware = require('../common/middlewares/auth.permission.middleware');
const ValidationMiddleware = require('../common/middlewares/auth.validation.middleware');
const config = require('../common/config/env.config');

const USER = config.permissionLevels.NORMAL_USER;

const MqttHandler = require('./mqttHandler');

const mqttSession = new MqttHandler();
GarageController.attachMqtt( mqttSession );
SpeakersController.attachMqtt( mqttSession );
mqttSession.connect();

exports.routesConfig = function (app) {
    // Garage
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
    
    // Blinds
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
    
    // Speakers
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
    app.post('/vents/*/*', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        VentsController.updateStatus
    ]);
};
