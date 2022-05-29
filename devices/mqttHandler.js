const mqtt = require('mqtt');
const config = require('../common/config/env.config');
const MQSETTINGS = config.mqtt;

class MqttHandler{
    
    devices = [];
    
    constructor() {
        
    }
    
    addDevice = (deviceName, messageHandler) => {
        this.devices.push(
            {
                name: deviceName,
                onMessage: messageHandler
            }
        );
    }
    
    connect = () => {
        const mqOptions = {};
        if( '' != (MQSETTINGS.username ?? '') ){
            mqOptions.username = MQSETTINGS.username;
            mqOptions.password = MQSETTINGS.password;
        }
        
        this.client = mqtt.connect('mqtt://'+MQSETTINGS.url, mqOptions);
        
        this.client.on('connect', () => {
            console.log('MQTT connected - fetching current state of devices');
            
            this.devices.forEach( (dev) => {
                console.log('MQTT getching status of device: ', dev.name);
                this.client.subscribe('stat/'+dev.name+'/#', (err) => {
                    if (!err) {
                        this.client.publish('cmnd/'+dev.name+'/state', '1');
                    }
                });
            });
        });
        
        this.client.on('message', (topic, message) => {
            // message is Buffer
            console.log(topic, message.toString());
            
            // Decode message JSON
            let msgJson = {};
            try{
                msgJson = JSON.parse( message.toString() );
            } catch( err ){
                console.log('Failed to decode JSON message.');
                //res.status(500).send({error:'json_error'});
                
                
                return;
            }
            
            // Determine where to send this message
            this.devices.forEach( (dev) => {
                if( topic.includes(dev.name) ){
                    dev.onMessage( msgJson );
                }
            });
        });
        
        this.client.on('error', this._handleError);
    };
    
    getCommandFunction = () => {
        return this._sendCommand;
    };
    
    _sendCommand = ( mgd, data ) => {
        console.log('Sending MQTT command: ');
        this.client.publish(mgd, data);
        
        return true;
    };
    
    _handleError = (err) => {
        console.warn('MQTT Error: ', err);
        
        this.client.end();
        this.client = mqtt.connect('mqtt://127.0.0.1');
    };
}

module.exports = MqttHandler;
