const request = require('request');
const EventEmitter = require('events').EventEmitter;
const epubmaker2 = require('epub-maker2');
const EpubMaker = epubmaker2.EpubMaker;
const fs = require('fs');
const child_process = require('child_process');
const crypto = require('crypto');
const Entities = require('html-entities').XmlEntities;
const entities = new Entities();

/*
 * # methods:
 * doBookRefresh => call when updated
 * # prop:
 * name => book name
 * updateAt => when updated
 * cover => cover
 * # methods impl:
 * close
 * initPlatform => promise
 * retrieveInfo => promise
 * resolvePage(idx node<type page>) => promise
 * pageToText(idx node<type page>, incl img<bool>) => str
 */
class Exporter extends EventEmitter {
    constructor(book, options) {
        super();

        /* ### this.book
         * {
         *   platform: platform class name
         *   uri: if available, this is should be uri of source
         *   <other platform specific info>
         * }
         */
        this.book = book;
        /* ### this.options
         * {
         *   dest: "<dest folder>",
         *   cache: "<cache folder>",
         *   newEPUBHook: "<command line> ( ${HASH_SHA256} replaced by sha256 hash)"
         *   newTXTHook: "<command line> ( ${HASH_SHA256} replaced by sha256 hash)"
         *   newIndexHook: "<command line> ( ${HASH_SHA256} replaced by sha256 hash)"
         *   <platform specific options>
         * }
         */
        this.options = options || {};
        this.name = "";
        this.updatedAt = null;
        this.cover = null;
        /* ### this.assets
         * assets mapping
         * if there's no mapping (Ex. embed uri), just left it null
         * otherwise, it should be array(or obj, just a key=>value pair)
         * key => string of uri
         * or
         * key => {
         *   name
         *   uri
         * }
         */
        this.assets = null;
        this.renderAssets = {};
        /* ### this.index
         * index is a array of idx nodes
         * there's two type
         * > page
         *   {
         *     type: "page"
         *     title
         *     desc
         *     data : <this is platform specific>
         *   }
         * > section
         *   {
         *     type: "section"
         *     title
         *     desc
         *     children
         *     [
         *       ...
         *     ]
         *   }
         */
        this.index = [];

        this.epub = null;

        this.init();
    }

    async ready() {
        return new Promise((resolve, reject) => {
            this.once('ready', () => {
                resolve();
            });
        });
    }

    close() {
        // platform specific
    }

    request(options, cnt, resolve, reject) {
        if (typeof cnt === "number") {
            request(options, (err, res, data) => {
                if (err) {
                    if (cnt > 6) { // try 0~6 => total about 2.1 minutes max
                        reject(err);
                    } else {
                        const wait = 1000 * Math.pow(2, cnt++);
                        setTimeout(() => {
                            this.request(options, cnt, resolve, reject);
                        }, wait);
                    }
                } else {
                    resolve(data);
                }
            });
        } else {
            return new Promise((resolve, reject) => {
                this.request(options, 0, resolve, reject);
            });
        }
    }

    initPlatform() { // return promise
        // platform specific
        // <some init here>
    }

    retrieveInfo() { // return promise
        // platform specific
        // <some retrieve action here>
        // this.index = <blahblah>;
    }

    async init() {
        try {
            await this.initPlatform();
            await this.retrieveInfo();
            this.emit('ready');
        } catch(err) {
            console.err(err);
        }
    }

    async doBookRefresh(no_pull) { // call this function for update trigger
        console.info("book updated, refresh");
        try {
            if (!no_pull) {
                await this.retrieveInfo();
            }
        } catch(err) {
            console.err(err);
        }
        this.emit('bookRefresh');
    }

    getAsset(assetKey) {
        let asset;
        if (this.assets) { // with mapping
            asset = this.assets[assetKey];
        } else { // direct uri
            asset = assetKey;
            const hash = crypto.createHash('md5');
            hash.update(assetKey);
            assetKey = hash.digest('hex');
        }
        if (asset) {
            if (this.renderAssets[assetKey]) {
                return this.renderAssets[assetKey].name;
            } else {
                const oriName = asset.name || asset;
                const extPos = oriName.lastIndexOf(".");
                const name = assetKey + (extPos !== -1 ? oriName.slice(extPos) : "");
                this.renderAssets[assetKey] = {
                    dlURL: asset.uri || asset,
                    name: name
                };
                return name;
            }
        } else {
            return "";
        }
    }

    resolvePage(node) { // return promise
        // platform specific
    }

    async retrievePages(nodes, pages) {
        pages = pages || [];
        // flaten index to pages
        (nodes || this.index).forEach((node) => {
            switch (node.type) {
                case "page":
                    if (node.data) {
                        pages.push(node);
                    }
                    break;
                case "section":
                    this.retrievePages(node.children, pages);
                    break;
                default:
            }
        });
        // parrel download part
        // won't be called in recursion
        if (!nodes) {
            let cnt = 0;
            const promises = [];
            const batch = 25; // config - max parallel requests
            while (pages.length > 0) {
                if (cnt < batch) {
                    promises.push(new Promise(async (resolve, reject) => {
                        const node = pages.pop();
                        if (node.data) {
                            try {
                                await this.resolvePage(node);
                            } catch(err) {
                                console.err(err);
                            }
                            console.info(node.title + " downloaded");
                        }
                        resolve();
                    }));
                    cnt++;
                } else {
                    await Promise.all(promises);
                    cnt = 0;
                }
            }
            return Promise.all(promises);
        }
    }

    // from splitTxt @ github.com/bluelovers/js-epub-maker/test/txt2epub3.ts
    transformTextEPUB(text) {
        return (
            '<p>' +
            entities.encode(text.toString())

                .replace(/\r\n|\r(?!\n)|\n/g, "\n")

                .replace(/&lt;(img.+)\/?&gt;/gm, (...m) => {
                    return `<${entities.decode(m[1].replace(/\/+$/, ''))} class="inner-image"/>`;
                })

                .replace(/^[・―－＝\-—\=─]{3,}$/mg, '<hr/>')

                .replace(/^-$/mg, '<hr/>') // @_@

                .replace(/\n/g, '</p><p>')
            + '</p>')

            .replace(/<p><hr\/><\/p>/g, '<hr class="linehr"/>')

            .replace(/<p><\/p>/g, '<p class="linegroup softbreak">　 </p>')
            .replace(/<p>/g, '<p class="linegroup calibre1">'
        );
    }

    pageToText(node, img) {
        // platform specific
        // should return pure text
        // (excpet for img)
    }

    renderPagesEPUB(pages, section, counter) {
        counter = counter || {
            vol: 0,
            ch: 0
        };
        (pages || this.index).forEach((page) => {
            switch (page.type) {
                case "page":
                    console.info("EPUB rendering " + page.title);
                    const text = page.data ? this.transformTextEPUB(this.pageToText(page, true)) : "";
                    if (section) {
                        counter.ch++;
                        section.withSubSection(new EpubMaker.Section('chapter', 'chapter' + counter.ch, {
                                        title: page.title,
                                        content: text
                                    }, true, false));
                    } else {
                        counter.vol++;
                        this.epub.withSection(new EpubMaker.Section('auto-toc', 'volume' + counter.vol, {
                                        title: page.title,
                                        content: text
                                }, false, true));
                    }
                    break;
                case "section":
                    counter.vol++;
                    const subsection = new EpubMaker.Section('auto-toc', 'volume' + counter.vol, {
                                        title: page.title
                                     }, false, true);
                    this.renderPagesEPUB(page.children, subsection, counter);
                    if (section) {
                        section.withSubSection(subsection);
                    } else {
                        this.epub.withSection(subsection);
                    }
                    break;
                default:
            }
        });
    }

    renderAssetsEPUB() {
        for (let id in this.renderAssets) {
            const asset = this.renderAssets[id];
            this.epub.withAdditionalFile(asset.dlURL, null, asset.name);
        }
    }

    writeFile(fn, data) {
        return new Promise((resolve, reject) => {
            fs.writeFile(fn, data, (err) => {
                const hash = crypto.createHash('sha256');
                hash.update(data);
                resolve(hash.digest('hex'));
            })
        });
    }

    async writeEPUB(dest) {
        const fn = dest + "/" + this.epub.getFilename(true);

        /*
        const data = await this.epub.makeEpub();
        const sha256 = await this.writeFile(fn, data);
        console.info("EPUB file written, sha256:", sha256);
        */

        console.info("preparing for generating epub");
        let sha256 = "";
        await this.epub.build()
            .then((epubZip) => {
                console.info("generating epub for", this.name);
                return epubZip.generateNodeStream(Object.assign({
                    type: 'nodebuffer',
                    mimeType: 'application/epub+zip',
                    compression: 'DEFLATE',
                    compressionOptions: {
                        level: 9
                    },
                }, this.epub.epubConfig.options.generateOptions));
            })
            .then((epubZipStream) => {
                return Promise.all([
                    new Promise((resolve, reject) => {
                        const file = fs.createWriteStream(fn);
                        file.on('close', () => {
                            console.info("EPUB file written");
                            resolve();
                        });
                        epubZipStream.pipe(file);
                    }),
                    new Promise((resolve, reject) => {
                        const hash = crypto.createHash('sha256');
                        hash.on('readable', () => {
                            const data = hash.read();
                            if (data) {
                                sha256 = data.toString('hex');
                                console.info("EPUB file sha256:", sha256);
                                resolve();
                            }
                        });
                        epubZipStream.pipe(hash);
                    })
                ]);
            });

        if (this.options.newEPUBHook) {
            console.info("run EPUB hook");
            child_process.exec(this.options.newEPUBHook.replace("${HASH_SHA256}", sha256));
        }
    }

    async genEPUB(dest) {
        console.info("preparing epub")
        this.epub = new EpubMaker()
            .withTemplate('lightnovel')
            .withLanguage('zh')
            .withTitle(this.name)
            .withCollection({ name: this.name })
            .withModificationDate(this.updatedAt || new Date())
            //.withPublisher('Gitbook')
            ;

        if (this.book.uri) {
            this.epub.addLinks(this.book.uri)
        }
        if (this.cover) {
            this.epub.withCover(this.cover);
        }

        this.renderPagesEPUB();
        this.renderAssetsEPUB();

        console.info("downloading assets & generating EPUB");
        this.writeEPUB(dest || this.options.dest);
    }

    transformTextTXT(text) {
        return text
                .toString()
                .replace(/\r\n|\r(?!\n)|\n/g, "\n")
                .replace(/\n/g, "\r\n")
               ;
    }

    renderPagesTXT(pages) {
        let output = "";
        if (!pages) {
            output = "==== " + this.name + " ====\r\n\r\n";
        }
        (pages || this.index).forEach((page) => {
            switch (page.type) {
                case "page":
                    console.info("TXT rendering " + page.title);
                    let text = "";
                    if (page.data) {
                        text = this.transformTextTXT(this.pageToText(page, false)) + "\r\n\r\n";
                    }
                    output += "---- " + page.title + " ----\r\n\r\n" + text;
                    break;
                case "section":
                    output += "==== " + page.title + " ====\r\n\r\n"
                    output += this.renderPagesTXT(page.children);
                    break;
                default:
            }
        });
        return output;
    }

    async genTXT(dest) {
        const fn = (dest || this.options.dest) + "/" + this.name + ".txt";

        console.info("generating TXT");
        const data = this.renderPagesTXT();

        const sha256 = await this.writeFile(fn, "\ufeff" + data);
        console.info("TXT file written, sha256:", sha256);

        if (this.options.newTXTHook) {
            console.info("run TXT hook")
            child_process.exec(this.options.newTXTHook.replace("${HASH_SHA256}", sha256));
        }
    }

    indexToText(prepend, reverse, idx, prefix) {
        const prefixAppend = prepend ? "  > " : "";
        let list = [];
        prefix = prefix || "";

        (idx || this.index).forEach((child) => {
            switch (child.type) {
                case "section":
                    list.push(prefix + child.title);
                    let sublist = this.indexToText(prepend, reverse, child.children, prefix + prefixAppend);
                    Array.prototype.push.apply(list, sublist); // some hack for concat :-P
                    break;
                case "page":
                    list.push(prefix + child.title);
                    break;
                default:
            }
        });

        if (idx) {
            return list;
        } else {
            return (reverse ? list.reverse() : list).join("\n");
        }
    }

    async genIndexFile(dest) {
        const fn = (dest || this.options.dest) + "/" + this.name + ".index.txt";

        console.info("generating index file");
        const data = this.indexToText(true);

        const sha256 = await this.writeFile(fn, "\ufeff" + data);
        console.info("index file written, sha256:", sha256);

        if (this.options.newIndexHook) {
            console.info("run index file hook")
            child_process.exec(this.options.newIndexHook.replace("${HASH_SHA256}", sha256));
        }
    }

    async gen(epub, txt, index) {
        console.info("downloading pages");
        await this.retrievePages();

        if (epub) this.genEPUB();
        if (txt) this.genTXT();
        if (index) this.genIndexFile();
    }

    autoRegen(epub, txt, index) {
        this.addListener('bookRefresh', () => {
            this.gen(epub, txt, index);
        });
    }
}

module.exports = Exporter;
