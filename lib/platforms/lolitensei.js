const Exporter = require('../exporter');
const Entities = require('html-entities').XmlEntities;
const entities = new Entities();

class Lolitensei extends Exporter {
    /*
     * ## options
     * ignore: [<num or title 1>, <num or title 2>, ...],
     * chk_period: timer period (s)
     */
    initPlatform() {
        return new Promise(async (resolve, reject) => {
            this.main = null;
            this.name = "幼女轉生";
            if (this.options.chk_period) {
                const time = this.options.chk_period * 1000;
                setInterval(() => {
                    this.checkUpdate();
                }, time);
            }
            resolve();
        });
    }

    close() {
    }

    async checkUpdate() {
        const last_updated = this.updatedAt;
        await this.retrieveInfo();
        console.info("check update, old@ ", last_updated, ", cur@ ", this.updatedAt);
        if (last_updated < this.updatedAt) {
            this.doBookRefresh(false);
        }
    }

    async retrieveInfo() {
        return new Promise(async (resolve, reject) => {
            const data = await this.request({
                method: 'POST',
                uri: this.book.uri + '/main2'
            });
            this.main = JSON.parse(data);
            this.genIndex();
            resolve();
        });
    }

    genIndex() {
        const chaps = []; // list for s insertion(index by num)
        this.main.chapList.forEach((chap) => {
            chap.title = entities.decode(chap.title);
            chaps[chap.num] = chap;
        });
        this.main.s.forEach((s) => {
            s.title = entities.decode(s.title);
            chaps[s.order].s = s
        });

        const todate = (str) => { return new Date(... str.split(/[\/ :\.]/) ) };
        const chk_incl = (chap) => {
            const res = !chap.secret &&
                !this.options.ignore.includes(chap.title) &&
                !this.options.ignore.includes(chap.num);
            const date = todate(chap.date);
            if (res && date > this.updatedAt) {
                this.updatedAt = date;
            }
            return res;
        }

        let sec = null;
        this.index = [];
        this.main.chapList.forEach((chap) => { // chap order by ori array order
            if (chap.s) { // new sec
                sec = {
                    type: "section",
                    title: chap.s.title,
                    desc: "",
                    children: []
                };
                if (!this.options.ignore.includes(sec.title)) {
                    this.index.push(sec);
                }
                if (chk_incl(chap)) {
                    sec.children.push({
                        type: "page",
                        title: chap.title,
                        dest: "",
                        data: {
                            num: chap.num
                        }
                    });
                }
            } else if (sec && chk_incl(chap)) {
                sec.children.push({
                    type: "page",
                    title: chap.title,
                    dest: "",
                    data: {
                        num: chap.num
                    }
                });
            } else if(chk_incl(chap)) { // no sec (should not happen ???)
                this.index.push({
                    type: "page",
                    title: chap.title,
                    dest: "",
                    data: {
                        num: chap.num
                    }
                });
            }
        });
        // clear empty section
        for(let i in this.index) {
            if (this.index[i].children.length === 0) {
                delete this.index[i];
            }
        }
    }

    resolvePage(page) {
        return new Promise(async (resolve, reject) => {
            if (page.data.num) {
                const data = await this.request({
                    method: 'POST',
                    uri: this.book.uri + '/view2',
                    json: true,
                    body: {
                        num: page.data.num,
                        ver: "",
                        ccode: "tw"
                    }
                });
                page.data.html = data.content;
            }
            resolve();
        });
    }

    pageToText(page, img) {
        if (page.data.html) {
            return entities.decode(page.data.html)
                .replace(/<br\s*\/?>/mg, "\n")
                .replace(/<img[^>]*src\s*=\s*"\s*(https?:\/\/[^"<>]+)\s*"[^>]*\/?>/gm, (...m) => {
                    if (img) {
                        const img = this.getAsset(m[1]);
                        return `###xmlltag###img src="${img}"/###xmlrtag###`;
                    } else {
                        return "";
                    }
                })
                .replace(/<\/?[^<>]+\/?>/gm, '')
                .replace(/###xmlltag###/gm, '<')
                .replace(/###xmlrtag###/gm, '>');
        } else {
            return "";
        }
    }
}

module.exports = Lolitensei;
