const GarageController = require('./controllers/garage.controller');
const BlindsController = require('./controllers/blinds.controller');
const SpeakersController = require('./controllers/speakers.controller');
const LightsController = require('./controllers/lights.controller');

const PermissionMiddleware = require('../common/middlewares/auth.permission.middleware');
const ValidationMiddleware = require('../common/middlewares/auth.validation.middleware');
const config = require('../common/config/env.config');

const USER = config.permissionLevels.NORMAL_USER;

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
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
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
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        SpeakersController.turnOn
    ]);
    app.post('/speakers/off', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        SpeakersController.turnOff
    ]);
    
    // Lights
    app.get('/lights', [
        ValidationMiddleware.validJWTNeeded,
        PermissionMiddleware.minimumPermissionLevelRequired(USER),
        LightsController.getStatus
    ]);
};
