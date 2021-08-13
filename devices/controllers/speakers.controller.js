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
        client.subscribe('stat/sonoff_speakers/#', (err) => {
            if (!err) {
                client.publish('cmnd/sonoff_speakers/state', '1');
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
        let speakersPower = msgJson.POWER ?? null;
        
        if( null === speakersPower ){
            console.log('Power state unknown.');
            res.status(200).send({state:'unknown'});
            return;
        }
        
        if( "ON" == speakersPower ){
            currentState = 'on';
        } else {
            currentState = 'off';
        }
        
        res.status(200).send({state:currentState});
    });
};

exports.turnOn = (req, res) => {
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
        client.publish('cmnd/sonoff_speakers/POWER', '1'); // Trigger power toggle (toggle power for input #0)
        result = true;
        res.status(200).send(result);
    });
};

exports.turnOff = (req, res) => {
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
        client.publish('cmnd/sonoff_speakers/POWER', '0'); // Trigger power toggle (toggle power for input #0)
        result = true;
        res.status(200).send(result);
    });
};
