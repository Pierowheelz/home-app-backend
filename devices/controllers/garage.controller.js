let currentState = 'unknown';
const onMessage = ( msgJson ) => {
    console.log('garage message received.');
    // Get Door state
    let openSwitchPower = msgJson.POWER2 ?? null;
    let closedSwitchPower = msgJson.POWER3 ?? null;
    
    if( null === openSwitchPower && null === closedSwitchPower ){
        console.log('Door state unknown.');
        //currentState = 'unknown';
        return;
    }
    
    if( "ON" == openSwitchPower ){
        currentState = 'open';
    } else if( "ON" == closedSwitchPower ){
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
