// TODO drop eslint disabling
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

import {app} from "electron";
import asap from "asap-es";
import {Deferred} from "ts-deferred";
import {distinctUntilChanged, take} from "rxjs/operators";
import logger from "electron-log";
import {merge, ReplaySubject} from "rxjs";
import path from "path";
import {Fs as StoreFs, Model as StoreModel, Store} from "fs-json-store";

import {
    BINARY_NAME, ONE_KB_BYTES, ONE_MB_BYTES, PACKAGE_NAME, RUNTIME_ENV_USER_DATA_DIR, WEB_PROTOCOL_DIR, WEB_PROTOCOL_SCHEME,
} from "src/shared/const";
import {Config, Settings} from "src/shared/model/options";
import {configEncryptionPresetValidator, INITIAL_STORES, settingsAccountLoginUniquenessValidator} from "./constants";
import {Context, ContextInitOptions, ContextInitOptionsPaths, ProperLockfileError} from "./model";
import {Database} from "./database";
import {ElectronContextLocations} from "src/shared/model/electron";
import {formatFileUrl, generateDataSaltBase64} from "./util";
import {SessionStorage} from "src/electron-main/session-storage";
import {WEBPACK_WEB_CHUNK_NAMES} from "src/shared/const/webpack";

function exists(file: string, storeFs: StoreModel.StoreFs): boolean {
    try {
        storeFs._impl.statSync(file);
    } catch (error) {
        if ((Object(error) as { code?: unknown }).code === "ENOENT") {
            return false;
        }

        throw error;
    }

    return true;
}

function directoryExists(file: string, storeFs: StoreModel.StoreFs = StoreFs.Fs.fs): boolean {
    if (!(exists(file, storeFs))) {
        return false;
    }

    const stat: ReturnType<typeof import("fs")["statSync"]> = storeFs._impl.statSync(file);

    return Boolean(stat?.isDirectory());
}

function initLocations(
    storeFs: StoreModel.StoreFs,
    paths?: ContextInitOptionsPaths,
): NoExtraProps<ElectronContextLocations> {
    const {appDir, userDataDir}: ContextInitOptionsPaths = (
        paths
        ??
        {
            appDir: path.join(
                __dirname,
                BUILD_ENVIRONMENT === "development"
                    ? "../../app-dev"
                    : "../../app",
            ),
            userDataDir: path.join(
                ((): string | undefined => {
                    const envVarName = RUNTIME_ENV_USER_DATA_DIR;
                    const envVarValue = process.env[envVarName];
                    if (!envVarValue) {
                        return;
                    }
                    if (!directoryExists(envVarValue, storeFs)) {
                        throw new Error(
                            `Make sure that the directory exists before passing the "${envVarName}" environment variable`,
                        );
                    }
                    return envVarValue;
                })()
                ??
                path.join(app.getPath("appData"), PACKAGE_NAME)
            ),
        }
    );

    logger.transports.file.file = path.join(userDataDir, "log.log");
    logger.transports.file.maxSize = ONE_MB_BYTES * 50;
    logger.transports.file.level = INITIAL_STORES.config().logLevel;
    logger.transports.console.level = false;

    if (path.resolve(userDataDir) !== path.resolve(app.getPath("userData"))) {
        // TODO figure why "app.setPath(...)" call breaks normal e2e/playwright test start
        app.setPath("userData", userDataDir);
        app.setAppLogsPath(path.join(userDataDir, BINARY_NAME, "logs"));
    }

    const appRelativePath = (...value: string[]): string => path.join(appDir, ...value);
    const icon = appRelativePath("./assets/icons/icon.png");

    return {
        appDir,
        userDataDir,
        icon,
        trayIcon: icon,
        trayIconFont: appRelativePath("./assets/fonts/tray-icon/roboto-derivative.ttf"),
        browserWindowPage: formatFileUrl(
            appRelativePath(WEB_PROTOCOL_DIR, WEBPACK_WEB_CHUNK_NAMES["browser-window"], "index.html"),
        ),
        aboutBrowserWindowPage: appRelativePath(WEB_PROTOCOL_DIR, WEBPACK_WEB_CHUNK_NAMES.about, "index.html"),
        searchInPageBrowserViewPage:
            appRelativePath(WEB_PROTOCOL_DIR, WEBPACK_WEB_CHUNK_NAMES["search-in-page-browser-view"], "index.html"),
        preload: {
            aboutBrowserWindow: appRelativePath("./electron-preload/about/index.js"),
            browserWindow: appRelativePath(`./electron-preload/browser-window/index${BUILD_ENVIRONMENT === "e2e" ? "-e2e" : ""}.js`),
            searchInPageBrowserView: appRelativePath("./electron-preload/search-in-page-browser-view/index.js"),
            fullTextSearchBrowserWindow: appRelativePath("./electron-preload/database-indexer/index.js"),
            primary:
                formatFileUrl(appRelativePath(`./electron-preload/webview/primary/index${BUILD_ENVIRONMENT === "e2e" ? "-e2e" : ""}.js`)),
            calendar:
                formatFileUrl(appRelativePath(`./electron-preload/webview/calendar/index${BUILD_ENVIRONMENT === "e2e" ? "-e2e" : ""}.js`)),
        },
        // TODO electron: get rid of "baseURLForDataURL" workaround, see https://github.com/electron/electron/issues/20700
        vendorsAppCssLinkHrefs: ["shared-vendor-dark", "shared-vendor-light"]
            .map((value) => `${WEB_PROTOCOL_SCHEME}://browser-window/${value}.css`),
    };
}

function isProperLockfileError(value: unknown): value is ProperLockfileError {
    return (
        typeof value === "object"
        &&
        typeof (value as ProperLockfileError).message === "string"
        &&
        (value as ProperLockfileError).code === "ELOCKED"
        &&
        typeof (value as ProperLockfileError).file === "string"
        &&
        Boolean(
            (value as ProperLockfileError).file,
        )
    );
}

function wrapProperLockfileError(error: ProperLockfileError): ProperLockfileError {
    const extendedMessage = [
        `. Related data file: "${error.file}".`,
        "Normally, this error indicates that the app was abnormally closed or a power loss has taken place.",
        "Please restart the app to restore its functionality (stale lock files will be removed automatically).",
    ].join(" ");
    return Object.assign(
        error,
        {message: `${error.message} ${extendedMessage}`},
    );
}

export function initContext(
    {storeFs = StoreFs.Fs.fs, ...options}: ContextInitOptions = {},
): NoExtraProps<Context> {
    const locations = initLocations(storeFs, options.paths);

    // the lock path gets resolved explicitly in case "proper-lockfile" module changes the default resolving strategy in the future
    const lockfilePathResolver = (file: string): string => `${file}.lock`;

    const {
        config$,
        configStore,
    } = ((): NoExtraProps<Pick<Context, "config$" | "configStore">> => {
        class ConfigStore extends Store<Config> {
            readonly valueChangeSubject$ = new ReplaySubject<Config>(1);

            constructor(arg: StoreModel.StoreOptionsInput<Config>) {
                super(arg);

                const _this = this; // eslint-disable-line @typescript-eslint/no-this-alias

                _this.read = ((read): typeof _this.read => {
                    const result: typeof _this.read = async (...args) => {
                        const config = await read(...args);
                        if (config) {
                            _this.valueChangeSubject$.next(config);
                        }
                        return config;
                    };
                    return result;
                })(_this.read.bind(_this));

                _this.write = ((write): typeof _this.write => {
                    const result: typeof _this.write = async (...args) => {
                        let callResult: Unpacked<ReturnType<typeof write>> | undefined;
                        try {
                            callResult = await write(...args);
                        } catch (error) {
                            if (isProperLockfileError((error))) {
                                throw wrapProperLockfileError(error);
                            }
                            throw error;
                        }
                        _this.valueChangeSubject$.next(callResult);
                        return callResult;
                    };
                    return result;
                })(_this.write.bind(_this));
            }
        }

        const store = new ConfigStore({
            fs: storeFs,
            optimisticLocking: true,
            lockfilePathResolver,
            file: path.join(locations.userDataDir, "config.json"),
            validators: [configEncryptionPresetValidator],
            serialize: (data): Buffer => Buffer.from(JSON.stringify(data, null, 2)),
        });

        return {
            config$: merge(
                store.valueChangeSubject$.asObservable().pipe(
                    take(1),
                ),
                store.valueChangeSubject$.asObservable().pipe(
                    distinctUntilChanged(({_rev: prev}, {_rev: curr}) => curr === prev),
                ),
            ),
            configStore: store,
        };
    })();

    const ctx: Context = {
        storeFs,
        locations,
        deferredEndpoints: new Deferred(),
        ...((): NoExtraProps<Pick<Context, "db" | "sessionDb">> => {
            const commonOptions = {
                encryption: {
                    async resolveKey() {
                        const {databaseEncryptionKey} = await ctx.settingsStore.readExisting();
                        return databaseEncryptionKey;
                    },
                    async resolvePreset() {
                        const {encryptionPreset: {encryption}} = await configStore.readExisting();
                        return {encryption};
                    },
                },
                async dbCompression(): Promise<Config["dbCompression2"]> {
                    const {dbCompression2} = await configStore.readExisting();
                    return dbCompression2;
                },
            } as const;
            return {
                db: new Database({...commonOptions, file: path.join(locations.userDataDir, "database.bin")}),
                sessionDb: new Database({...commonOptions, file: path.join(locations.userDataDir, "database-session.bin")}),
            };
        })(),
        ...((): NoExtraProps<Pick<Context, "sessionStorage">> => {
            const encryption = {
                async keyResolver() {
                    const {sessionStorageEncryptionKey} = await ctx.settingsStore.readExisting();
                    return sessionStorageEncryptionKey;
                },
                async presetResolver() {
                    const {encryptionPreset: {encryption}} = await configStore.readExisting();
                    return {encryption};
                },
            } as const;
            return {
                sessionStorage: new SessionStorage(
                    {
                        file: path.join(locations.userDataDir, "session.bin"),
                        encryption,
                    },
                    storeFs,
                ),
            };
        })(),
        initialStores: options.initialStores || {config: INITIAL_STORES.config(), settings: INITIAL_STORES.settings()},
        config$,
        configStore,
        configStoreQueue: new asap(),
        settingsStore: (() => {
            class SettingsStore extends Store<Settings> {
                constructor(arg: StoreModel.StoreOptionsInput<Settings>) {
                    super(arg);

                    const _this = this; // eslint-disable-line @typescript-eslint/no-this-alias

                    _this.write = ((write): typeof _this.write => {
                        const result: typeof _this.write = async (data, ...rest) => {
                            try {
                                const dataToSave: Omit<typeof data, "dataSaltBase64"> & Required<Pick<typeof data, "dataSaltBase64">>
                                    = {
                                    ...data,
                                    dataSaltBase64: generateDataSaltBase64(ONE_KB_BYTES * 0.5, ONE_KB_BYTES * 2),
                                };
                                return await write(dataToSave, ...rest);
                            } catch (error) {
                                if (isProperLockfileError((error))) {
                                    throw wrapProperLockfileError(error);
                                }
                                throw error;
                            }
                        };
                        return result;
                    })(_this.write.bind(_this));
                }
            }

            return new SettingsStore({
                fs: storeFs,
                optimisticLocking: true,
                lockfilePathResolver,
                file: path.join(locations.userDataDir, "settings.bin"),
                validators: [settingsAccountLoginUniquenessValidator],
            });
        })(),
        settingsStoreQueue: new asap(),
        keytarSupport: true,
    };

    // "proper-lockfile" module creates directory-based locks (since it's an atomic operation on all systems)
    // so lets remove the stale locks on app start
    // in general, a stale locks might remain on the file system due to the abnormal program exit, power loss, etc
    for (const {file, fs: {_impl: fsImpl}} of [ctx.configStore, ctx.settingsStore]) {
        const lockFile = lockfilePathResolver(file);
        if (fsImpl.existsSync(lockFile)) {
            fsImpl.rmdirSync(lockFile);
        }
    }

    return ctx;
}
