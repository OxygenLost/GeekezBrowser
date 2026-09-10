const crypto = require('crypto');
const { syncError, contentHash, validId, validateRecord, deriveSyncKey, encryptSyncData, decryptSyncData } = require('./sync-format');

const HISTORY_LIMIT = 10;
const REVISION_LIMIT = 100000;
const revisionFile = id => `revision-${id}.gksync`;
const snapshotFile = version => `snapshot-${version.id}.gksync`;
const validKey = key => key === 'settings' || key.startsWith('profile:') && validId(key.slice(8));
const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function inventory(records) {
    return Object.fromEntries(Object.entries(records).map(([key, record]) => [key, { hash: contentHash(record), name: record.profile?.name || '' }]));
}

function validateRevision(data, id) {
    if (data?.version !== 3) throw syncError('syncFormatChanged');
    if (data.kind !== 'revision' || data.id !== id || !validId(id) || !validHash(data.hash) || !validId(data.device) ||
        !Number.isSafeInteger(data.at) || data.at < 0 || !Array.isArray(data.parents) || data.parents.length > 10000 ||
        data.parents.some(parent => !validId(parent) || parent === id) || new Set(data.parents).size !== data.parents.length ||
        !isObject(data.records) || !data.records.settings || Object.keys(data.records).length > 10000 ||
        Object.entries(data.records).some(([key, entry]) => !validKey(key) || !isObject(entry) || !validHash(entry.hash) || typeof entry.name !== 'string')) throw syncError('syncInvalidData');
    return { version: 3, kind: 'revision', id, hash: data.hash, at: data.at, device: data.device, parents: data.parents, records: data.records };
}

function validateConfiguration(records) {
    if (!isObject(records) || !records.settings || Object.keys(records).length > 10000) throw syncError('syncInvalidData');
    for (const [key, record] of Object.entries(records)) {
        if (!validKey(key)) throw syncError('syncInvalidData');
        validateRecord(record, key);
    }
    return records;
}

function buildGraph(nodes, files) {
    const byId = new Map(nodes.map(node => [node.id, { ...node, generation: 0 }]));
    const children = new Map(nodes.map(node => [node.id, []]));
    const pending = new Map(nodes.map(node => [node.id, node.parents.length]));
    for (const node of nodes) {
        for (const parent of node.parents) {
            if (!byId.has(parent)) throw syncError('syncRemoteIncomplete');
            children.get(parent).push(node.id);
        }
    }
    // Parents determine version order; device clocks only sort concurrent versions.
    const queue = nodes.filter(node => !node.parents.length).map(node => node.id);
    for (let at = 0; at < queue.length; at++) {
        const node = byId.get(queue[at]);
        for (const id of children.get(node.id)) {
            const child = byId.get(id);
            child.generation = Math.max(child.generation, node.generation + 1);
            pending.set(id, pending.get(id) - 1);
            if (!pending.get(id)) queue.push(id);
        }
    }
    if (queue.length !== nodes.length) throw syncError('syncInvalidData');
    const order = (a, b) => b.generation - a.generation || b.at - a.at || a.id.localeCompare(b.id);
    const versions = [...byId.values()].sort(order);
    const heads = versions.filter(node => !children.get(node.id).length);
    const entries = {};
    for (const version of heads) {
        for (const [key, record] of Object.entries(version.records)) {
            entries[key] ||= { heads: [] };
            entries[key].heads.push({ id: version.id, ...record, at: version.at, device: version.device });
        }
    }
    return { byId, versions, heads, entries, files, signature: contentHash(heads.map(node => node.id).sort()) };
}

async function mapConcurrent(values, callback) {
    let at = 0, failure;
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, values.length) }, async () => {
        while (at < values.length && !failure) {
            const value = values[at++];
            try { await callback(value); }
            catch (error) { failure = error; throw error; }
        }
    }));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
}

class SyncRevisions {
    constructor(store, passphrase) {
        this.store = store;
        this.passphrase = passphrase;
        this.cache = new Map();
        this.keys = new Map();
        this.writeSecret = null;
    }

    async decrypt(buffer) {
        if (buffer.length < 53 || buffer.subarray(0, 8).toString() !== 'GKSC0001') throw syncError('syncInvalidData');
        const salt = buffer.subarray(8, 24);
        const id = salt.toString('hex');
        if (!this.keys.has(id)) this.keys.set(id, deriveSyncKey(this.passphrase, salt));
        const secret = await this.keys.get(id);
        const result = await decryptSyncData(buffer, secret);
        this.writeSecret ||= secret;
        return result.data;
    }

    async readMetadata(id, { verifyExists = false } = {}) {
        if (!verifyExists && this.cache.has(id)) return this.cache.get(id);
        const file = await this.store.get(revisionFile(id));
        if (!file) throw syncError('syncRemoteIncomplete');
        const value = validateRevision(await this.decrypt(file.data), id);
        this.cache.set(id, value);
        return value;
    }

    async read(state, published = []) {
        const files = await this.store.list();
        const legacyNames = [...files].some(name => name === 'index.gksync' || /^(legacy|checkpoint)-.+\.gksync$/.test(name));
        const ids = [...files].map(name => /^revision-([a-zA-Z0-9_-]{1,100})\.gksync$/.exec(name)?.[1]).filter(Boolean);
        if (ids.length > REVISION_LIMIT) throw syncError('syncTooManyVersions');
        const nodes = new Map();
        let legacyRevisionFound = false;
        await mapConcurrent(ids, async id => {
            try { nodes.set(id, await this.readMetadata(id)); }
            catch (error) {
                // A previous test protocol may leave revision-* files beside a
                // valid v3 repository. Ignore only the explicit format marker;
                // malformed v3 data must still stop synchronization.
                if (error.code === 'syncFormatChanged') legacyRevisionFound = true;
                else throw error;
            }
        });
        if (!nodes.size && (legacyNames || legacyRevisionFound)) throw syncError('syncFormatChanged');
        const known = [...Object.values(state.bases).flatMap(base => base.heads), ...published];
        for (;;) {
            const missing = [...new Set([...known, ...[...nodes.values()].flatMap(node => node.parents)])].filter(id => !nodes.has(id));
            if (!missing.length) break;
            if (nodes.size + missing.length > REVISION_LIMIT) throw syncError('syncTooManyVersions');
            await mapConcurrent(missing, async id => {
                nodes.set(id, await this.readMetadata(id, { verifyExists: !files.has(revisionFile(id)) }));
                files.add(revisionFile(id));
            });
        }
        const graph = buildGraph([...nodes.values()], files);
        for (const [key, base] of Object.entries(state.bases)) {
            if (base.heads.some(id => graph.byId.get(id)?.records[key]?.hash !== base.hash)) throw syncError('syncVaultChanged');
        }
        await mapConcurrent(graph.heads, async version => {
            const name = snapshotFile(version);
            if (!files.has(name)) {
                if (!await this.store.get(name)) throw syncError('syncVersionMissing');
                files.add(name);
            }
        });
        return graph;
    }

    async configuration(version) {
        const file = await this.store.get(snapshotFile(version));
        if (!file) throw syncError('syncVersionMissing');
        const data = await this.decrypt(file.data);
        if (data?.version !== 3 || data.kind !== 'configuration') throw syncError('syncInvalidData');
        const records = validateConfiguration(data.records);
        if (contentHash(records) !== version.hash || contentHash(inventory(records)) !== contentHash(version.records)) throw syncError('syncInvalidData');
        return records;
    }

    async publish(graph, records, device) {
        validateConfiguration(records);
        const id = crypto.randomUUID();
        const version = validateRevision({
            version: 3, kind: 'revision', id, hash: contentHash(records), at: Date.now(), device,
            parents: graph.heads.map(node => node.id).sort(), records: inventory(records)
        }, id);
        this.writeSecret ||= await deriveSyncKey(this.passphrase);
        await this.store.putVerified(snapshotFile(version), await encryptSyncData({ version: 3, kind: 'configuration', records }, this.writeSecret));
        const encrypted = await encryptSyncData(version, this.writeSecret);
        await this.store.putVerified(revisionFile(id), encrypted);
        await this.store.verify(revisionFile(id), encrypted, true);
        this.cache.set(id, version);
        return version;
    }

    history(graph) {
        return [...new Map([...graph.versions.slice(0, HISTORY_LIMIT), ...graph.heads].map(node => [node.id, node])).values()];
    }

    async prune(graph) {
        const keep = new Set(this.history(graph).map(node => node.id));
        for (const version of graph.versions) {
            if (!keep.has(version.id) && graph.files.has(snapshotFile(version))) await this.store.remove(snapshotFile(version)).catch(() => {});
        }
    }
}

function planSync(local, graph, bases) {
    return [...new Set([...Object.keys(local.records), ...Object.keys(graph.entries), ...local.busy])].map(key => {
        const record = local.records[key];
        const remotes = graph.entries[key]?.heads || [];
        const remote = remotes[0];
        const competing = new Set(remotes.map(version => version.hash)).size > 1;
        const base = bases[key];
        const hash = record ? contentHash(record) : null;
        let action;
        if (local.busy.includes(key)) action = 'deferred';
        else if (!record && base) action = 'removed';
        else if (competing) action = 'conflict';
        else if (hash && hash === remote?.hash) action = 'unchanged';
        else if (!record) action = 'download';
        else if (!remote) action = base ? 'conflict' : 'upload';
        else if (!base) action = 'conflict';
        else {
            const localChanged = hash !== base.hash;
            const remoteChanged = remote.hash !== base.hash;
            action = localChanged && remoteChanged ? 'conflict' : localChanged ? 'upload' : remoteChanged ? 'download' : 'unchanged';
        }
        return { key, name: key === 'settings' ? '' : record?.profile.name || remote?.name || key.slice(8), action, hash, remote: remote || null, remotes };
    });
}

module.exports = { SyncRevisions, planSync, HISTORY_LIMIT, snapshotFile, mapConcurrent };
