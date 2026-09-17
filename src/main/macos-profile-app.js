import path from 'path';
import crypto from 'crypto';
import fs from 'fs-extra';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = '.geekez-profile-app.json';
const MANIFEST_VERSION = 1;

function stableProfileKey(profileId) {
    return crypto
        .createHash('sha256')
        .update(String(profileId || ''))
        .digest('hex')
        .slice(0, 24);
}

function profileBundleId(profileId) {
    return `com.geekez.browser.profile.p${stableProfileKey(profileId)}`;
}

function sanitizeAppLabel(profileName) {
    const normalized = String(profileName || '')
        .replace(/[\u0000-\u001f/:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const label = normalized || 'Profile';
    return label.slice(0, 60);
}

function findAppBundle(executablePath) {
    let current = path.resolve(String(executablePath || ''));
    while (current && current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.app')) return current;
        current = path.dirname(current);
    }
    return null;
}

async function setPlistString(plistPath, key, value) {
    await execFileAsync('/usr/bin/plutil', [
        '-replace', key,
        '-string', String(value),
        plistPath
    ]);
}

async function sourceFingerprint(sourceExecutable, sourceAppPath) {
    const executableStat = await fs.stat(sourceExecutable);
    const plistPath = path.join(sourceAppPath, 'Contents', 'Info.plist');
    const plistStat = await fs.stat(plistPath);
    let resolvedExecutable = sourceExecutable;
    try {
        resolvedExecutable = await fs.realpath(sourceExecutable);
    } catch (e) { }

    return [
        resolvedExecutable,
        `${executableStat.size}:${Math.trunc(executableStat.mtimeMs)}`,
        `${plistStat.size}:${Math.trunc(plistStat.mtimeMs)}`
    ].join('|');
}

async function readManifest(manifestPath) {
    try {
        const value = await fs.readJson(manifestPath);
        return value && typeof value === 'object' ? value : null;
    } catch (e) {
        return null;
    }
}

async function findExistingAppFileName(profileRoot) {
    try {
        const entries = await fs.readdir(profileRoot, { withFileTypes: true });
        const app = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'));
        return app?.name || null;
    } catch (e) {
        return null;
    }
}

async function cloneAppBundle(sourceAppPath, destinationAppPath) {
    const tempAppPath = path.join(
        path.dirname(destinationAppPath),
        `.${path.basename(destinationAppPath, '.app')}.${process.pid}.${Date.now()}.tmp.app`
    );

    await fs.remove(tempAppPath);
    try {
        // macOS /bin/cp -c uses clonefile(2), so every profile gets its own
        // LaunchServices identity without physically duplicating the ~350 MB
        // Chromium bundle on APFS.
        await execFileAsync('/bin/cp', ['-cR', sourceAppPath, tempAppPath]);
        await fs.remove(destinationAppPath);
        await fs.move(tempAppPath, destinationAppPath, { overwrite: true });
    } catch (error) {
        await fs.remove(tempAppPath).catch(() => { });
        throw error;
    }
}

async function updateProfileIdentity(appPath, bundleId, displayName) {
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    await setPlistString(plistPath, 'CFBundleIdentifier', bundleId);
    await setPlistString(plistPath, 'CFBundleName', displayName);
    await setPlistString(plistPath, 'CFBundleDisplayName', displayName);
}

async function prepareMacProfileChromium(options = {}) {
    const {
        sourceExecutable,
        profileId,
        profileName,
        rootDir
    } = options;

    if (process.platform !== 'darwin') {
        return { executablePath: sourceExecutable, appPath: null, bundleId: null, reused: true };
    }
    if (!sourceExecutable || !profileId || !rootDir) {
        throw new Error('Missing sourceExecutable, profileId or rootDir for macOS profile app');
    }

    const sourceAppPath = findAppBundle(sourceExecutable);
    if (!sourceAppPath) {
        throw new Error(`Chromium executable is not inside a macOS .app bundle: ${sourceExecutable}`);
    }

    const sourceExecutableName = path.basename(sourceExecutable);
    const bundleId = profileBundleId(profileId);
    const displayName = `GeekEZ - ${sanitizeAppLabel(profileName)}`;
    const profileRoot = path.join(rootDir, stableProfileKey(profileId));
    const manifestPath = path.join(profileRoot, MANIFEST_NAME);
    await fs.ensureDir(profileRoot);

    const manifest = await readManifest(manifestPath);
    const existingAppFileName = manifest?.appFileName || await findExistingAppFileName(profileRoot);
    const appFileName = existingAppFileName || `${displayName}.app`;
    const appPath = path.join(profileRoot, appFileName);
    const executablePath = path.join(appPath, 'Contents', 'MacOS', sourceExecutableName);
    const fingerprint = await sourceFingerprint(sourceExecutable, sourceAppPath);

    const canReuse = Boolean(
        manifest &&
        manifest.version === MANIFEST_VERSION &&
        manifest.sourceFingerprint === fingerprint &&
        manifest.bundleId === bundleId &&
        await fs.pathExists(executablePath)
    );

    if (!canReuse) {
        await cloneAppBundle(sourceAppPath, appPath);
        await updateProfileIdentity(appPath, bundleId, displayName);
    } else if (manifest.displayName !== displayName) {
        // Keep the .app path stable for an already pinned Dock item, while still
        // updating the visible application metadata after a profile rename.
        await updateProfileIdentity(appPath, bundleId, displayName);
    }

    await fs.writeJson(manifestPath, {
        version: MANIFEST_VERSION,
        appFileName,
        bundleId,
        displayName,
        sourceFingerprint: fingerprint
    }, { spaces: 2 });

    return {
        executablePath,
        appPath,
        bundleId,
        reused: canReuse
    };
}

async function removeMacProfileApp(options = {}) {
    const { profileId, rootDir } = options;
    if (process.platform !== 'darwin' || !profileId || !rootDir) return;
    await fs.remove(path.join(rootDir, stableProfileKey(profileId)));
}

export {
    findAppBundle,
    prepareMacProfileChromium,
    profileBundleId,
    removeMacProfileApp,
    sanitizeAppLabel,
    stableProfileKey
};
