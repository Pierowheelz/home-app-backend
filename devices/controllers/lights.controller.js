const fetch = require('node-fetch');
const ewelink = require('ewelink-api');
const config = require('../../common/config/env.config');

const initDevices = async () => {
    /* instantiate class */
    const connection = new ewelink({
      email: config.ewelink_email,
      password: config.ewelink_password,
      region: config.ewelink_region,
    });

    /* get all devices */
    const devices = await connection.getDevices();
    
    return {
        devices,
        connection
    };
};

exports.getStatus = (req, res) => {
    let result = false;
    
    console.log('Getting status: ', req);
    
    const { devices, connection } = await initDevices();
    
    console.log('Devices: ', devices);
    
    res.status(500).send({success:false,error:'offline'});
    // fetch("http://192.168.2.102/?a=1&b=1").then((response) => {
    //     console.log(response);
    //     res.status(200).send({success:true,error:''});
    // }).catch(err => {
    //     console.log(err);
    //     res.status(500).send({success:false,error:'offline'});
    // });
};

exports.turnOn = (req, res) => {
    let result = false;
    
    console.log('Close Blinds');
    fetch("http://192.168.2.102/?a=1&b=2").then((response) => {
        console.log(response);
        res.status(200).send({success:true,error:''});
    }).catch(err => {
        console.log(err);
        res.status(500).send({success:false,error:'offline'});
    });
};

exports.turnOff = (req, res) => {
    let result = false;
    
    console.log('Stop Blinds');
    fetch("http://192.168.2.102/?a=1&b=5").then((response) => {
        console.log(response);
        res.status(200).send({success:true,error:''});
    }).catch(err => {
        console.log(err);
        res.status(500).send({success:false,error:'offline'});
    });
};
