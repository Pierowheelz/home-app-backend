/** @typedef {{ Switch2?: string, Switch3?: string, POWER2?: string, POWER3?: string }} GarageSensorPayload */

let currentState = 'unknown';

/**
 * Updates door state from Tasmota SENSOR (Switch2/Switch3) or STAT-style (POWER2/POWER3) payloads.
 * @param {GarageSensorPayload} msgJson
 */
const onMessage = ( msgJson ) => {
    console.log('garage message received.');
    const openSwitchReading =
        msgJson.Switch2 ?? msgJson.POWER2 ?? null;
    const closedSwitchReading =
        msgJson.Switch3 ?? msgJson.POWER3 ?? null;
    
    if( null === openSwitchReading && null === closedSwitchReading ){
        console.log('Door state unknown.');
        //currentState = 'unknown';
        return;
    }
    
    if( "ON" == openSwitchReading ){
        currentState = 'open';
    } else if( "ON" == closedSwitchReading ){
        currentState = 'closed';
    } else {
        currentState = 'middle';
        //currentState = 'closed'; // Closed switch not yet implemented
    }
};

let sendMqttCommand = ( msg, data ) => {
    console.log('Failed to send message. Mqtt Controller not yet attached', msg, data);
    return false;
};

exports.attachMqtt = ( mqttController ) => {
    mqttController.addDevice( 'tas_garage', onMessage );
    
    sendMqttCommand = mqttController.getCommandFunction();
};

exports.getState = (req, res) => {
    res.status(200).send({state:currentState});
};

exports.triggerButton = (req, res) => {
    console.log('garage trigger button.');
    const result = sendMqttCommand( 'cmnd/tas_garage/POWER', '1' );
    let resultCode = result ? 200 : 503;
    
    res.status(resultCode).send(result);
};
