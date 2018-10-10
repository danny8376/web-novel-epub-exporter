const request = require('request-promise-native');
const WS = require('ws');
const EventEmitter = require('events').EventEmitter;
const epubmaker2 = require('epub-maker2');
const EpubMaker = epubmaker2.EpubMaker;
const fs = require('fs');
const child_process = require('child_process');

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

class Gitbook extends EventEmitter {
    constructor(book_uri, options) {
        super();

        this.CDNREPLACE = "https://firebasestorage.googleapis.com/v0/b/";
        this.EPUB_CACHE = "/tmp/epubcache";

        this.spaceQuery = "";

        this.book_uri = book_uri;
        /*
         * {
         *   ignore: [<id or uri 1>, <id or uri 2>, ...],
         *   dest: "<dest folder>",
         *   cache: "<cache folder>",
         *   newEPUBHook: "<command line>"
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

        this.ready_promises = [];

        this.init();
    }

    async ready() {
        return new Promise((resolve, reject) => {
            this.ready_promises.push({
                resolve: resolve,
                reject: reject
            });
        });
    }

    close() {
        this.ws.close();
    }

    async init() {
        await this.retrieveConfig();
        await this.retrieveMeta();

        while (this.ready_promises.length !== 0) {
            var promise = this.ready_promises.pop();
            promise.resolve();
        }
    }

    async retrieveConfig() {
        return new Promise(async (resolve, reject) => {
            var book_html = await request(this.book_uri);
            var match = /\s*window\.GITBOOK_STATE\s*=\s*(.*)/.exec(book_html);
            var meta_str = match[1].endsWith(";") ? match[1].slice(0, -1) : match[1];
            var meta = JSON.parse(meta_str);

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
            await this.ws.ready();

            var info_res = await this.ws.request(this.spaceQuery);
            var info = info_res.b.d;
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

    async updatePush(json) {
        if (this.spaceQuery === "/" + json.b.p) {
            if (this.rev !== json.b.d.primaryRevision) {
                await this.retrieveMeta();
                this.emit('bookRefresh');
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
        var page = this.pages[id];
        var section = {
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
        var ignore = this.options.ignore || [];
        for (var i in page.pages) {
            var pageId = page.pages[i];
            if (ignore.includes(pageId)) continue;
            var subpage = this.pages[pageId];
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
        var content = this.book.b.d.content;
        var ver = content.primaryVersion;
        var curr = content.versions[ver];
        var entryId = curr.entryPage;
        this.pages = curr.pages;
    
        var section = this.listSubpages(entryId);
    
        this.index = section.children;
    }

    printIndex(idx, prefix) {
        var output = "";
        prefix = prefix || "";
        (idx || this.index).forEach((child) => {
            switch (child.type) {
                case "section":
                    output += prefix + child.title + "\n"
                    output += this.printIndex(child.children, prefix + "  > ");
                    break;
                case "page":
                    output += prefix + child.title + "\n";
                    break;
                default:
            }
        });

        if (idx) {
            return output
        } else {
            console.log(output);
        }
    }

    async retrieveAssets(assetId) {
        return new Promise((resolve, reject) => {
            resolve(assetId);
        });
    }

    getAsset(assetId) {
        var asset = this.assets[assetId];
        var name = assetId;
        if (asset) {
            var oriName = asset.name;
            var extPos = oriName.lastIndexOf(".");
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
        var promises = [];
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
            var cnt = 0;
            var batch = 25;
            while (pages.length > 0) {
                if (cnt < batch) {
                    promises.push(new Promise(async (resolve, reject) => {
                        var node = pages.pop();
                        if (node.docURL) {
                            var doc_str = await request(node.docURL);
                            console.log(node.title + " downloaded"); // log info
                            node.doc = JSON.parse(doc_str).document;
                            resolve();
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

    nodesToText(node) {
        var output = "";
        switch (node.kind) {
            case "document":
                node.nodes.forEach((subnode) => {
                    output += this.nodesToText(subnode);
                });
                break;
            case "block":
                switch (node.type) {
                    case "image":
                        output += "<img src=\"" + this.getAsset(node.data.assetID) + "\"/>";
                        break;
                    case "paragraph":
                        node.nodes.forEach((subnode) => {
                            output += this.nodesToText(subnode);
                        });
                        break;
                    default:
                }
                break;
            case "text":
                node.ranges.forEach((subnode) => {
                    output += this.nodesToText(subnode);
                });
                break;
            case "range":
                output += node.text;
                break;
            default:
        }
        return output;
    }

    // from splitTxt @ github.com/bluelovers/js-epub-maker/txt2epub3.ts
    transformText(text) {
        return (
            '<p>' +
            text
                .toString()
                .replace(/\r\n|\r(?!\n)|\n/g, "\n")
    
                .replace(/\u003C/g, '&lt;')
                .replace(/\u003E/g, '&gt;')
    
                .replace(/&lt;(img.+)\/?&gt;/gm, (...m) => {
                    //console.log(m);
    
                    return `<${m[1].replace(/\/+$/, '')} class="inner-image"/>`;
                })
    
                .replace(/^[――－＝\-—\=─]{3,}$/mg, '<hr/>')
    
                .replace(/\n/g, '</p><p>')
            + '</p>')
    
            .replace(/<p><hr\/><\/p>/g, '<hr class="linehr"/>')
    
            .replace(/<p><\/p>/g, '<p class="linegroup softbreak">　 </p>')
            .replace(/<p>/g, '<p class="linegroup calibre1">');
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

    renderPages(pages, section, counter) {
        counter = counter || {
            vol: 0,
            ch: 0
        };
        (pages || this.index).forEach((page) => {
            switch (page.type) {
                case "page":
                    console.log("rendering " + page.title); // log info
                    var text = page.doc ? this.transformText(this.nodesToText(page.doc)) : "";
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
                    var subsection = new EpubMaker.Section('auto-toc', 'volume' + counter.vol, {
                                        title: page.title
                                     }, false, true);
                    /*
                    var subsection = this.newSection('volume', counter.vol, {
                                        title: page.title
                                     });
                    */
                    this.renderPages(page.children, subsection, counter);
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

    renderAssets() {
        for (var id in this.usedAssets) {
            var asset = this.usedAssets[id];
            this.epub.withAdditionalFile(asset.dlURL, null, asset.name);
        }
    }

    async genEPUB(dest) {
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

        console.log("downloading pages"); // log info
        await this.retrieveDocs();

        this.renderPages();
        this.renderAssets();

        console.log("downloading assets & generating EPUB"); // log info
        this.writeEPUB(dest || this.options.dest);
    }

    async writeEPUB(dest) {
        var data = await this.epub.makeEpub();
        await this.writeFile(dest + "/" + this.epub.getFilename(true), data);
        console.log("epub file written"); // log info
        if (this.options.newEPUBHook) {
            child_process.exec(this.options.newEPUBHook);
        }
    }

    writeFile(fn, data) {
        return new Promise((resolve, reject) => {
            fs.writeFile(fn, data, () => {
                resolve();
            })
        });
    }

    async test() {
        this.printIndex();
        this.close();
    }

    autoRegenEPUB() {
        this.addListener('bookRefresh', () => {
            this.genEPUB();
        });
    }
}




async function main() {
    var config = JSON.parse(fs.readFileSync(process.argv[2]));
    var gitbook = new Gitbook(config.book_uri, config.options);
    await gitbook.ready();
    gitbook.genEPUB();
    gitbook.autoRegenEPUB();
}
main();
