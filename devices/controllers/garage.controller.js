const mqtt = require('mqtt');

exports.getState = (req, res) => {
    // get state of garage door ('open', 'closed', 'middle', 'unknown')
    let currentState = 'unknown';
    const client = mqtt.connect('mqtt://127.0.0.1');
    
    client.on('error', (err) => {
        console.log(err);
        client.end();
        res.status(500).send({error:'offline'});
        return;
    });
    client.on('connect', () => {
        console.log('MQTT connected');
        client.subscribe('stat/tas_garage/#', (err) => {
            if (!err) {
                client.publish('cmnd/tas_garage/state', '1');
            }
        });
    });
    client.on('message', (topic, message) => {
        // message is Buffer
        console.log(topic, message.toString());
        
        // Decode message JSON
        let msgJson = {};
        try{
            msgJson = JSON.parse( message.toString() );
        } catch( err ){
            console.log('Failed to decode JSON message.');
            res.status(500).send({error:'json_error'});
            return;
        }
        client.end();
        
        // Get Door state
        let openSwitchPower = msgJson.POWER2 ?? null;
        let closedSwitchPower = msgJson.POWER3 ?? null;
        
        if( null === openSwitchPower && null === closedSwitchPower ){
            console.log('Door state unknown.');
            res.status(200).send({state:'unknown'});
            return;
        }
        
        if( "ON" == openSwitchPower ){
            currentState = 'open';
        } else if( "ON" == closedSwitchPower ){
            currentState = 'closed';
        } else {
            //currentState = 'middle';
            currentState = 'closed'; // Closed switch not yet implemented
        }
        
        res.status(200).send({state:currentState});
    });
};

exports.triggerButton = (req, res) => {
    let result = false;
    
    let currentState = 'unknown';
    const client = mqtt.connect('mqtt://127.0.0.1'); // Connect to MQTT server
    
    client.on('error', (err) => { // Handle connection error
        console.log(err);
        client.end();
        res.status(500).send({error:'offline'});
        return;
    });
    client.on('connect', () => { // On connection completed
        console.log('MQTT connected');
        client.publish('cmnd/tas_garage/POWER', '1'); // Tell the door to open (toggle power for input #1)
        result = true;
        res.status(200).send(result);
    });
};
