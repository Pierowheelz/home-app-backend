const fetch = require('node-fetch');
const ewelink = require('ewelink-api');
const config = require('../../common/config/env.config');

const initDevices = () => {
    /* instantiate class */
    const connection = new ewelink({
        email: config.ewelink_email,
        password: config.ewelink_password,
        region: config.ewelink_region,
    });
    
    return connection;
};

const getDeviceId = async ( connection, deviceName ) => {
    const devices = await connection.getDevices();
    // loop through devices to find the matching one
    let matchedDevice = false;
    for( const dev of devices ) {
        const devName = dev.name ?? 'Unknown';
        if( devName == deviceName ){
            matchedDevice = dev;
            break;
        }
    }
    
    return matchedDevice.deviceid;
};

const getDeviceStatus = async ( connection, deviceId ) => {
    const status = await connection.getDevicePowerState( deviceId );
    
    return status;
};

const setDeviceStatus = async ( connection, deviceId, newState ) => {
    const status = await connection.setDevicePowerState(deviceId, newState);
      
    return status;
};

exports.lookupDevice = (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = initDevices();
    getDeviceId( con, requestDevice ).then( (deviceId) => {
        console.log('Matched device: ', deviceId);
        if( false === deviceId ){
            res.status(200).send({success:false,device:false,error:'not_found'});
        } else {
            res.status(200).send({success:true,device:deviceId,error:''});
        }
    });
};

exports.getStatus = (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = initDevices();
    getDeviceStatus( con, requestDevice ).then( (status) => {
        console.log('Device status: ', status);
        
        res.status(200).send({success:true,status:status,error:''});
    });
};

exports.turnOn = (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = initDevices();
    setDeviceStatus( con, requestDevice, 'on' ).then( (status) => {
        console.log('Device status: ', status);
        
        res.status(200).send({success:true,status:status,error:''});
    });
};

exports.turnOff = (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = initDevices();
    setDeviceStatus( con, requestDevice, 'off' ).then( (status) => {
        console.log('Device status: ', status);
        
        res.status(200).send({success:true,status:status,error:''});
    });
};
