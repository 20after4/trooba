'use strict';

/**
 * Assigns transport to the client pipeline
*/
function Trooba() {
    this._handlers = [];
}

Trooba.prototype = {
    transport: function transport(transport, config) {
        if (typeof transport === 'string') {
            transport = require(transport);
        }
        this._transport = {
            handler: transport,
            config: config
        };
        if (transport.api) {
            this._api = transport.api;
        }
        return this;
    },

    use: function use(handler, config) {
        if (typeof handler === 'string') {
            handler = require(handler);
        }
        this._handlers.unshift({
            handler: handler,
            config: config
        });
        this._pipe = undefined;
        return this;
    },

    /**
    * If config parameters is provided, then we assume api to be an API wrapper factory,
    * otherwise it is considered as an instance of API wrapper
    */
    interface: function interface$(api, config) {
        this._api = {
            handler: api,
            config: config
        };
        return this;
    },

    create: function create(context) {
        var self = this;

        var pipe = this._pipe = this._pipe || buildPipe(
            this._handlers,
            // allow lazy transport binding via request context
            createPipePoint(function injectTransport(pipe) {
                var tr = pipe.context.transport || self._transport;
                if (!tr) {
                    throw new Error('Transport is not provided');
                }
                tr.handler ?
                    tr.handler(pipe, tr.config) :
                    tr(pipe);
            }
        ));

        if (this._api) {
            pipe = context ? pipe.create(context) : pipe;
            var pipeApi = {
                create: function create(context) {
                    return pipe.create(context);
                }
            };
            return this._api.handler ? this._api.handler(pipeApi, this._api.config) :
                this._api(pipeApi);
        }

        return pipe.create(context || {});
    }
};

module.exports.transport = function createWithTransport(transport, config) {
    var trooba = new Trooba();
    return trooba.transport(transport, config);
};

module.exports.use = function createWithHandler(handler, config) {
    var trooba = new Trooba();
    return trooba.use(handler, config);
};

module.exports.interface = function createWithInterface(api, config) {
    var trooba = new Trooba();
    return trooba.interface(api, config);
};

/**
   The pipe API signature is
    pipe.on()
        .context()
        .request()
        .end()

*/
function buildPipe(handlers, target) {
    var pipe = handlers.reduce(function reduce(next, handlerMeta) {
        return createPipePoint(handlerMeta, next);
    }, target);

    return createPipePoint(function startPipe(pipe) {}, pipe);
}
module.exports.buildPipe = buildPipe;

function createPipePoint(handler, next) {
    var point = new PipePoint(handler);
    point.next = next;
    if (next) {
        next.prev = point;
    }
    return point;
}

module.exports.createPipePoint = createPipePoint;

var Types = {
    REQUEST: 1,
    RESPONSE: 2
};
module.exports.Type = Types;

/*
* Channel point forms a linked list node
*/
function PipePoint(handler) {
    this._messageHandlers = {};
    this.handler = handler;
    if (handler && typeof handler !== 'function') {
        this.handler = handler.handler;
        this.config = handler.config;
    }
    // build a unique identifer for every new instance of point
    // we do not anticipate creates of so many within one pipe to create conflicts
    PipePoint.instanceCounter = PipePoint.instanceCounter ? PipePoint.instanceCounter : 0;
    this._id = PipePoint.instanceCounter++;
}

module.exports.PipePoint = PipePoint;

PipePoint.prototype = {
    send: function send(message) {
        // pick the direction
        var nextPoint = message.flow === Types.REQUEST ?
            this.next : this.prev;

        if (nextPoint) {
            if (!message.context && !this.context) {
                throw new Error('Context is missing, make sure context() is used first');
            }
            // attach context to the message to keep context flow
            // check processing step to see where context goes
            message.context = message.context || this.context;
            // forward message down the pipe
            nextPoint.process(message);
        }
        else if (message.type === 'error') {
            throw message.ref;
        }

        return this;
    },

    clone: function clone() {
        var ret = new PipePoint();
        ret.next = this.next;
        ret.prev = this.prev;
        ret._id = this._id;
        ret._messageHandlers = this._messageHandlers;
        ret.config = this.config;
        ret.handler = this.handler;
        return ret;
    },

    process: function process(message) {
        var point = this;
        var messageHandlers;
        // context propagation is sync and
        // init all points in the pipeline
        if (message.type === 'context') {
            // create point bound to current message and assign the context
            // this clone is 5 times faster then Object.create
            point = point.clone();
            point.context = message.context;
            // allow hooks to happen
            point.handler(point, point.config);
        }
        else {
            // handle the hooks
            messageHandlers = this.handlers(message.context);
            var processMessage = messageHandlers[message.type];
            if (processMessage) {
                // if sync delivery, than no callback needed before propagation further
                processMessage(message.ref, message.sync ? undefined : onComplete);
                if (!message.sync) {
                    // on complete has continued the flow
                    return;
                }
            }
            else if (processEndEvent()) {
                return;
            }
        }

        point.send(message);

        function onComplete(ref) {
            if (arguments.length) {
                message.ref = ref;
            }
            // special case for stream
            if (processEndEvent()) {
                return;
            }
            point.send(message);
        }

        function processEndEvent() {
            if ((message.type === 'response:data' ||
                message.type === 'request:data') && message.ref === undefined) {

                var endHandler = messageHandlers[
                    message.flow === Types.REQUEST ? 'request:end' : 'response:end'];
                if (endHandler) {
                    endHandler(function onComplete() {
                        point.send(message);
                    });
                    return true;
                }
            }
        }
    },

    /*
    * context method is sync methods that runs through all handlers
    * to allow them to hook to events they are interested in
    * The context will be attached to every message and bound to pipe (Object.create is pretty fast) at the time of
    * processing by different points to preserve the context
    */
    create: function create$(context) {
        context = context || {};

        if (this.context) {
            // inherit from existing context if any
            var self = this;
            Object.keys(this.context).forEach(function forEach(name) {
                if (name.charAt(0) !== '$' && !context[name]) {
                    context[name] = self.context[name];
                }
            });
        }

        // do not inherit message handles from previous context
        context.$points = undefined;

        // bind context to the point and return it
        var contextualPoint = Object.create(this);
        contextualPoint.context = context;
        contextualPoint.send({
            type: 'context',
            flow: Types.REQUEST,
            ref: context
        });
        return contextualPoint;
    },

    throw: function throw$(err) {
        this.send({
            type: 'error',
            flow: Types.RESPONSE,
            ref: err
        });
    },

    streamRequest: function streamRequest$(request) {
        this.context.$requestStream = true;
        var point = this.request(request);
        return createWriteStream({
            channel: point,
            flow: Types.REQUEST
        });
    },

    request: function request$(request, callback) {
        var point = this;
        if (!point.context) {
            // create default context
            point = point.create({});
        }

        function sendRequest() {
            point.send({
                type: 'request',
                flow: Types.REQUEST,
                ref: request
            });
        }

        if (callback) {
            point
            .on('error', callback)
            .on('response', function (res) { callback(null, res); });

            sendRequest();
            return point;
        }

        this.context.$requestStream ? sendRequest() : setTimeout(sendRequest, 0);

        return point;
    },

    respond: function respond$(response) {
        this.send({
            type: 'response',
            flow: Types.RESPONSE,
            ref: response
        });

        return this;
    },

    streamResponse: function streamResponse$(response) {
        this.context.$responseStream = true;
        var point = this.respond(response);

        return createWriteStream({
            channel: point,
            flow: Types.RESPONSE
        });
    },

    /*
    * Message handlers will be attached to specific context and mapped to a specific point by its _id
    * This is need to avoid re-creating pipe for every new context
    */
    on: function onEvent$(type, handler) {
        var handlers = this.handlers();
        if (handlers[type]) {
            throw new Error('The hook has already been registered, you can use only one hook for specific event type: ' + type);
        }
        handlers[type] = handler;
        return this;
    },

    once: function onceEvent$(type, handler) {
        var self = this;
        this.on(type, function onceFn() {
            delete self.handlers()[type];
            handler.apply(null, arguments);
        });
        return this;
    },

    handlers: function handlers(ctx) {
        ctx = ctx || this.context;
        if (!ctx) {
            throw new Error('Context is missing, please make sure context() is used first');
        }
        ctx = ctx.$points = ctx.$points || {};
        ctx = ctx[this._id] = ctx[this._id] || {};
        ctx._messageHandlers = ctx._messageHandlers || {};
        return ctx._messageHandlers;
    }
};

function createWriteStream(ctx) {
    var type = ctx.flow === Types.REQUEST ? 'request:data' : 'response:data';
    var channel = ctx.channel;

    function _write(data) {
        if (channel._streamClosed) {
            throw new Error('The stream has been closed already');
        }

        if (data === undefined) {
            ctx.channel._streamClosed = true;
        }

        channel.send({
            type: type,
            flow: ctx.flow,
            ref: data
        });
    }

    return {
        write: function write$(data) {
            _write(data);
            return this;
        },

        end: function end$() {
            _write();
            return channel;
        }
    };
}
