const WS = require('ws');
const EventEmitter = require('events').EventEmitter;

class GitbookWS extends EventEmitter {
    constructor(ws_uri) {
        super();

        this.keepalive_timer = null;
        this.connected = false;
        this.msg_seg = 0;
        this.str_buf = "";
        this.json_buf = null;
        this.data = {}; // r idx => {r, req, res, resolve, reject}
        this.cur_r = 1;
        this.ready_promises = [];

        this.ws = new WS(ws_uri);
        this.ws.addEventListener('message', (evt) => {
            this.wsMessage(evt.data)
        });
        this.ws.addEventListener('close', (code, reason) => {
            this.close();
        });
        this.ws.addEventListener('error', (error) => {
            this.close();
        });
    }

    close() {
        this.connected = false;
        this.stopKeepalive();
        if (this.ws && this.ws.readyState != this.ws.CLOSED) {
            this.ws.terminate();
        }
    }

    startKeepalive() {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
        if (this.keepalive_timer) return;
        this.keepalive_timer = setInterval(() => {
            this.ws.send(0);
        },60000);
    }
    stopKeepalive() {
        clearInterval(this.keepalive_timer);
        this.keepalive_timer = null;
    }

    processPromise() {
        for(var r in this.data) {
            var pair = this.data[r];
            if (pair.resolve) {
                var res = this.retrieve(pair.r);
                if (res) {
                    pair.resolve(res);
                }
            }
        }
    }

    wsMessage(message) {
        if (this.msg_seg) { // reciving segmented msg
            this.str_buf += message;
            this.msg_seg--;
            if (this.msg_seg === 0) {
                this.json_buf = JSON.parse(this.str_buf).d;
                this.str_buf = "";
            }
        // number only (huge data total frames)
        } else if (/^\d+$/.test(message)) {
            this.msg_seg = parseInt(message, 10);
        } else { // normal (JSON in single frame)
            var json = JSON.parse(message);
            switch(json.t) {
                case "c": // first connected
                    this.startKeepalive();
                    this.connected = true;
                    while (this.ready_promises.length !== 0) {
                        var promise = this.ready_promises.pop();
                        promise.resolve();
                    }
                    break;
                case "d":
                    if (json.d.r) { // numbered response -> ok msg or full response
                        var pair = this.data[json.d.r];
                        if (pair && pair.req) { // has req obj
                            var req = pair.req;
                            if (json.d.b.s === "ok") {
                                var res = pair.res = json.d;
                                if (this.json_buf) { // has previous got msg -> merge
                                    res.a = this.json_buf.a;
                                    var tmp_s = res.b.s;
                                    res.b = this.json_buf.b;
                                    res.b.s = tmp_s;
                                    this.json_buf = null;
                                }
                            } else {
                                // request error ???
                            }
                        } else {
                            // not requested data ???
                        }
                    } else { //
                        if (json.d.a === "m") { // update push info
                            this.emit('updatePush', json.d);
                        } else { // other response (will follow by a ok msg
                            this.json_buf = JSON.parse(message).d;
                        }
                    }
                    break;
                default:
            }
        }
        this.processPromise();
    }

    async ready() {
        return new Promise((resolve, reject) => {
            this.ready_promises.push({
                resolve: resolve,
                reject: reject
            });
        });
    }

    async request(data) {
        if (typeof data === 'string') {
            data = {
                a: "q",
                b: {
                    p: data,
                    h: ""
                }
            };
        }
        return new Promise((resolve, reject) => {
            var r = this.send(data);
            var pair = this.data[r];
            pair.resolve = resolve;
            pair.reject = reject;
        });
    }

    send(data, type) {
        var r = this.cur_r++;

        var req = {
            t: type ? type : "d"
        };
        req.d = data;
        req.d.r = r;
        this.data[r] = {
            r: r,
            req: req
        };
        this.ws.send(JSON.stringify(req));

        return r;
    }
    retrieve(r) {
        var pair = this.data[r];
        if (pair && pair.res) {
            var data = this.data[r];
            delete this.data[r];
            return data.res;
        } else {
            return null;
        }
    }
}

module.exports = GitbookWS;
