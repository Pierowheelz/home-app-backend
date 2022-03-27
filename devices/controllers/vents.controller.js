const fetch = require('node-fetch');

const ventNumberPad = ( value, padding ) => {
    const zeroes = new Array(padding+1).join("0");
    return (zeroes + value).slice(-padding);
};

exports.getStatus = (req, res) => {
    fetch("http://192.168.2.110/?&t=1")
        .then( response => response.json() )
        .then( data => {
            console.log('Vents status: ',data);
            res.status(200).send({success:true,error:'',status:data});
        })
        .catch(err => {
            console.log(err);
            res.status(500).send({success:false,error:'offline',status:'{}'});
        });
};

exports.updateStatus = (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\/(\d+)\/(\d+)$/, '$1');
    let requestState = req.url.replace(/^\/\w+\/(\d+)\/(\d+)$/, '$2');
    
    requestState = Math.max( 0, requestState );
    requestState = Math.min( 175, requestState );
    const paddedState = ventNumberPad( requestState, 3 );
    
    console.log('Opening vent: '+requestDevice+' to: '+paddedState);
    
    fetch("http://192.168.2.110/?a=6&t=1&m="+requestDevice+"&d="+paddedState)
        .then( response => response.json() )
        .then( data => {
            console.log('Vents status: '+data);
            res.status(200).send({success:true,error:'',status:data});
        })
        .catch(err => {
            console.log(err);
            res.status(500).send({success:false,error:'offline',status:'{}'});
        });
};
