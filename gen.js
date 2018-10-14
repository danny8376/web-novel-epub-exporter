const Gitbook = require('./lib/gitbook');
const fs = require('fs');

async function main() {
    var config = JSON.parse(fs.readFileSync(process.argv[2]));
    var gitbook = new Gitbook(config.book_uri, config.options);
    await gitbook.ready();
    gitbook.gen(true, true, true);
    gitbook.autoRegen(true, true, true);
}
main();
