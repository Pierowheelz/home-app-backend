const fetchWithTimeout = require('../fetchWithTimeout');

/**
 * Blinds controller HTTP URL for a Tasmota-style action code.
 *
 * @param {string} actionCode Query `b` value (`1` open, `2` close, `5` stop).
 * @returns {string}
 */
function blindsActionUrl(actionCode) {
    const baseUrl = String(appconfig.devices.blinds.baseUrl).replace(/\/$/, '');
    return baseUrl + '/?a=1&b=' + actionCode;
}

exports.openBlinds = async (req, res) => {
    let result = false;
    
    console.log('Open Blinds');
    try{
        const response = fetchWithTimeout(blindsActionUrl('1'));
        if (!response.ok) {
            console.warn('Failed to open blinds');
            res.status(500).send({success:false,error:'offline'});
            return;
        }
    } catch (error){
        console.warn('Failed to send open blinds request');
        res.status(500).send({success:false,error:'offline'});
    }
    //const response = await response.json();
    res.status(200).send({success:true,error:''});
};

exports.closeBlinds = async (req, res) => {
    let result = false;
    
    console.log('Close Blinds');
    try{
        const response = fetchWithTimeout(blindsActionUrl('2'));
        if (!response.ok) {
            console.warn('Failed to close blinds');
            res.status(500).send({success:false,error:'offline'});
            return;
        }
    } catch (error){
        console.warn('Failed to send close blinds request');
        res.status(500).send({success:false,error:'offline'});
    }
    //const response = await response.json();
    res.status(200).send({success:true,error:''});
};

exports.stopBlinds = async (req, res) => {
    let result = false;
    
    console.log('Stop Blinds');
    try{
    const response = fetchWithTimeout(blindsActionUrl('5'));
        if (!response.ok) {
            console.warn('Failed to stop blinds');
            res.status(500).send({success:false,error:'offline'});
            return;
        }
    } catch (error){
        console.warn('Failed to send stop blinds request');
        res.status(500).send({success:false,error:'offline'});
    }
    //const response = await response.json();
    res.status(200).send({success:true,error:''});
};
