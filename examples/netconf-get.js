var netconf = require('../lib/netconf');
var util = require('util');


function pprint(object) {
    console.log(util.inspect(object, {depth:null, colors:true}));
}

// var router = new netconf.Client({
//     host: '172.28.128.3',
//     username: 'vagrant',
//     pkey: ''fs.readFileSync('insecure_ssh.key', {encoding: 'utf8'}'')
// });
var router = new netconf.Client({
    host: '192.168.200.26',
    username: 'root',
    password:'',
    port: '830'
});

router.parseOpts.ignoreAttrs = false;
router.raw = true;

router.open(function afterOpen(err) {
    if (!err) {
        router.rpc({ 'get-config': { source: { running: null } } }, function (err, results) {
            setTimeout(router.IOSClose(),1000);
            if (err) {
                pprint(results);
                throw (err);
            }
            // pprint(results);
            console.log(results.raw);
        });
    } else {
        throw err;
    }
});
