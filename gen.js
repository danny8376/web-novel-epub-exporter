const Config = require('./lib/config');
const Gitbook = require('./lib/gitbook');

function main() {
    const configs = Config.parse(process.argv[2]);
    configs.forEach(async (config) => {
        const gitbook = new Gitbook(config);
        await gitbook.ready();
        gitbook.gen(true, true, true);
        gitbook.autoRegen(true, true, true);
    });
}
main();
