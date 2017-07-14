const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const rimraf = require('rimraf');
const onDeath = require('death');
const childProcess = require('child_process');
const { execSync, spawn } = childProcess;
const chromeRemote = require('chrome-remote-interface');
const {
    DEFAULT_FLAGS,
    NOISE_FLAGS,
    HEADLESS_FLAGS
} = require('./flags');

class ChromeLauncher extends EventEmitter {
    constructor(opts) {
        super();
        const {
            port = '9222',
            url = 'about:blank',
            chromeFlags = [],
            monitorInterval = 500
        } = opts;
        this.port = port;
        this.url = url;
        this.chromeFlags = chromeFlags.concat(DEFAULT_FLAGS);
        this.monitorInterval = monitorInterval;
        this.chromePath= this.getChromePath();
        this.tmpDirPath = undefined;
        this.chromeProcess = undefined;
        this.chromeOutFd = undefined;
        this.chromeErrFd = undefined;
        this.pidFd= undefined;
    }
    getChromePath() {
        const chromePath = [];
        const prefixes = execSync(
                '/System/Library/Frameworks/CoreServices.framework' +
                '/Versions/A/Frameworks/LaunchServices.framework' +
                '/Versions/A/Support/lsregister' +
                ' -dump | grep -i \'google chrome\\( canary\\)\\?.app$\' | awk \'{$1=""; print $0}\''
            )
            .toString();
        prefixes.split(/\r?\n/)
            .forEach(src => {
                [
                    '/Contents/MacOS/Google Chrome Canary',
                    '/Contents/MacOS/Google Chrome'
                ].forEach(suffix => {
                    const fullPath = path.join(src.trim(), suffix);
                    try {
                        fs.accessSync(fullPath);
                        chromePath.push(fullPath);
                    } catch (e) {}
                });
            });
        const priorities = [{
                regex: new RegExp(`^${process.env.HOME}/Applications/.*Chrome.app`),
                weight: 50
            },
            {
                regex: new RegExp(`^${process.env.HOME}/Applications/.*Chrome Canary.app`),
                weight: 51
            },
            {
                regex: /^\/Applications\/.*Chrome.app/,
                weight: 100
            },
            {
                regex: /^\/Applications\/.*Chrome Canary.app/,
                weight: 101
            },
            {
                regex: /^\/Volumes\/.*Chrome.app/,
                weight: -2
            },
            {
                regex: /^\/Volumes\/.*Chrome Canary.app/,
                weight: -1
            }
        ];
        return chromePath.map(p => {
                for (const priority of priorities) {
                    if (priority.regex.test(p)) {
                        return {
                            path: p,
                            weight: priority.weight
                        };
                    }
                }
                return {
                    path: p,
                    weight: 10
                };
            })
            .sort((a, b) => (b.weight - a.weight))
            .map(p => p.path);
    }
    createTmpDir() {
        const now = new Date();
        const dirPath = path.resolve(os.tmpdir(), `chrome_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}__${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}__${String(Math.random()).substring(2)}`);
        if (!fs.existsSync(this.tmpDirPath)) {
            fs.mkdirSync(dirPath);
            this.tmpDirPath = dirPath;
        }
        this.chromeOutFd = fs.openSync(`${dirPath}/chrome-out.log`, 'a');
        this.chromeErrFd = fs.openSync(`${dirPath}/chrome-err.log`, 'a');
        this.pidFd = fs.openSync(`${dirPath}/chrome.pid`, 'w');
    }
    deleteTmpDir() {
        try {
            if (this.chromeOutFd) {
                fs.closeSync(this.chromeOutFd);
                delete this.chromeOutFd;
            }
            if (this.chromeErrFd) {
                fs.closeSync(this.chromeErrFd);
                delete this.chromeErrFd;
            }
            if (this.pidFd) {
                fs.closeSync(this.pidFd);
                delete this.pidFd;
            }
            if (this.tmpDirPath) {
                rimraf.sync(this.tmpDirPath);
            }
        } catch (err) {}
    }
    handleChromeClose() {
        onDeath(async () => {
            await this.kill();
            process.exit();
        });
    }
    async launch() {
        if (!this.pidFd) {
            this.createTmpDir();
        }
        await this.spawn();
        return this;
    }
    async spawn() {
        const chromePath = this.chromePath.length ? this.chromePath.pop() : new Error('ERROR_NO_INSTALLATIONS_FOUND');
        const args = this.chromeFlags.concat([
            `--remote-debugging-port=${this.port}`,
            `--user-data-dir=${this.tmpDirPath}`,
            this.url
        ]);
        const chromeProcess = childProcess.spawn(
            chromePath,
            args,
            {
                detached: true,
                stdio: [
                    'ignore',
                    this.chromeOutFd,
                    this.chromeErrFd
                ]
            });
        this.chromeProcess = chromeProcess;
        this.monitorChromeIsAlive();
        this.handleChromeClose();
        fs.writeFileSync(this.pidFd, chromeProcess.pid.toString());
        return new Promise(resolve => {
            this.once('chromeAlive', resolve);
        });
    }
    monitorChromeIsAlive() {
        clearInterval(this.monitorTimer);
        this.monitorTimer = setInterval(async() => {
            const alive = await isPortOpen(this.port);
            if (alive) {
                this.emit('chromeAlive', this.port);
            } else {
                this.emit('chromeDead');
                if (this.chromeProcess) {
                    this.chromeProcess.kill();
                }
                await this.spawn();
                this.emit('chromeRestarted');
            }
        }, this.monitorInterval);
    }
    kill() {
        return new Promise((resolve, reject) => {
            if (this.chromeProcess) {
                this.chromeProcess.on('close', () => {
                    this.deleteTmpDir();
                    resolve();
                });

                try {
                    this.chromeProcess.kill();
                    delete this.chromeProcess;
                    // clearInterval(this.monitorTimmer);
                    // delete this.monitorTimmer;
                } catch (err) {
                    reject(err);
                }
            } else {
                resolve();
            }
        });
    }
}

function isPortOpen(port) {
    const cleanupNetClient = function(client) {
        if (client) {
            client.end();
            client.destroy();
            client.unref();
        }
    }
    return new Promise((resolve) => {
        const client = net.createConnection(port);
        client.once('error', () => {
            cleanupNetClient(client);
            resolve(false);
        });
        client.once('connect', () => {
            cleanupNetClient(client);
            resolve(true);
        });
    });
}

async function launch(options = {}) {
    const chrome = new ChromeLauncher(options);
    await chrome.launch();
    return chrome;
}

async function launchWithoutNoise(options = {}) {
    let chromeFlags = NOISE_FLAGS;
    if (Array.isArray(options.chromeFlags)) {
        chromeFlags = chromeFlags.concat(options.chromeFlags);
    }
    return launch(Object.assign(options, { chromeFlags }));
}

async function launchWithHeadless(options = {}) {
    let chromeFlags = NOISE_FLAGS.concat(HEADLESS_FLAGS);
    if (Array.isArray(options.chromeFlags)) {
        chromeFlags = chromeFlags.concat(options.chromeFlags);
    }
    return launch(Object.assign(options, { chromeFlags }));
}

async function headlessChrome() {
    const chrome = await launchWithHeadless();
    return chrome;
}

async function connectChrome() {
    const { port } = await headlessChrome();
    const tabs = await chromeRemote.List({ port });
    const { id } = tabs.pop();
    const client = await chromeRemote({
        target: id,
        port
    });
    console.log(client);
}

connectChrome();
