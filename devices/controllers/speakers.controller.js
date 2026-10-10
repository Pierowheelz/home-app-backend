const mqtt = require('mqtt');

let currentState = 'unknown';
const onMessage = ( msgJson ) => {
    console.log('speakers message received.');
    // Get Speakers state
    let speakersPower = msgJson.POWER ?? null;
    
    if( null === speakersPower ){
        console.log('Power state unknown.');
        //currentState = 'unknown';
        return;
    }
    
    if( "ON" == speakersPower ){
        currentState = 'on';
    } else {
        currentState = 'off';
    }
};

let sendMqttCommand = ( msg, data ) => {
    console.log('Failed to send message. Mqtt Controller not yet attached', msg, data);
    return false;
};

exports.attachMqtt = ( mqttController ) => {
    mqttController.addDevice( appconfig.devices.speakers.mqttName, onMessage );
    
    sendMqttCommand = mqttController.getCommandFunction();
};

exports.getState = (req, res) => {
    console.log('Get speakers state: ',currentState);
    res.status(200).send({state:currentState});
};

/**
 * @returns {'on'|'off'|'unknown'} Last relay state reported over MQTT.
 */
exports.getPowerState = () => currentState;

/**
 * Send a relay POWER command.
 * @param {boolean} on
 * @returns {boolean} False when MQTT is not attached / connected.
 */
exports.setPower = ( on ) => {
    const mqttName = appconfig.devices.speakers.mqttName;
    return sendMqttCommand( 'cmnd/' + mqttName + '/POWER', on ? '1' : '0' );
};

exports.turnOn = (req, res) => {
    const result = exports.setPower( true );
    let resultCode = result ? 200 : 503;
    
    res.status(resultCode).send(result);
};

exports.turnOff = (req, res) => {
    const result = exports.setPower( false );
    let resultCode = result ? 200 : 503;
    
    res.status(resultCode).send(result);
};
