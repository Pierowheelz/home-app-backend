const mqtt = require('mqtt');

let currentState = 'unknown';
const onMessage = ( msgJson ) => {
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
    mqttController.addDevice( 'sonoff_speakers', onMessage );
    
    sendMqttCommand = mqttController.getCommandFunction();
};

exports.getState = (req, res) => {
    console.log('Get speakers state: ',currentState);
    res.status(200).send({state:currentState});
};

exports.turnOn = (req, res) => {
    const result = sendMqttCommand( 'cmnd/sonoff_speakers/POWER', '1' );
    let resultCode = result ? 200 : 503;
    
    res.status(resultCode).send(result);
};

exports.turnOff = (req, res) => {
    const result = sendMqttCommand( 'cmnd/sonoff_speakers/POWER', '0' );
    let resultCode = result ? 200 : 503;
    
    res.status(resultCode).send(result);
};
