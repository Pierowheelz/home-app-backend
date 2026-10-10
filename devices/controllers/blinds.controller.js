const fetchWithTimeout = require('../fetchWithTimeout');

/** Controller `b` action codes. */
const BLINDS_ACTION_CODES = {
    open: '1',
    close: '2',
    stop: '5',
};

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

/**
 * Send an action to the blinds controller.
 * @param {'open'|'close'|'stop'} action
 * @returns {Promise<boolean>} True when the controller accepted the request.
 */
exports.sendAction = async (action) => {
    console.log('Blinds action: ' + action);
    try {
        const response = await fetchWithTimeout(blindsActionUrl(BLINDS_ACTION_CODES[action]));
        if (!response.ok) {
            console.warn('Failed to ' + action + ' blinds (HTTP ' + response.status + ')');
            return false;
        }
        return true;
    } catch (error) {
        console.warn('Failed to send ' + action + ' blinds request');
        return false;
    }
};

/**
 * @param {'open'|'close'|'stop'} action
 * @returns {import('express').RequestHandler}
 */
const actionHandler = (action) => async (req, res) => {
    const ok = await exports.sendAction(action);
    if (!ok) {
        res.status(500).send({success:false,error:'offline'});
        return;
    }
    res.status(200).send({success:true,error:''});
};

exports.openBlinds = actionHandler('open');
exports.closeBlinds = actionHandler('close');
exports.stopBlinds = actionHandler('stop');
