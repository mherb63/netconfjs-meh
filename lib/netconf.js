const { Client } = require('ssh2');
const xml2js = require('xml2js');
const vasync = require('vasync');

const DELIM = ']]>]]>';

function objectHelper(name) {
    // Replaces characters that prevent dot-style object navigation.
    return name.replace(/-|:/g, '_');
}

function createError(msg, type) {
    const err = new Error(msg);
    err.name = type;

    Error.captureStackTrace(err, createError);
    return err;
}

function NetconfClient(params) {
    // Constructor paramaters
    this.host = params.host;
    this.username = params.username;
    this.port = params.port || 22;
    this.password = params.password;
    this.pkey = params.pkey;

    // Debug and informational
    this.connected = false;
    this.sessionID = null;
    this.remoteCapabilities = [ ];
    this.idCounter = 100;
    this.rcvBuffer = '';
    this.debug = params.debug;

    // Runtime option tweaks
    this.raw = false;
    this.parseOpts = {
        trim: true,
        explicitArray: false,
        emptyTag: true,
        ignoreAttrs: false,
        tagNameProcessors: [ objectHelper ],
        attrNameProcessors: [ objectHelper ],
        valueProcessors: [ xml2js.processors.parseNumbers ],
        attrValueProcessors: [ xml2js.processors.parseNumbers ]
    };
    this.algorithms = params.algorithms
}
NetconfClient.prototype = {
    // Message and transport functions.
    // Operation functions defined below as wrappers to rpc function.
    rpc: function (request, callback) {
        const messageID = this.idCounter += 1;

        const object = { };
        const defaultAttr = {
            'message-id': messageID,
            'xmlns': 'urn:ietf:params:xml:ns:netconf:base:1.0'
        };
        if (typeof (request) === 'string') {
            object.rpc = {
                $: defaultAttr,
                [request]: null
            };
        } else if (typeof (request) === 'object') {
            object.rpc = request;
            if (object.rpc.$) {
                object.rpc.$['message-id'] = messageID;
            } else {
                object.rpc.$ = defaultAttr;
            }
        }

        const builder = new xml2js.Builder({ headless: true, allowEmpty: true });
        let xml;
        try {
            xml = builder.buildObject(object)
        } catch (err) {
            return callback(err);
        }
        this.send(xml, messageID, callback);
    },
    send: function (xml, messageID, callback) {
        const chunked = `\n#${xml.length}\n${xml}\n##\n`
        // console.log(`send::xml: ${xml}`)
        const self = this;
        this.netconf.write(chunked, function startReplyHandler() {
            // Add an event handler to search for our message on data events.
            self.netconf.on('data', function replyHandler() {
                const replyFound = self.rcvBuffer.includes(`message-id="${messageID}`)
                // console.log(`rcvBuffer: ${self.rcvBuffer}`)

                 if (replyFound) {
                    const message = self.rcvBuffer;
                    self.parse(message.replace('\n##\n', '').replace(/\n#\d+\n/, ''), callback);
                    self.rcvBuffer = self.rcvBuffer.replace(message, '');
                    self.netconf.removeListener('data', replyHandler);
                }
            });
        });
    },
    parse: function (xml, callback) {
        const self = this;
        xml2js.parseString(xml, this.parseOpts, function checkRPCErrors(err, message) {
            if (err) {
                return callback(err, null);
            }
            if (message.hasOwnProperty('hello')) {
                return callback(null, message);
            }
            if (self.raw) {
                message.raw = xml;
            }
            if (message.rpc_reply.hasOwnProperty('rpc_error')) {
                return callback(createError(JSON.stringify(message), 'rpcError') , null);
            }
            return callback(null, message);
        });
    },
    open: function (callback) {
        const self = this;
        this.sshConn = new Client();
        this.sshConn.on('ready', function invokeNETCONF() {
            vasync.waterfall([
                function getStream(next) {
                    self.sshConn.subsys('netconf', next);
                },
                function handleStream(stream, next) {
                    self.netconf = stream;
                    self.sendHello();
                    stream.on('data', function buffer(chunk) {
                        self.rcvBuffer += chunk;
                        //self.emit('data');
                    }).on('error', function streamErr(err) {
                        self.sshConn.end();
                        self.connected = false;
                       // self.emit('error');
                        throw (err);
                    }).on('close', function handleClose() {
                        self.sshConn.end();
                        self.connected = false;
                       // self.emit('close');
                    }).on('data', function handleHello() {
                        if (self.rcvBuffer.match(DELIM)) {
                            const helloMessage = self.rcvBuffer.replace(DELIM, '');
                            self.rcvBuffer = '';
                            self.netconf.removeListener('data', handleHello);
                            next(null, helloMessage);
                        }
                    });
                },
                function parseHello(helloMessage, next) {
                    self.parse(helloMessage, function assignSession(err, message) {
                        if (err) {
                            return next(err);
                        }
                        if (message.hello.session_id > 0) {
                            self.remoteCapabilities = message.hello.capabilities.capability;
                            self.sessionID = message.hello.session_id;
                            self.connected = true;
                            next(null);
                        } else {
                            next(new Error('NETCONF session not established'));
                        }
                    });
                }
            ],
            function (err) {
                if (err) {
                    return callback(err);
                }
                return callback(null);
            });
        }).on('error', function (err) {
            self.connected = false;
            callback(err);
        }).connect({
            host: this.host,
            username: this.username,
            password: this.password,
            port: this.port,
            privateKey: this.pkey,
            debug: this.debug,
            algorithms: this.algorithms
        });

       // return self;
    },
    sendHello: function () {
        const message = {
            hello: {
                $: { xmlns: 'urn:ietf:params:xml:ns:netconf:base:1.0' },
                capabilities: {
                    // netconf version 1.1
                    capability: ['urn:ietf:params:netconf:base:1.1']
                }
            }
        };
        const builder = new xml2js.Builder();
        const xml = builder.buildObject(message) + '\n' + DELIM;
        this.netconf.write(xml);
    }
};

// Operation layer. Wrappers around RPC calls.
NetconfClient.prototype.close = function (callback) {
    this.rpc('close-session', function closeSocket(err, reply) {
        if (!callback) {
            return;
        }
        if (err) {
            return callback(err, reply);
        }
        return callback(null, reply);
    });
};

// Cisco specific operations.
NetconfClient.prototype.IOSClose = function (callback) { // Cisco does not send a disconnect so you have to submit something after you close the session. Model: WS-C2960S-48FPD-L SW Version: 12.2(58)SE2
    const self = this;
    this.rpc('close-session', function closeSocket(err, reply) {
        self.rpc('close-session', function closeSocket(err, reply) {
            return callback(null, reply);
        });
    });
};

// Juniper specific operations.
NetconfClient.prototype.JunosLoad = function (args, callback) {
    let loadOpts = { };
    if (typeof (args) === 'string') { // Backwards compatible with 0.1.0
        loadOpts = { config: args, action: 'merge', format: 'text' };
    } else if (typeof (args) === 'object') {
        loadOpts = {
            config: args.config,
            action: args.action || 'merge',
            format: args.format || 'text'
        };
    }

    if (typeof (loadOpts.config) === 'undefined') {
        return callback(new Error('configuraton undefined'), null);
    }

    let configTag;
    if (loadOpts.action === 'set') {
        configTag = 'configuration-set';
    } else if (loadOpts.format === 'xml') {
        configTag = 'configuration';
    } else {
        configTag = 'configuration-text';
    }

    const rpcLoad = {
        'load-configuration': {
            $: { action: loadOpts.action, format: loadOpts.format },
            [configTag]: loadOpts.config
        }
    };
    this.rpc(rpcLoad, function checkErrors(err, reply) {
         if (err) {
             return callback(err, reply);
         }
         // Load errors aren't found in the top-level reply so need to check seperately.
         const rpcError = reply.rpc_reply.load_configuration_results.hasOwnProperty('rpc_error');
         if (rpcError) {
             return callback(createError(JSON.stringify(reply), 'rpcError'), null);
         }
         return callback(null, reply);
     });
};
NetconfClient.prototype.JunosCommit = function (callback) {
    this.rpc('commit-configuration', function checkErrors(err, reply) {
        if (err) {
            return callback(err, reply);
        }
        // Load errors aren't found in the top-level reply so need to check seperately.
        const rpcError = result.rpc_reply.commit_results.routing_engine.hasOwnProperty('rpc_error');
        if (rpcError) {
            return callback(createError(JSON.stringify(reply), 'rpcError'), null);
        }
        return callback(null, reply);
    });
};
NetconfClient.prototype.JunosOpenPrivate = function (callback) {
    const rpcOpen = {
        'open-configuration': {'private' : ""}
    };
    this.rpc(rpcOpen, callback);
};
NetconfClient.prototype.JunosClosePrivate = function (callback) {
    this.rpc('close-configuration', callback);
};
NetconfClient.prototype.JunosCompare = function (callback) {
    const rpcCompare = {
        'get-configuration': {
            $: { compare: 'rollback', format: 'text' }
        }
    };
    this.rpc(rpcCompare, function parseDiff(err, reply) {
        if (err) {
            return callback(err, reply);
        }
        const text = reply.rpc_reply.configuration_information.configuration_output;
        return callback(null, text);
    });
};
NetconfClient.prototype.JunosRollback = function (callback) {
    this.rpc('discard-changes', callback);
};
NetconfClient.prototype.JunosFacts = function (callback) {
    const self = this;
    vasync.parallel({
        funcs: [
            function getSoftwareInfo(callback) {
                self.rpc('get-software-information', callback);
            },
            function getRE(callback) {
                self.rpc('get-route-engine-information', callback);
            },
            function getChassis(callback) {
                self.rpc('get-chassis-inventory', callback);
            }
        ]
    }, function compileResults(err, results) {
        if (err) {
            return callback(err, null);
        }
        const softwareInfo = results.operations[0].result.rpc_reply.software_information;
        const reInfo = results.operations[1].result.rpc_reply.route_engine_information.route_engine;
        const chassisInfo = results.operations[2].result.rpc_reply.chassis_inventory.chassis;
        const facts = {
            hostname: softwareInfo.host_name,
            version: softwareInfo.package_information,
            model: softwareInfo.product_model,
            uptime: reInfo.up_time,
            serial: chassisInfo.serial_number
        };
        return callback(null, facts);
    });
};

module.exports.NetconfClient = NetconfClient;