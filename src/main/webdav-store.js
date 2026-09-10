const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { MAX_BYTES, syncError } = require('./sync-format');

const transportContext = new AsyncLocalStorage();
const DIRECTORY_QUERY = Buffer.from('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>');
let library;
async function webdav() {
    if (!library) library = import('webdav').then(module => {
        // The client handles authentication; redirect decisions belong to this store.
        module.getPatcher().patch('fetch', async (url, options) => {
            const transport = transportContext.getStore();
            const response = await (transport || fetch)(url, { ...options, redirect: 'manual' });
            if (response.status === 401) await response.body?.cancel().catch(() => {});
            return response;
        });
        return module;
    });
    return library;
}

function networkError(error) {
    if (error.code?.startsWith('sync')) return error;
    const code = String(error.cause?.code || error.code || '');
    return syncError(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? 'syncTlsError' : 'syncNetworkError');
}

function httpError(status, method) {
    if (status === 401) return syncError('syncAuthError');
    if (status === 403) return syncError('syncPermissionError');
    if (status === 507) return syncError('syncStorageFull');
    if (status === 423) return syncError('syncServerLocked');
    if (method === 'PROPFIND' && status === 404) return syncError('syncInvalidFolder');
    if (method === 'PROPFIND' && [405, 501].includes(status)) return syncError('syncDirectoryUnsupported');
    return syncError('syncHttpError', `${method} ${status}`);
}

async function readBody(response) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw syncError('syncTooLarge');
    }
    const chunks = [];
    let length = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > MAX_BYTES) throw syncError('syncTooLarge');
            chunks.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(chunks);
}

const listOf = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const decodedPath = value => value.split('/').map(decodeURIComponent).join('/').replace(/\/+$/, '');
function parseDirectory(data, url) {
    const xml = data.toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw syncError('syncDirectoryInvalid');
    let parsed;
    try { parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(xml); }
    catch { throw syncError('syncDirectoryInvalid'); }
    const responses = listOf(parsed.multistatus?.response);
    if (!responses.length) throw syncError('syncDirectoryInvalid');
    const directory = new URL(url);
    directory.pathname = directory.pathname.replace(/\/?$/, '/');
    const expectedRoot = decodedPath(directory.pathname);
    const entries = responses.map(response => {
        if (typeof response.href !== 'string') throw syncError('syncDirectoryInvalid');
        let resource;
        try { resource = decodedPath(new URL(response.href, directory).pathname); }
        catch { throw syncError('syncDirectoryInvalid'); }
        const property = listOf(response.propstat).find(item => /\s2\d\d(?:\s|$)/.test(item.status) && item.prop && Object.hasOwn(item.prop, 'resourcetype'));
        if (!property) throw syncError('syncDirectoryInvalid');
        const collection = Object.hasOwn(Object(property.prop.resourcetype), 'collection');
        return { resource, collection };
    });
    // Reverse proxies may expose a different prefix from the server's absolute hrefs.
    const root = entries.find(entry => entry.collection && entry.resource === expectedRoot)?.resource ??
        entries.find(entry => entry.collection && entries.every(item => item.resource === entry.resource || item.resource.startsWith(entry.resource + '/')))?.resource;
    if (root === undefined) throw syncError('syncDirectoryInvalid');
    const files = new Set();
    for (const { resource, collection } of entries) {
        if (!resource.startsWith(root + '/')) continue;
        const name = resource.slice(root.length + 1);
        if (name && !name.includes('/') && !collection) files.add(name);
    }
    return files;
}

class WebDavStore {
    constructor(config, fetchImpl = fetch) {
        let url;
        try { url = new URL(config.url); } catch { throw syncError('syncInvalidUrl'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw syncError('syncInvalidUrl');
        const folder = String(config.folder || 'GeekEZ-Sync').trim().replace(/^\/+|\/+$/g, '');
        if (!folder || folder.split('/').some(part => !part || part === '.' || part === '..' || /[\\?#\x00-\x1f]/.test(part))) throw syncError('syncInvalidFolder');
        url.pathname = url.pathname.replace(/\/?$/, '/');
        this.base = url;
        this.folders = folder.split('/');
        this.config = config;
        this.fetch = fetchImpl;
        this.clients = Array.from({ length: 4 }, () => ({ queue: Promise.resolve(), client: null }));
        this.nextClient = 0;
    }

    url(name = '', folders = this.folders) {
        if (name && /[/\\?#\x00-\x1f]/.test(name)) throw syncError('syncInvalidData');
        return new URL(folders.map(encodeURIComponent).join('/') + '/' + encodeURIComponent(name), this.base);
    }

    async authenticated(url, options) {
        const slot = this.clients[this.nextClient++ % this.clients.length];
        // Digest nonce counters must not be shared by concurrent requests.
        const task = slot.queue.then(async () => {
            const { createClient, AuthType } = await webdav();
            slot.client ||= createClient(this.base.href, { username: this.config.username || '', password: this.config.password || '', authType: AuthType.Auto });
            try {
                return await transportContext.run(this.fetch, () => slot.client.customRequest('', { ...options, url: url.href }));
            } catch (error) {
                if (error.response) return error.response;
                throw error;
            }
        });
        slot.queue = task.catch(() => {});
        return task;
    }

    async request(method, name, data, headers = {}, folders = this.folders) {
        let url = this.url(name, folders);
        const origin = url.origin;
        let external = false;
        let retries = 0;
        const signal = AbortSignal.timeout(30000);
        try {
            for (let redirects = 0; redirects <= 5;) {
                const options = { method, signal, headers: { 'Cache-Control': 'no-cache', ...(data ? { 'Content-Type': 'application/octet-stream' } : {}), ...headers } };
                const response = external
                    ? await this.fetch(url, { method, signal, redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } })
                    : await this.authenticated(url, { ...options, ...(data ? { data } : {}) });
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers.get('location');
                    await response.body?.cancel().catch(() => {});
                    if (!location || redirects++ === 5) throw syncError('syncRedirectError');
                    const next = new URL(location, url);
                    if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password ||
                        (url.protocol === 'https:' && next.protocol !== 'https:') ||
                        (method !== 'GET' && (next.origin !== origin || response.status === 303))) throw syncError('syncRedirectError');
                    // AList may redirect downloads to its storage provider. Never forward credentials there.
                    external ||= next.origin !== origin;
                    url = next;
                    continue;
                }
                if ([429, 502, 503, 504].includes(response.status) && retries++ < 2) {
                    const retryAfter = Number(response.headers.get('retry-after'));
                    await response.body?.cancel().catch(() => {});
                    await delay(Math.min(2000, Math.max(250, retryAfter * 1000 || 500)), undefined, { signal });
                    continue;
                }
                if (!response.ok && response.status !== 404 && !(method === 'MKCOL' && response.status === 405)) {
                    await response.body?.cancel().catch(() => {});
                    throw httpError(response.status, method);
                }
                return { status: response.status, data: await readBody(response), url: url.href };
            }
        } catch (error) { throw networkError(error); }
    }

    async mkdir() {
        for (let n = 1; n <= this.folders.length; n++) {
            const folders = this.folders.slice(0, n);
            let result;
            try { result = await this.request('MKCOL', '', undefined, {}, folders); }
            catch (error) {
                if (error.code !== 'syncPermissionError') throw error;
                // Some NAS services reject MKCOL on existing shared directories with 403.
                const existing = await this.request('PROPFIND', '', DIRECTORY_QUERY, { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, folders);
                if (existing.status !== 207) throw error;
                parseDirectory(existing.data, existing.url);
                continue;
            }
            if (![200, 201, 204, 405].includes(result.status)) throw syncError('syncInvalidFolder');
        }
    }

    async list() {
        const result = await this.request('PROPFIND', '', DIRECTORY_QUERY, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' });
        if (result.status !== 207) throw httpError(result.status, 'PROPFIND');
        return parseDirectory(result.data, result.url);
    }

    async get(name) {
        const result = await this.request('GET', name);
        if (result.status === 404) return null;
        if (result.status !== 200) throw httpError(result.status, 'GET');
        return result;
    }

    async put(name, data) {
        const result = await this.request('PUT', name, data);
        if (![200, 201, 204].includes(result.status)) throw httpError(result.status, 'PUT');
    }

    async verify(name, data, listed = false) {
        for (const wait of [0, 250, 750, 1500]) {
            if (wait) await delay(wait);
            const result = await this.get(name);
            if (result?.data.equals(data) && (!listed || (await this.list()).has(name))) return;
        }
        throw syncError('syncWriteVerificationFailed');
    }

    async putVerified(name, data) {
        await this.put(name, data);
        await this.verify(name, data);
    }

    async remove(name) {
        const result = await this.request('DELETE', name);
        if (![200, 204, 404].includes(result.status)) throw httpError(result.status, 'DELETE');
    }

    async test() {
        await this.mkdir();
        await this.list();
        const name = `connection-${crypto.randomUUID()}.tmp`;
        const payload = crypto.randomBytes(32);
        try {
            await this.put(name, payload);
            await this.verify(name, payload, true);
            await this.remove(name);
        } catch (error) {
            await this.remove(name).catch(() => {});
            throw error;
        }
    }
}

module.exports = { WebDavStore, parseDirectory };
