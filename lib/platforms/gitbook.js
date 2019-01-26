const Exporter = require('../exporter');
const GitbookWS = require('./gitbookws');

class Gitbook extends Exporter {
    /*
     * ## options
     * ignore: [<id or uri 1>, <id or uri 2>, ...],
     */
    initPlatform() {
        return new Promise(async (resolve, reject) => {
            this.CDNREPLACE = "https://firebasestorage.googleapis.com/v0/b/";

            this.spaceQuery = "";

            this.projectId = null;
            this.spaceId = null;
            this.cdnBolb = null;
            this.ws = null;
            this.rev = "";
            this.pages = null;

            await this.retrieveConfig();
            resolve();
        });
    }

    close() {
        this.ws.close();
    }

    retrieveConfig() {
        return new Promise(async (resolve, reject) => {
            const book_html = await this.request(this.book.uri);
            const match = /\s*window\.GITBOOK_STATE\s*=\s*(.*)/.exec(book_html);
            const meta_str = match[1].endsWith(";") ? match[1].slice(0, -1) : match[1];
            const meta = JSON.parse(meta_str);

            this.projectId = meta.config.firebase.projectId;
            this.spaceId = meta.props.spaceID;
            this.cdnBolb = meta.config.cdn.blobsurl;

            this.spaceQuery = "/spaces/" + this.spaceId + "/infos";

            resolve();
        });
    }

    async retrieveInfo() {
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
            this.cover = info.logoURL;
            this.updatedAt = info.updatedAt;

            this.book = await this.ws.request("/spaces/" + this.spaceId + "/revisions/" + this.rev);

            this.parseAssets();
            this.genIndex();

            resolve();
        });
    }

    async updatePush(json) {
        if (this.spaceQuery === "/" + json.b.p) {
            if (this.rev !== json.b.d.primaryRevision) {
                this.doBookRefresh();
            }
        }
    }

    parseAssets() {
        this.assets = {};
        const assets = this.book.b.d.content.assets;
        for (let key in assets) {
            const asset = assets[key];
            this.assets[key] = {
                name: asset.name,
                uri: asset.downloadURL
            };
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
                data: {
                    docURL: this.replaceCDNBolb(page.documentURL)
                }
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
                            data: {
                                id: pageId,
                                path: subpage.path,
                                rev: subpage.stats.revisions,
                                docURL: this.replaceCDNBolb(subpage.documentURL)
                            }
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

    resolvePage(page) {
        return new Promise(async (resolve, reject) => {
            if (page.data.docURL) {
                const doc_str = await this.request(page.data.docURL);
                page.data.doc = JSON.parse(doc_str).document;
            }
            resolve();
        });
    }

    nodesToText(node, img) {
        let output = "";
        switch (node.kind) {
            case "document":
            case "inline":
                node.nodes.forEach((subnode) => {
                    output += this.nodesToText(subnode, img);
                });
                break;
            case "block":
                switch (node.type) {
                    case "image":
                        if (img) {
                            output += "<img src=\"" + this.getAsset(node.data.assetID) + "\"/>\n";
                        }
                        break;
                    case "paragraph":
                        node.nodes.forEach((subnode) => {
                            output += this.nodesToText(subnode, img);
                        });
                        output += "\n";
                        break;
                    default:
                }
                break;
            case "text":
                node.ranges.forEach((subnode) => {
                    output += this.nodesToText(subnode, img);
                });
                break;
            case "range":
                output += node.text;
                break;
            default:
        }
        return output;
    }

    pageToText(page, img) {
        return page.data.doc ? this.nodesToText(page.data.doc, img) : "";
    }
}

module.exports = Gitbook;
