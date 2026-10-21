const mqtt = require('mqtt');
const MQSETTINGS = appconfig.mqtt;

/**
 * True when `topic` matches an MQTT subscription filter (`+` = one level, `#` = remaining levels).
 * @param {string} filter
 * @param {string} topic
 * @returns {boolean}
 */
function topicMatches(filter, topic) {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') {
            return true;
        }
        if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) {
            return false;
        }
    }
    return f.length === t.length;
}

class MqttHandler{
    
    devices = [];
    
    topics = [];

    constructor() {
        
    }

    /**
     * Subscribe to an arbitrary topic filter (non-Tasmota sources, e.g. ring-mqtt). Matching messages go only to
     * this handler, as the raw payload string.
     * @param {string} filter MQTT topic filter; `+` / `#` wildcards allowed.
     * @param {(message: string, topic: string) => void} messageHandler
     */
    addTopic = (filter, messageHandler) => {
        this.topics.push({
            filter,
            onMessage: messageHandler,
        });
    }
    
    /**
     * @param {string} deviceName Topic fragment after stat/tele/cmnd (e.g. tasmota_zigbee).
     * @param {(msgJson: Record<string, unknown>, topic?: string) => void} messageHandler Called for JSON payloads on matching topics.
     * @param {{ bootstrap?: (publish: (topic: string, payload?: string) => void) => void }} [options] Optional hook after subscribe (e.g. query bridge for state).
     */
    addDevice = (deviceName, messageHandler, options = {}) => {
        this.devices.push({
            name: deviceName,
            onMessage: messageHandler,
            bootstrap: typeof options.bootstrap === 'function' ? options.bootstrap : undefined,
        });
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
                this.client.subscribe( ['stat/'+dev.name+'/#','tele/'+dev.name+'/#'], (err) => {
                    if (!err) {
                        this.client.publish('cmnd/'+dev.name+'/state', '1');
                        if (dev.bootstrap) {
                            dev.bootstrap((topic, payload) => {
                                this.client.publish(
                                    topic,
                                    payload !== undefined && payload !== null ? String(payload) : '',
                                );
                            });
                        }
                    }
                });
            });

            if (this.topics.length > 0) {
                this.client.subscribe( this.topics.map((t) => t.filter), (err) => {
                    if (err) {
                        console.warn('MQTT subscribe failed: ', err);
                    }
                });
            }
        });
        
        this.client.on('message', (topic, message) => {
            // message is Buffer
            console.log(topic, message.toString());

            const topicSubs = this.topics.filter((t) => topicMatches(t.filter, topic));
            if (topicSubs.length > 0) {
                topicSubs.forEach((t) => {
                    try {
                        t.onMessage( message.toString(), topic );
                    } catch (err) {
                        console.warn('MQTT topic handler error: ', err);
                    }
                });
                return;
            }
            
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
                    dev.onMessage( msgJson, topic );
                }
            });
        });
        
        this.client.on('reconnect', () => {
            console.log('MQTT reconnecting...');
        });
        
        this.client.on('error', this._handleError);
    };
    
    getCommandFunction = () => {
        return this._sendCommand;
    };
    
    _sendCommand = ( mgd, data ) => {
        console.log('Sending MQTT command: ', mgd, data);
        this.client.publish(mgd, data);
        
        return true;
    };
    
    _handleError = (err) => {
        // mqtt.js reconnects by itself (reconnectPeriod) with the original options and handlers, and the
        // 'connect' handler re-subscribes and re-bootstraps devices. Don't end() / recreate the client here:
        // that cancels auto-reconnect and the new client has no credentials or handlers.
        console.warn('MQTT Error: ', err);
    };
}

module.exports = MqttHandler;
module.exports.topicMatches = topicMatches;
