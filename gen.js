const Config = require('./lib/config');
const Platform = require('./lib/platform');

function main() {
    const configs = Config.parse(process.argv[2]);
    configs.forEach(async (config) => {
        const book = Platform.reqAndNew(config);
        await book.ready();
        book.gen(true, true, true);
        book.autoRegen(true, true, true);
    });
}
main();
