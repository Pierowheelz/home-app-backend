const fetch = require('node-fetch');

exports.openBlinds = (req, res) => {
    let result = false;
    
    console.log('Open Blinds');
    fetch("http://192.168.2.102/?a=1&b=1").then((response) => {
        console.log(response);
        res.status(200).send({success:true,error:''});
    }).catch(err => {
        console.log(err);
        res.status(500).send({success:false,error:'offline'});
    });
};

exports.closeBlinds = (req, res) => {
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

exports.stopBlinds = (req, res) => {
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
