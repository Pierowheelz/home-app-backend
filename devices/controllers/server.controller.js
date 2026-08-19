const fetchWithTimeout = require('../fetchWithTimeout');

let currentState = 'unknown';
let controllerState = 'offline';
let currentConsumption = {};
let immediateShutdown = 0;
let preventShutdown = 0;
const onMessage = ( msgJson ) => {
    console.log('ServerControl - message received: ', msgJson);
    // Get ServerControl state
    const switchPower = msgJson.POWER ?? null;
    let switchConsumption = msgJson.ENERGY ?? null;
    if( null == switchConsumption && typeof msgJson.StatusSNS != "undefined" ){
        switchConsumption = msgJson.StatusSNS.ENERGY ?? null;
    }
    
    if( null !== switchPower ){
        currentState = 'off';
        if( "ON" == switchPower ){
            currentState = 'on';
        }
    }
    
    if( null !== switchConsumption ){
        currentConsumption = switchConsumption;
    }
};

let sendMqttCommand = ( msg, data ) => {
    console.log('ServerControl - Failed to send message. Mqtt Controller not yet attached', msg, data);
    return false;
};

/**
 * @returns {string} Companion HTTP origin without a trailing slash.
 */
function serverCompanionBaseUrl() {
    return String(appconfig.devices.server.companionBaseUrl).replace(/\/$/, '');
}

exports.attachMqtt = ( mqttController ) => {
    mqttController.addDevice( appconfig.devices.server.mqttName, onMessage );
    
    sendMqttCommand = mqttController.getCommandFunction();
};

exports.getState = async (req, res) => {
    const mqttName = appconfig.devices.server.mqttName;
    
    // Request POWER update from MQTT broker
    sendMqttCommand( 'cmnd/' + mqttName + '/state' );
    sendMqttCommand( 'cmnd/' + mqttName + '/status' );
    
    const time = new Date().getTime();
    
    // Fetch immediateShutdown/preventShutdown bool file statuses
    if( 'on' == currentState ){ // Skip this if the server is off - it won't work anyway
        try{
            const response = await fetchWithTimeout(serverCompanionBaseUrl() + "/readall?time="+time);
            if (!response.ok) {
                console.warn('ServerControl - Failed to fetch status: ', response);
                res.status(500).send({success:false,error:'offline',status:'{}'});
                return;
            }
            const data = await response.json();
            if( data ){
                // We have usable data
                immediateShutdown = data.immediate ?? immediateShutdown;
                preventShutdown = data.prevent ?? preventShutdown;
                controllerState = 'online';
            }
            
            console.log('ServerControl - got statuses: ', data);
        } catch( e ){
            console.log("ServerControl - fetch failed (assume offline)");
        }
    }
    
    res.status(200).send({success:true,error:'',state:currentState,consumption:currentConsumption,prevent:preventShutdown,immediate:immediateShutdown, controller: controllerState});
};

exports.bootServer = (req, res) => {
    console.log('ServerControl - Boot Server.');
    if( 'on' == currentState || 'unknown' == currentState ){
        console.log('Server is already on (or state unknown). Aborting request.');
        res.status(500).send({success:false,error:'already_on',state:currentState,consumption:currentConsumption,prevent:preventShutdown,immediate:immediateShutdown, controller: controllerState});
        return;
    }
    const result = sendMqttCommand( 'cmnd/' + appconfig.devices.server.mqttName + '/POWER', '1' );
    let resultCode = result ? 200 : 503;
    
    res.status(resultCode).send({success:true,error:'',state:'on',consumption:currentConsumption,prevent:preventShutdown,immediate:immediateShutdown, controller: controllerState});
};

exports.shutdownServer = async (req, res) => {
    console.log('ServerControl - Shutdown Server.');
    if( 'off' == currentState || 'unknown' == currentState ){
        console.log('Server is already off (or state unknown). Aborting request.');
        res.status(500).send({success:false,error:'already_off',state:currentState,consumption:currentConsumption,prevent:preventShutdown,immediate:immediateShutdown, controller: controllerState});
        return;
    }
    
    const time = new Date().getTime();
    
    try{
        const response = await fetchWithTimeout(serverCompanionBaseUrl() + "/setimmediate?state=1&time="+time);
        if (!response.ok) {
            console.warn('Failed to update `Immediate Shutdown` status');
            res.status(500).send({success:false,error:'offline',status:'{}'});
            return;
        }
        const data = await response.text();
        if( data ){
            // We have usable data
            immediateShutdown = '1'==data ? 1 : 0;
            controllerState = 'online';
        }
        
        console.log('ServerControl - `immediate_shutdown` status: '+data);
    } catch (error) {
        immediateShutdown = 0;
        console.log('ServerControl - `immediate_shutdown` update failed');
    }
    res.status(200).send({success:true,error:'',state:currentState,consumption:currentConsumption,prevent:preventShutdown,immediate:immediateShutdown, controller: controllerState});
};

exports.togglePreventShutdown = async (req, res) => {
    const requestState = req.url.replace(/^\/\w+\/\w+\/(\d+)\/?$/, '$1');
    console.log('ServerControl - Toggle Prevent Shutdown: ', requestState);
    
    const time = new Date().getTime();
    const reqState = ('1'==requestState) ? '1' : '0';
    
    try{
        const response = await fetchWithTimeout(serverCompanionBaseUrl() + "/set?state="+reqState+"&time="+time);
        if (!response.ok) {
            console.warn('Failed to update `Prevent Shutdown` status');
            res.status(500).send({success:false,error:'offline',status:'{}'});
            return;
        }
        const data = await response.text();
        if( data ){
            // We have usable data
            preventShutdown = '1'==data ? 1 : 0;
            controllerState = 'online';
        }
        
        console.log('ServerControl - `prevent_shutdown` status: '+data);
    } catch (error) {
        preventShutdown = 0;
        console.log('ServerControl - `prevent_shutdown` update failed');
    }
    res.status(200).send({success:true,error:'',state:currentState,consumption:currentConsumption,prevent:preventShutdown,immediate:immediateShutdown, controller: controllerState});
};
