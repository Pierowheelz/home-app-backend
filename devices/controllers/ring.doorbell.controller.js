const ringDoorbell = require('../services/ring.doorbell.service');

/**
 * Ring doorbells via ring-mqtt. Config-driven actions live in {@link ringDoorbell}; this module only fans MQTT
 * into the service.
 */

/**
 * MQTT message handler for `<topic>/<location>/camera/<device>/ding/attributes`.
 * @param {string} message
 * @param {string} topic
 * @returns {void}
 */
function onMessage(message, topic) {
    const parts = topic.split('/');
    const deviceId = parts[parts.length - 3];

    let attributes;
    try {
        attributes = JSON.parse(message);
    } catch (err) {
        console.warn(`Ring: invalid ding attributes on ${topic}`);
        return;
    }
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
        return;
    }
    ringDoorbell.handleDingAttributes(deviceId, attributes);
}

/**
 * Register on the shared MQTT session when `ring.enabled`.
 * @param {{ addTopic: (filter: string, onMessage: (message: string, topic: string) => void) => void }} mqttController
 * @returns {void}
 */
exports.attachMqtt = (mqttController) => {
    const cfg = ringDoorbell.getRingConfig();
    if (!cfg.enabled) {
        return;
    }
    mqttController.addTopic(`${cfg.topic}/+/camera/+/ding/attributes`, onMessage);
};
