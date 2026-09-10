<template>
    <details class="advanced-group webdav-settings">
        <summary class="advanced-summary">
            <h3><Cloud :size="17" aria-hidden="true" />WebDAV</h3>
            <span class="sync-status" :class="{ failed: status.error }" role="status">{{ $t(status.error || 'syncPhase_' + (status.phase || 'idle')) }}</span>
            <ChevronDown :size="16" class="advanced-chevron" aria-hidden="true" />
        </summary>
        <div class="advanced-content">
            <form @submit.prevent="saveConnection">
                <div class="sync-fields">
                    <label class="sync-wide">{{ $t('syncAddress') }}<input v-model="form.url" type="url" placeholder="https://dav.example.com/remote.php/dav/files/user/" autocomplete="url" spellcheck="false" :disabled="busy"></label>
                    <label class="sync-wide">{{ $t('syncFolder') }}<input v-model="form.folder" type="text" placeholder="GeekEZ-Sync" spellcheck="false" :disabled="busy"></label>
                    <label>{{ $t('syncUsername') }}<input v-model="form.username" type="text" autocomplete="off" :disabled="busy"></label>
                    <label>{{ $t('syncServerPassword') }}<input v-model="form.password" type="password" autocomplete="new-password" :placeholder="status.unlocked ? $t('syncSavedSecret') : ''" :disabled="busy"></label>
                    <label class="sync-wide">{{ $t('syncPassphrase') }}<input v-model="form.passphrase" type="password" minlength="12" autocomplete="new-password" :placeholder="status.unlocked ? $t('syncSavedSecret') : $t('syncPassphrasePlaceholder')" :disabled="busy"></label>
                </div>
                <p class="setting-message">{{ $t('syncPassphraseNotice') }}</p>
                <label class="setting-row"><span>{{ $t('syncRemember') }}</span><input class="setting-switch" type="checkbox" role="switch" v-model="form.remember" :disabled="busy || !status.canRemember"></label>
                <label class="setting-row"><span>{{ $t('syncAutomatic') }}</span><input class="setting-switch" type="checkbox" role="switch" v-model="form.automatic" :disabled="busy"></label>
                <div class="setting-actions">
                    <button v-if="status.config.url" class="outline" type="button" :disabled="busy" @click="disconnect"><Unplug :size="15" />{{ $t('syncDisconnect') }}</button>
                    <button class="outline" type="button" :disabled="busy || !status.unlocked || dirty" @click="testConnection"><PlugZap :size="15" />{{ $t('syncTest') }}</button>
                    <button class="primary" type="submit" :disabled="busy"><Save :size="15" />{{ $t('syncSaveConnection') }}</button>
                </div>
            </form>
            <p v-if="!status.canRemember" class="setting-notice">{{ $t('syncSessionOnly') }}</p>

            <div class="sync-summary">
                <div><span>{{ $t('syncLastTime') }}</span><time>{{ status.lastSync ? date(status.lastSync) : $t('syncNever') }}</time></div>
                <div><span>{{ $t('syncHistoryLimit') }}</span><span>{{ $t('syncHistoryRetention') }}</span></div>
                <div><span>{{ $t('syncCookies') }}</span><span>{{ $t('syncExcluded') }}</span></div>
            </div>
            <div class="sync-command-row">
                <button class="primary" :disabled="busy || !status.unlocked || dirty" @click="preview"><RefreshCw :size="15" :class="{ spinning: busy }" />{{ $t('syncNow') }}</button>
                <button class="outline settings-icon-button" :disabled="busy || !status.unlocked || dirty" :title="$t('syncHistory')" :aria-label="$t('syncHistory')" @click="loadHistory"><History :size="16" /></button>
                <span class="sync-command-spacer"></span>
                <button class="outline settings-icon-button" :disabled="busy" :title="$t('syncExportFile')" :aria-label="$t('syncExportFile')" @click="exportFile"><Download :size="16" /></button>
                <button class="outline settings-icon-button" :disabled="busy" :title="$t('syncImportFile')" :aria-label="$t('syncImportFile')" @click="importFile"><Upload :size="16" /></button>
            </div>

        </div>

        <Teleport to="#app">
            <div v-if="dialogOpen" class="modal-overlay active sync-dialog-overlay" @mousedown.self="closeDialog">
                <div ref="dialog" class="modal-content sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title" tabindex="-1" @keydown="dialogKeydown">
                    <div class="modal-header sync-dialog-header">
                        <h3 id="sync-dialog-title">{{ $t(versions ? 'syncHistory' : plan.source === 'file' ? 'syncImportPreview' : 'syncPreview') }}</h3>
                        <button class="outline sync-icon-button" :title="$t('cancel')" :aria-label="$t('cancel')" :disabled="busy" @click="closeDialog"><X :size="17" /></button>
                    </div>
                    <div class="sync-dialog-body">
                        <template v-if="versions">
                            <p v-if="!versions.length" class="setting-muted">{{ $t('syncHistoryEmpty') }}</p>
                            <div v-for="version in versions" :key="version.id" class="sync-version-row">
                                <div><time>{{ date(version.at) }}</time><small>{{ $t('syncProfileCount').replace('{count}', version.profileCount) }} · {{ $t('syncGlobalSettings') }}</small><small>{{ version.current ? $t('syncCurrentVersion') + ' / ' : '' }}{{ version.device.slice(0, 8) }}</small></div>
                                <button class="outline sync-icon-button" :disabled="busy" :title="$t('syncRestore')" :aria-label="$t('syncRestore') + ' ' + date(version.at)" @click="restore(version)"><RotateCcw :size="17" /></button>
                            </div>
                        </template>
                        <template v-else>
                            <dl class="sync-change-summary"><div v-for="item in summary" :key="item.action"><dt>{{ $t('syncAction_' + item.action) }}</dt><dd>{{ $t('syncItemCount').replace('{count}', item.count) }}</dd></div></dl>
                            <div v-for="row in conflictRows" :key="row.key" class="sync-conflict-row">
                                <div><strong>{{ row.key === 'settings' ? $t('syncGlobalSettings') : row.name }}</strong><small>{{ $t('syncAction_' + row.action) }}</small></div>
                                <select v-model="choices[row.key]" :disabled="busy" :aria-label="row.name || $t('syncGlobalSettings')">
                                    <option value="skip">{{ $t('syncSkip') }}</option>
                                    <option v-if="row.action === 'conflict' && row.hash && plan.source !== 'file'" value="upload">{{ $t('syncUseLocal') }}</option>
                                    <option v-if="plan.source === 'file'" value="download">{{ $t('syncUseFile') }}</option>
                                    <option v-for="version in row.remotes || []" :key="version.id" :value="'download:' + version.id">{{ row.remotes.length > 1 ? remoteLabel(version) : $t('syncUseRemote') }}</option>
                                </select>
                            </div>
                        </template>
                    </div>
                    <div v-if="!versions" class="modal-footer sync-dialog-footer"><button class="outline" :disabled="busy" @click="closeDialog">{{ $t('cancel') }}</button><button class="primary" :disabled="busy" @click="applyPlan"><Check :size="15" />{{ $t('syncApply') }}</button></div>
                </div>
            </div>
        </Teleport>
    </details>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Cloud, PlugZap, Unplug, Save, RefreshCw, History, Download, Upload, X, Check, RotateCcw, ChevronDown } from '@lucide/vue';
import { ipcService } from '../services/ipc.service';
import { useUIStore } from '../store/useUIStore';
const ui = useUIStore();
const status = ref({ config: {}, canRemember: false, unlocked: false, phase: 'idle' });
const form = reactive({ url: '', folder: 'GeekEZ-Sync', username: '', password: '', passphrase: '', automatic: false, remember: false });
const working = ref(false);
const plan = ref(null);
const choices = reactive({});
const versions = ref(null);
const dialog = ref(null);
const busy = computed(() => working.value || status.value.busy);
const dirty = computed(() => ['url', 'folder', 'username', 'automatic', 'remember'].some(key => form[key] !== status.value.config[key]) || !!form.password || !!form.passphrase);
const dialogOpen = computed(() => !!versions.value || !!plan.value && !plan.value.remoteEmpty);
const conflictRows = computed(() => (plan.value?.rows || []).filter(row => ['conflict', 'removed'].includes(row.action)));
const summary = computed(() => ['upload', 'download', 'unchanged', 'conflict', 'removed', 'deferred']
    .map(action => ({ action, count: (plan.value?.rows || []).filter(row => row.action === action).length })).filter(item => item.count));
const date = value => new Date(value).toLocaleString(ui.lang === 'en' ? 'en-US' : 'zh-CN');
const remoteLabel = version => `${date(version.at)} / ${version.device?.slice(0, 6) || version.id.slice(0, 6)}`;
let unsubscribe;
let disposed = false;
let previousFocus;
watch(dialogOpen, async open => {
    if (open) { previousFocus = document.activeElement; await nextTick(); dialog.value?.focus(); }
    else previousFocus?.focus?.();
});
function dialogKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.value.querySelectorAll('button:not(:disabled), select:not(:disabled)')];
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus(); }
}
function closeDialog() {
    if (busy.value) return;
    if (versions.value) versions.value = null;
    else cancelPreview();
}

async function invoke(channel, payload = {}) {
    const result = await ipcService.invoke(channel, JSON.parse(JSON.stringify(payload)));
    if (!result?.success) throw new Error(window.t(result?.error || 'syncLocalError') + (result?.detail ? ` (${result.detail})` : ''));
    return result.data;
}
async function run(channel, payload) {
    working.value = true;
    try {
        const result = await invoke(channel, payload);
        if (disposed && result?.id) await invoke('config-sync-cancel', { id: result.id });
        return result;
    }
    catch (caught) { if (!disposed) ui.showAlert(caught.message); return null; }
    finally { working.value = false; }
}
async function testConnection() {
    if (await run('config-sync-test')) ui.showAlert(window.t('syncConnectionOk'));
}
async function saveConnection() {
    const result = await run('config-sync-save', form);
    if (!result) return;
    status.value = result;
    Object.assign(form, result.config, { password: '', passphrase: '' });
    plan.value = null;
    versions.value = null;
}
function disconnect() {
    ui.showConfirm(window.t('syncDisconnectConfirm'), async () => {
        const result = await run('config-sync-disconnect');
        if (!result) return;
        status.value = result;
        Object.assign(form, result.config, { password: '', passphrase: '' });
        plan.value = versions.value = null;
    });
}
async function cancelPreview() {
    if (plan.value) await run('config-sync-cancel', { id: plan.value.id });
    plan.value = null;
}
function setPlan(value) {
    if (!value || value.cancelled) return;
    plan.value = value;
    versions.value = null;
    for (const key of Object.keys(choices)) delete choices[key];
    for (const row of value.rows) choices[row.key] = ['conflict', 'removed'].includes(row.action) ? 'skip' : row.action;
}
async function preview() {
    const value = await run('config-sync-preview');
    if (!value || disposed) return;
    if (!value.remoteEmpty && value.rows.every(row => row.action === 'unchanged')) {
        if (await run('config-sync-apply', { id: value.id })) ui.showAlert(window.t('syncAlreadyCurrent'));
        return;
    }
    setPlan(value);
    if (value.remoteEmpty) {
        ui.showConfirm(window.t('syncInitialUploadConfirm').replace('{count}', value.profileCount), () => {
            if (!disposed) applyPlan();
        }, '', { okText: window.t('syncUploadAll'), onCancel: cancelPreview });
    }
}
async function applyPlan() {
    const result = await run(plan.value.source === 'file' ? 'config-sync-import-apply' : 'config-sync-apply', { id: plan.value.id, choices });
    if (result) { plan.value = null; ui.showAlert(window.t(result.conflicts ? 'syncPhase_conflict' : result.deferred ? 'syncAction_deferred' : 'syncPhase_synced')); }
}
async function loadHistory() {
    const result = await run('config-sync-history');
    if (!result) return;
    versions.value = result;
    plan.value = null;
}
function restore(version) {
    ui.showConfirm(window.t('syncRestoreConfirm').replace('{time}', date(version.at)).replace('{count}', version.profileCount), async () => {
        if (await run('config-sync-restore', { version: version.id })) { versions.value = null; ui.showAlert(window.t('syncPhase_restored')); }
    });
}
function withPassphrase(callback, confirm) {
    if (form.passphrase || status.value.unlocked) { callback(form.passphrase); return; }
    ui.openPasswordModal(window.t('syncPassphrase'), confirm, callback);
}
function exportFile() { withPassphrase(passphrase => run('config-sync-export', { passphrase }), true); }
function importFile() {
    ui.openPasswordModal(window.t('syncPassphrase'), false, async passphrase => {
        setPlan(await run('config-sync-import-preview', { passphrase }));
    });
}
onMounted(async () => {
    const result = await run('config-sync-status');
    if (result) { status.value = result; Object.assign(form, result.config); }
    unsubscribe = window.electronAPI?.onConfigSyncStatus?.(value => { status.value = value; });
});
onUnmounted(() => {
    disposed = true;
    unsubscribe?.();
    if (plan.value) invoke('config-sync-cancel', { id: plan.value.id }).catch(() => {});
});
</script>

<style scoped>
.sync-status { margin-left: auto; color: var(--text-secondary); font-weight: 400; font-size: 11px; text-align: right; max-width: 48%; overflow-wrap: anywhere; }
.sync-status.failed { color: var(--danger, #dc4157); }
.sync-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.sync-fields label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; color: var(--text-secondary); }
.sync-fields input { width: 100%; box-sizing: border-box; font-size: 12px; padding: 9px 10px; margin: 0; border-radius: 6px; }
.sync-wide { grid-column: 1 / -1; }
.sync-summary { display: flex; flex-direction: column; gap: 9px; padding: 16px 0; margin-top: 18px; border-top: 1px solid var(--border); font-size: 12px; }
.sync-summary > div { display: flex; justify-content: space-between; gap: 16px; }
.sync-summary > div > :first-child { color: var(--text-secondary); }
.sync-summary time { text-align: right; }
.sync-summary > div > :last-child { text-align: right; overflow-wrap: anywhere; }
.sync-command-row { display: flex; align-items: center; gap: 8px; }
.sync-command-spacer { flex: 1; }
.sync-dialog-overlay { z-index: 2000; -webkit-app-region: no-drag; }
.sync-dialog { width: min(620px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 20px; border-radius: 8px; border-color: var(--border); color: var(--text-primary); font-size: 13px; outline: none; }
.sync-dialog * { letter-spacing: 0; -webkit-app-region: no-drag; }
.sync-dialog-header { align-items: center; gap: 12px; margin-bottom: 0; padding-bottom: 12px; }
.sync-dialog-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary); }
.sync-dialog-body { overflow-y: auto; min-height: 0; padding: 4px 0; }
.sync-dialog button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; margin: 0; padding: 6px 12px; border-radius: 6px; font-size: 12px; line-height: 1.4; text-transform: none; white-space: normal; }
.sync-dialog .sync-icon-button { flex: 0 0 34px; width: 34px; height: 34px; padding: 0; }
.sync-dialog button:disabled, .sync-dialog select:disabled { opacity: .5; cursor: not-allowed; }
.sync-dialog button:focus-visible, .sync-dialog select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sync-version-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); }
.sync-version-row:last-child { border-bottom: 0; }
.sync-version-row > div { min-width: 0; }
.sync-version-row time { font-weight: 600; }
.sync-version-row small, .sync-conflict-row small { display: block; margin-top: 5px; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.sync-change-summary { margin: 0; padding: 8px 0; }
.sync-change-summary > div { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; }
.sync-change-summary dt { color: var(--text-secondary); }
.sync-change-summary dd { margin: 0; font-weight: 600; flex-shrink: 0; }
.sync-conflict-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 14px 0; border-top: 1px solid var(--border); }
.sync-conflict-row strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.sync-conflict-row select { width: 100%; min-width: 0; margin: 0; padding: 8px; font-size: 12px; }
.sync-dialog-footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 14px; margin-top: 8px; }
.spinning { animation: sync-spin 1s linear infinite; }
@keyframes sync-spin { to { transform: rotate(360deg); } }
@media (max-width: 420px) { .sync-fields { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
