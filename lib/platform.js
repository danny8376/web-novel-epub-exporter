const MAPPING = [
    [/^https?:\/\/.+\.gitbook\.io\//, 'gitbook'],
    [/^https?:\/\/lolitensei\.com\//, 'lolitensei'],
]

class Platform {
    static reqAndNew(conf) {
        const options = conf.options || {};
        const book = conf.book || {};
        if (conf.book_uri) { // auto detect
            for (let i in MAPPING) {
                const [regex, platform] = MAPPING[i];
                if (regex.test(conf.book_uri)) {
                    book.uri = conf.book_uri;
                    book.platform = platform;
                    break;
                }
            }
        }
        if (book.platform) {
            try {
                const platform = require('./platforms/' + book.platform);
                return new platform(book, options);
            } catch(err) {
                throw err;
            }
        } else {
            throw 'unknown platform: ' + book.platform;
        }
    }
}

module.exports = Platform;
