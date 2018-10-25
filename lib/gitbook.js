const GitbookWS = require('./gitbookws');
//const requestp = require('request-promise-native');
const request = require('request');
const EventEmitter = require('events').EventEmitter;
const epubmaker2 = require('epub-maker2');
const EpubMaker = epubmaker2.EpubMaker;
const fs = require('fs');
const child_process = require('child_process');
const crypto = require('crypto');

class Gitbook extends EventEmitter {
    constructor(book_uri, options) {
        super();

        this.CDNREPLACE = "https://firebasestorage.googleapis.com/v0/b/";

        this.spaceQuery = "";

        if (typeof book_uri === "object") {
            options = book_uri.options;
            book_uri = book_uri.book_uri;
        }

        this.book_uri = book_uri;
        /*
         * {
         *   ignore: [<id or uri 1>, <id or uri 2>, ...],
         *   dest: "<dest folder>",
         *   cache: "<cache folder>",
         *   newEPUBHook: "<command line> ( ${HASH_SHA256} replaced by sha256 hash)"
         *   newTXTHook: "<command line> ( ${HASH_SHA256} replaced by sha256 hash)"
         *   newIndexHook: "<command line> ( ${HASH_SHA256} replaced by sha256 hash)"
         * }
         */
        this.options = options || {};
        this.projectId = null;
        this.spaceId = null;
        this.cdnBolb = null;
        this.ws = null;
        this.rev = "";
        this.name = "";
        this.logoURL = "";
        this.updatedAt = 0;
        this.book = null;
        this.pages = null;
        this.assets = null;
        this.usedAssets = {};
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
        this.ws.close();
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

    async init() {
        await this.retrieveConfig();
        await this.retrieveMeta();

        this.emit('ready');
    }

    async retrieveConfig() {
        return new Promise(async (resolve, reject) => {
            const book_html = await this.request(this.book_uri);
            const match = /\s*window\.GITBOOK_STATE\s*=\s*(.*)/.exec(book_html);
            const meta_str = match[1].endsWith(";") ? match[1].slice(0, -1) : match[1];
            const meta = JSON.parse(meta_str);

            this.projectId = meta.store.config.firebase.projectId;
            this.spaceId = meta.props.spaceID;
            this.cdnBolb = meta.store.config.cdn.blobsurl;

            this.spaceQuery = "/spaces/" + this.spaceId + "/infos";

            resolve();
        });
    }

    async retrieveMeta() {
        return new Promise(async (resolve, reject) => {
            this.ws = new GitbookWS("wss://" + this.projectId + ".firebaseio.com/.ws?v=5");
            this.ws.addListener('updatePush', (json) => {
                this.updatePush(json);
            });
            this.ws.addListener('reconnecting', () => {
                // after reconnected, in case of lose update event, try to update
                this.ws.once('ready', async () => {
                    console.info("reconnected, try to check update");
                    const json = await this.ws.request(this.spaceQuery);
                    if (this.rev !== json.b.d.primaryRevision) {
                        this.doBookRefresh();
                    }
                });
            });
            await this.ws.ready();

            const info_res = await this.ws.request(this.spaceQuery);
            const info = info_res.b.d;
            this.rev = info.primaryRevision;
            this.name = info.name;
            this.logoURL = info.logoURL;
            this.updatedAt = info.updatedAt;

            this.book = await this.ws.request("/spaces/" + this.spaceId + "/revisions/" + this.rev);
            this.assets = this.book.b.d.content.assets;

            this.genIndex();

            resolve();
        });
    }

    async doBookRefresh() {
        console.info("book updated, refresh");
        await this.retrieveMeta();
        this.emit('bookRefresh');
    }

    async updatePush(json) {
        if (this.spaceQuery === "/" + json.b.p) {
            if (this.rev !== json.b.d.primaryRevision) {
                this.doBookRefresh();
            }
        }
    }

    replaceCDNBolb(uri) {
        if (!uri) return uri;
        if (uri.startsWith(this.CDNREPLACE)) {
            return this.cdnBolb + uri.slice(this.CDNREPLACE.length);
        }
        return uri;
    }

    /*
     * [
     *  0: entry
     *  1: page
     *     {
     *       type: "page"
     *       title
     *       desc
     *       id
     *       path
     *       rev
     *       docURL
     *       doc
     *     }
     *  2: page
     *  3: section
     *     {
     *       type: "section"
     *       title
     *       desc
     *       children
     *       [
     *         ...
     *       ]
     *     }
     *  4: group -> treat as section
     *     {
     *       type: "section"
     *       title
     *       desc
     *       children
     *       [
     *         ...
     *       ]
     *     }
     * ]
     */

    listSubpages(id) {
        const page = this.pages[id];
        const section = {
            type: "section",
            title: page.title,
            desc: page.description,
            children: []
        };
        if (page.documentURL) { // page itself has content -> insert page itself into section
            section.children.push({
                type: "page",
                title: page.title,
                desc: page.description,
                docURL: this.replaceCDNBolb(page.documentURL)
            });
        }
        const ignore = this.options.ignore || [];
        for (let i in page.pages) {
            const pageId = page.pages[i];
            if (ignore.includes(pageId)) continue;
            const subpage = this.pages[pageId];
            if (ignore.includes(subpage.path)) continue;
            switch (subpage.kind) {
                case "document":
                    if (subpage.pages) {
                        section.children.push(this.listSubpages(pageId));
                    } else {
                        section.children.push({
                            type: "page",
                            title: subpage.title,
                            desc: subpage.description,
                            id: pageId,
                            path: subpage.path,
                            rev: subpage.stats.revisions,
                            docURL: this.replaceCDNBolb(subpage.documentURL)
                        });
                    }
                    break;
                case "group":
                    section.children.push(this.listSubpages(pageId));
                    break;
                default:
            }
        }
        return section;
    }

    genIndex() {
        const content = this.book.b.d.content;
        const ver = content.primaryVersion;
        const curr = content.versions[ver];
        const entryId = curr.entryPage;
        this.pages = curr.pages;

        const section = this.listSubpages(entryId);
        this.index = section.children;
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

    async retrieveAssets(assetId) {
        return new Promise((resolve, reject) => {
            resolve(assetId);
        });
    }

    getAsset(assetId) {
        const asset = this.assets[assetId];
        let name = assetId;
        if (asset) {
            const oriName = asset.name;
            const extPos = oriName.lastIndexOf(".");
            if (extPos !== -1) {
                name = assetId + oriName.slice(extPos);
            }
            if (!this.usedAssets[assetId]) {
                this.usedAssets[assetId] = {
                    dlURL: asset.downloadURL,
                    name: name
                };
            }
        }
        return name;
    }

    async retrieveDocs(nodes, pages) {
        const promises = [];
        pages = pages || [];
        (nodes || this.index).forEach((node) => {
            switch (node.type) {
                case "page":
                    if (node.docURL) {
                        pages.push(node);
                    }
                    break;
                case "section":
                    this.retrieveDocs(node.children, pages);
                    break;
                default:
            }
        });
        if (!nodes) {
            let cnt = 0;
            const batch = 25; // config - max parallel requests
            while (pages.length > 0) {
                if (cnt < batch) {
                    promises.push(new Promise(async (resolve, reject) => {
                        const node = pages.pop();
                        if (node.docURL) {
                            const doc_str = await this.request(node.docURL);
                            console.info(node.title + " downloaded");
                            node.doc = JSON.parse(doc_str).document;
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

    nodesToText(node, no_img) {
        let output = "";
        switch (node.kind) {
            case "document":
            case "inline":
                node.nodes.forEach((subnode) => {
                    output += this.nodesToText(subnode, no_img);
                });
                break;
            case "block":
                switch (node.type) {
                    case "image":
                        if (!no_img) {
                            output += "<img src=\"" + this.getAsset(node.data.assetID) + "\"/>\n";
                        }
                        break;
                    case "paragraph":
                        node.nodes.forEach((subnode) => {
                            output += this.nodesToText(subnode, no_img);
                        });
                        output += "\n";
                        break;
                    default:
                }
                break;
            case "text":
                node.ranges.forEach((subnode) => {
                    output += this.nodesToText(subnode, no_img);
                });
                break;
            case "range":
                output += node.text;
                break;
            default:
        }
        return output;
    }

    // from splitTxt @ github.com/bluelovers/js-epub-maker/test/txt2epub3.ts
    transformTextEPUB(text) {
        return (
            '<p>' +
            text
                .toString()
                .replace(/\r\n|\r(?!\n)|\n/g, "\n")

                .replace(/\u003C/g, '&lt;')
                .replace(/\u003E/g, '&gt;')

                .replace(/&lt;(img.+)\/?&gt;/gm, (...m) => {
                    return `<${m[1].replace(/\/+$/, '')} class="inner-image"/>`;
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

/*
    newSection(type, cnt, data) {
        switch (type) {
            case 'volume':
                    return new EpubMaker.Section('auto-toc', 'volume' + cnt, data, false, true);
                break;
            case 'chpater':
                    return new EpubMaker.Section('chapter', 'chapter' + cnt, data, true, false);
                break;
            default:
        }
    }
*/

    renderPagesEPUB(pages, section, counter) {
        counter = counter || {
            vol: 0,
            ch: 0
        };
        (pages || this.index).forEach((page) => {
            switch (page.type) {
                case "page":
                    console.info("EPUB rendering " + page.title);
                    const text = page.doc ? this.transformTextEPUB(this.nodesToText(page.doc)) : "";
                    if (section) {
                        counter.ch++;
                        section.withSubSection(new EpubMaker.Section('chapter', 'chapter' + counter.ch, {
                                        title: page.title,
                                        content: text
                                    }, true, false));
                        /*
                        section.withSubSection(this.newSection('chapter', counter.ch, {
                                        title: page.title,
                                        content: text
                                    }));
                        */
                    } else {
                        counter.vol++;
                        this.epub.withSection(new EpubMaker.Section('auto-toc', 'volume' + counter.vol, {
                                        title: page.title,
                                        content: text
                                }, false, true));
                        /*
                        this.epub.withSection(this.newSection('volume', counter.vol, {
                                        title: page.title,
                                        content: text
                                }));
                        */
                    }
                    break;
                case "section":
                    counter.vol++;
                    const subsection = new EpubMaker.Section('auto-toc', 'volume' + counter.vol, {
                                        title: page.title
                                     }, false, true);
                    /*
                    const subsection = this.newSection('volume', counter.vol, {
                                        title: page.title
                                     });
                    */
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
        for (let id in this.usedAssets) {
            const asset = this.usedAssets[id];
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
            .withModificationDate(this.updatedAt)
            .addLinks(this.book_uri)
            //.withPublisher('Gitbook')
            ;

        if (this.logoURL) {
            this.epub.withCover(this.logoURL);
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
                    if (page.doc) {
                        text = this.transformTextTXT(this.nodesToText(page.doc, true)) + "\r\n\r\n";
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
        await this.retrieveDocs();

        if (epub) this.genEPUB();
        if (txt) this.genTXT();
        if (index) this.genIndexFile();
    }

    autoRegen(epub, txt, index) {
        this.addListener('bookRefresh', () => {
            this.gen(epub, txt, index);
        });
    }

    async test() {
        console.log(this.indexToText(false, true));
        this.close();
    }
}

module.exports = Gitbook;
