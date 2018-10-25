const fs = require('fs');

class Config {
    static parse(conf) {
        const result = [];
        const files = [];
        let json = null;
        conf = conf || true;
        switch (conf.constructor.name) {
            case "String":
                if (conf[0] === "{" || conf[0] === "[") {
                    json = JSON.parse(conf);
                } else {
                    files.push(conf);
                    json = JSON.parse(fs.readFileSync(conf));
                }
                break;
            case "Buffer":
                json = JSON.parse(conf);
                break;
            case "Array":
            case "Object":
                json = conf;
                break;
            default:
                throw "wrong arg type";
        }
        return Config.parseObject(json, files);
    }

    static parseObject(obj, files) {
        files = files || []
        let result = [];
        obj = obj || true;
        switch (obj.constructor.name) {
            case "Array":
                obj.forEach((val) => {
                    Array.prototype.push.apply(result, Config.parseObject(val, files)); // concat
                });
                break;
            case "Object":
                if (obj.hasOwnProperty("include")) { // include file
                    if (!files.includes(obj.include)) {
                        files.push(obj.include);
                        let json = JSON.parse(fs.readFileSync(obj.include));
                        Array.prototype.push.apply(result, Config.parseObject(json, files)); // concat
                    }
                } else {
                    result.push(obj);
                }
                break;
            default:
                throw "wrong config";
        }
        return result;
    }
}

module.exports = Config;
