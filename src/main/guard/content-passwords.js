(function () {
    'use strict';

    if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

    const inputTypes = new Set(['text', 'email', 'tel', 'number', 'password']);
    const otpHint = /\b(?:totp|otp|2fa|authenticator)\b|one[\s_-]*time[\s_-]*(?:code|password)|two[\s_-]*(?:factor|step)|\u9a8c\u8bc1\u5668|\u9a57\u8b49\u5668|\u52a8\u6001\u53e3\u4ee4|\u52d5\u614b\u53e3\u4ee4|\u53cc\u91cd\u9a8c\u8bc1|\u96d9\u91cd\u9a57\u8b49|\u4e24\u6b65\u9a8c\u8bc1/;
    const authenticatorHint = /\b(?:totp|authenticator|2fa)\b|authentication[\s_-]*app|two[\s_-]*factor|\u9a8c\u8bc1\u5668|\u9a57\u8b49\u5668|\u52a8\u6001\u53e3\u4ee4|\u52d5\u614b\u53e3\u4ee4/;
    const codeHint = /verification[\s_-]*code|security[\s_-]*code|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc/;
    const otherCodeHint = /\b(?:sms|email|e-mail|phone|mobile|captcha|recaptcha|postal|zip|promo|coupon|search|recovery|backup|card)\b|text[\s_-]*message|\u77ed\u4fe1|\u77ed\u8a0a|\u90ae\u7bb1|\u90f5\u7bb1|\u90ae\u4ef6|\u90f5\u4ef6|\u624b\u673a|\u624b\u6a5f|\u56fe\u5f62\u9a8c\u8bc1|\u5716\u5f62\u9a57\u8b49|\u4f18\u60e0|\u512a\u60e0|\u5907\u4efd|\u5099\u4efd/;
    const deliveredCodeHint = /(?:sent|send|texted|emailed|delivered).{0,70}(?:sms|email|e-mail|phone|mobile|number|\bto\b)|(?:sms|email|e-mail|phone|mobile).{0,40}(?:sent|send|texted|delivered)|(?:\u53d1\u9001|\u767c\u9001).{0,35}(?:\u624b\u673a|\u624b\u6a5f|\u90ae\u7bb1|\u90f5\u7bb1|\u77ed\u4fe1|\u77ed\u8a0a)/;
    const controls = new Map();
    const writtenValues = new WeakMap();
    const editedFields = new WeakSet();
    const passwordAttempts = new WeakSet();
    const otpAttempts = new Set();
    let accounts = null;
    let accountRequest = null;
    let accountError = false;
    let scanTimer = null;
    let scanRunning = false;
    let scanAgain = false;
    let retryField = null;
    let running = false;
    let lifecycle = 0;
    let host = null;
    let ui = null;
    let menu = null;
    let lastCredentials = null;
    let lastSaved = '';
    let requestEpoch = 0;
    let fillPending = false;
    const observer = new MutationObserver(onMutations);

    function activePage() {
        return running && document.visibilityState === 'visible' && document.hasFocus();
    }

    function visible(input) {
        if (!(input instanceof HTMLInputElement) || !input.isConnected || !inputTypes.has(input.type)) return false;
        if (input.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
        if (input.checkVisibility && !input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    }

    function editable(input) {
        return visible(input) && !input.disabled && !input.readOnly && !input.matches(':disabled');
    }

    function normalized(value) {
        return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    }

    function fieldText(input) {
        const references = ['aria-labelledby', 'aria-describedby'].flatMap(attribute =>
            (input.getAttribute(attribute) || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '')
        );
        return normalized([input.name, input.id, input.autocomplete, input.placeholder, input.getAttribute('aria-label'),
            ...Array.from(input.labels || [], label => label.textContent), ...references].join(' ').slice(0, 1600));
    }

    function contextText(input, scope) {
        let node = scope || input.parentElement;
        const parts = [];
        for (let depth = 0; node && node !== document.body && node !== document.documentElement && depth < 4; depth++, node = node.parentElement) {
            const text = node.textContent || '';
            if (text.length > 2400) break;
            parts.push(text);
            if (node.matches('form, fieldset, [role="dialog"]')) break;
        }
        return normalized(parts.join(' ').slice(0, 4000));
    }

    function otpEvidence(input, scope, split) {
        const own = fieldText(input);
        if (input.type === 'email' || otherCodeHint.test(own)) return false;
        const context = contextText(input, scope);
        if (deliveredCodeHint.test(context)) return false;
        if (otherCodeHint.test(context) && !authenticatorHint.test(own + ' ' + context)) return false;
        if (otpHint.test(own)) return true;
        if (split) return otpHint.test(context) || codeHint.test(own + ' ' + context);
        const codeField = input.type !== 'password' && (input.maxLength === 6 || input.maxLength === 8 ||
            input.inputMode === 'numeric' || /\b(?:code|token|pin)\b/.test(own) || codeHint.test(own));
        return codeField && otpHint.test(context);
    }

    function otpKey(fields) {
        return [location.href, ...fields.map(input => [input.id, input.name, input.autocomplete, input.getAttribute('aria-label'),
            input.closest('form')?.id].join(':'))].join('|');
    }

    function findOtpGroups(inputs) {
        const groups = [];
        const used = new Set();
        for (const input of inputs) {
            if (used.has(input)) continue;
            if (input.maxLength === 1) {
                let scope = input.parentElement;
                for (let depth = 0; scope && scope !== document.body && depth < 4; depth++, scope = scope.parentElement) {
                    const fields = Array.from(scope.querySelectorAll('input')).filter(editable);
                    if (fields.length > 6) break;
                    if (fields.length !== 6 || fields.some(field => field.maxLength !== 1 || used.has(field))) continue;
                    if (!fields.every(field => otpEvidence(field, scope, true))) break;
                    fields.forEach(field => used.add(field));
                    groups.push({ fields, key: otpKey(fields), scope });
                    break;
                }
            } else if ((input.maxLength < 0 || input.maxLength >= 6) && otpEvidence(input, null, false)) {
                used.add(input);
                groups.push({ fields: [input], key: otpKey([input]) });
            }
        }
        return groups;
    }

    function usernameField(passwordField) {
        const scope = passwordField.closest('form') || document.body;
        const fields = Array.from(scope.querySelectorAll('input')).filter(visible);
        const preceding = fields.slice(0, fields.indexOf(passwordField)).filter(input =>
            ['text', 'email', 'tel'].includes(input.type) && !otpHint.test(fieldText(input))
        ).reverse();
        return preceding.find(input => /username|email|login|account|\buser\b/.test(fieldText(input))) ||
            preceding.find(input => !/search|captcha|promo|coupon/.test(fieldText(input))) || null;
    }

    function message(type, payload = {}) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage({ type, ...payload }, response => {
                    const error = chrome.runtime.lastError;
                    if (error || !response || response.success === false) {
                        reject(new Error(error?.message || response?.error || 'GeekEZ is unavailable'));
                    } else resolve(response);
                });
            } catch (error) { reject(error); }
        });
    }

    function invalidateAccounts() {
        accounts = null;
        accountError = false;
        accountRequest = null;
        requestEpoch++;
    }

    async function getAccounts(refresh = false) {
        if (refresh) invalidateAccounts();
        if (accounts) return accounts;
        if (accountError) return [];
        if (!accountRequest) {
            const epoch = requestEpoch;
            accountRequest = message('QUERY_PASSWORDS').then(response => {
                const result = Array.isArray(response.passwords) ? response.passwords : [];
                if (epoch === requestEpoch) accounts = result;
                return result;
            }).catch(() => {
                if (epoch === requestEpoch) accountError = true;
                return [];
            }).finally(() => {
                if (epoch === requestEpoch) accountRequest = null;
            });
        }
        return accountRequest;
    }

    function setValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        writtenValues.set(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function canReplace(input) {
        return !input.value || input.value === writtenValues.get(input);
    }

    async function fillPassword(input, account, explicit = false) {
        if (fillPending || !activePage() || !editable(input) || !account.password || !canReplace(input)) return;
        const user = usernameField(input);
        if (user?.value && user.value !== account.username && (!explicit || !canReplace(user))) return;
        if (!explicit && editedFields.has(input)) return;
        const currentLifecycle = lifecycle;
        fillPending = true;
        try {
            await message('SELECT_PASSWORD', { id: account.id });
            if (currentLifecycle !== lifecycle || !activePage()) { passwordAttempts.delete(input); return; }
            if (!editable(input) || !canReplace(input)) return;
            if (user?.value && user.value !== account.username && !canReplace(user)) return;
            if (user && editable(user) && canReplace(user)) setValue(user, account.username || '');
            setValue(input, account.password);
        } finally { fillPending = false; scheduleScan(); }
    }

    async function fillOtp(group, explicit = false, account = null) {
        if (fillPending || !activePage() || group.fields.some(input => !editable(input) || input.value)) return;
        if (!explicit && (otpAttempts.has(group.key) || group.fields.some(input => editedFields.has(input)))) return;
        otpAttempts.add(group.key);
        const currentLifecycle = lifecycle;
        fillPending = true;
        try {
            if (account) await message('SELECT_PASSWORD', { id: account.id });
            if (currentLifecycle !== lifecycle || !activePage()) { otpAttempts.delete(group.key); return; }
            if (group.fields.some(input => !editable(input) || input.value)) return;
            const response = await message('GET_TOTP');
            if (currentLifecycle !== lifecycle || !activePage()) { otpAttempts.delete(group.key); return; }
            if (otpKey(group.fields) !== group.key || group.fields.some(input => !editable(input) || input.value ||
                !otpEvidence(input, group.scope, group.fields.length > 1))) return;
            if (typeof response.code !== 'string' || !/^\d{6,8}$/.test(response.code) ||
                !Number.isFinite(Number(response.expiresAt)) || Number(response.expiresAt) <= Date.now()) throw new Error('The 2FA code expired. Try again.');
            if (group.fields.length > 1 && group.fields.length !== response.code.length) throw new Error('This 2FA field uses a different code length.');
            group.fields.forEach((input, index) => setValue(input, group.fields.length === 1 ? response.code : response.code[index]));
        } finally { fillPending = false; scheduleScan(); }
    }

    function ensureUi() {
        if (host) {
            if (!host.isConnected) document.documentElement.appendChild(host);
            return;
        }
        host = document.createElement('div');
        host.style.cssText = 'all:initial;position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483647;pointer-events:none';
        ui = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = ':host{color-scheme:light}*{box-sizing:border-box;letter-spacing:0;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{cursor:pointer;pointer-events:auto}.fill{position:fixed;width:24px;height:24px;padding:0;border:1px solid #9cb8e5;border-radius:5px;background:#fff;color:#2356a7;font-weight:700;box-shadow:0 1px 3px #0002}.fill:hover,.fill:focus-visible{background:#edf4ff;border-color:#2356a7}.menu{position:fixed;width:min(280px,calc(100vw - 16px));max-height:min(220px,calc(100vh - 16px));overflow:auto;background:#fff;color:#202632;border:1px solid #c8cdd5;border-radius:6px;box-shadow:0 4px 14px #0003;pointer-events:auto}.account{display:block;text-align:left;overflow-wrap:anywhere;width:100%;min-height:36px;padding:9px 12px;border:0;border-bottom:1px solid #edf0f4;background:#fff;color:inherit}.account:hover,.account:focus-visible{background:#edf4ff}.error{margin:0;padding:10px 12px;overflow-wrap:anywhere}';
        ui.appendChild(style);
        document.documentElement.appendChild(host);
    }

    function closeMenu() {
        menu?.remove();
        menu = null;
    }

    function openMenu(anchor) {
        ensureUi();
        closeMenu();
        menu = document.createElement('div');
        menu.className = 'menu';
        const rect = anchor.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - Math.min(280, innerWidth - 16) - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - 228)) + 'px';
        ui.appendChild(menu);
        return menu;
    }

    function reportError(control, error, explicit) {
        control.button.title = 'GeekEZ: ' + error.message;
        if (explicit) {
            const panel = openMenu(control.button);
            const text = document.createElement('p');
            text.className = 'error';
            text.setAttribute('role', 'alert');
            text.textContent = error.message;
            panel.appendChild(text);
        }
    }

    async function useControl(control) {
        if (!activePage() || control.busy) return;
        control.busy = true;
        const currentLifecycle = lifecycle;
        try {
            const list = (await getAccounts(true)).filter(account => control.kind !== 'otp' || account.twoFactorEnabled);
            if (currentLifecycle !== lifecycle || !activePage() || !control.input.isConnected) return;
            if (!list.length) throw new Error('No saved account is available for this site.');
            const fill = async account => {
                closeMenu();
                try {
                    if (control.kind === 'otp') {
                        await fillOtp(control.group, true, account);
                    } else await fillPassword(control.input, account, true);
                    scheduleScan();
                } catch (error) { if (activePage()) reportError(control, error, true); }
            };
            if (list.length === 1) await fill(list[0]);
            else {
                const panel = openMenu(control.button);
                panel.setAttribute('role', 'menu');
                for (const account of list) {
                    const item = document.createElement('button');
                    item.className = 'account';
                    item.type = 'button';
                    item.setAttribute('role', 'menuitem');
                    item.textContent = account.username || account.name || account.origin;
                    item.addEventListener('click', event => { event.stopPropagation(); void fill(account); }, { once: true });
                    panel.appendChild(item);
                }
            }
        } catch (error) { if (activePage()) reportError(control, error, true); }
        finally { control.busy = false; }
    }

    function addControl(input, kind, group) {
        let control = controls.get(input);
        if (!control) {
            ensureUi();
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'fill';
            button.textContent = 'G';
            control = { input, button, kind, group, busy: false };
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void useControl(control); });
            ui.appendChild(button);
            controls.set(input, control);
        }
        control.kind = kind;
        control.group = group;
        const title = kind === 'otp' ? 'GeekEZ: Fill 2FA code' : 'GeekEZ: Fill password';
        control.button.title = title;
        control.button.setAttribute('aria-label', title);
        const rect = input.getBoundingClientRect();
        control.button.style.left = Math.max(4, Math.min(rect.right + 4, innerWidth - 28)) + 'px';
        control.button.style.top = Math.max(4, rect.top + (rect.height - 24) / 2) + 'px';
        return control;
    }

    async function scanPage() {
        scanTimer = null;
        if (!activePage()) return;
        if (scanRunning) { scanAgain = true; return; }
        scanRunning = true;
        const retry = retryField;
        retryField = null;
        const currentLifecycle = lifecycle;
        try {
            const inputs = Array.from(document.querySelectorAll('input')).filter(editable);
            const otpGroups = findOtpGroups(inputs);
            const otpFields = new Set(otpGroups.flatMap(group => group.fields));
            const passwordFields = inputs.filter(input => input.type === 'password' && !otpFields.has(input) &&
                !/new-password|confirm|repeat|new[\s_-]*password|\u786e\u8ba4|\u78ba\u8a8d|\u65b0\u5bc6\u7801|\u65b0\u5bc6\u78bc/.test(fieldText(input)));
            const anchors = new Set([...passwordFields, ...otpGroups.map(group => group.fields.at(-1))]);
            for (const [input, control] of controls) {
                if (!anchors.has(input)) { control.button.remove(); controls.delete(input); closeMenu(); }
            }
            if (!anchors.size) return;
            const list = await getAccounts();
            if (currentLifecycle !== lifecycle || !activePage() || !list.length) return;
            for (const input of passwordFields) {
                if (!editable(input)) continue;
                const control = addControl(input, 'password');
                if (list.length !== 1 || passwordAttempts.has(input)) continue;
                passwordAttempts.add(input);
                const sameFormFields = passwordFields.filter(field => field.form === input.form);
                if (sameFormFields.length > 1 && input.autocomplete !== 'current-password') continue;
                try { await fillPassword(input, list[0]); }
                catch (error) { if (activePage()) reportError(control, error, false); }
            }
            if (!list.some(account => account.twoFactorEnabled)) return;
            for (const group of otpGroups) {
                if (group.fields.some(input => !editable(input))) continue;
                const control = addControl(group.fields.at(-1), 'otp', group);
                try { await fillOtp(group, group.fields.includes(retry)); }
                catch (error) { if (activePage()) reportError(control, error, false); }
            }
        } finally {
            scanRunning = false;
            if (scanAgain) { scanAgain = false; scheduleScan(); }
        }
    }

    function scheduleScan(field = null) {
        if (!activePage()) return;
        if (field) retryField = field;
        if (scanTimer === null) scanTimer = setTimeout(() => { void scanPage(); }, 120);
    }

    function relevantNode(node) {
        if (!(node instanceof Element) || node === host) return false;
        return node.matches('input, form, fieldset, label') || !!node.querySelector('input');
    }

    function onMutations(records) {
        if (!activePage()) return;
        if (records.some(record => record.target !== host && (record.type === 'attributes'
            ? relevantNode(record.target)
            : [...record.addedNodes, ...record.removedNodes].some(relevantNode) ||
                [...record.addedNodes].some(node => node.nodeType === Node.TEXT_NODE && relevantNode(record.target))))) scheduleScan();
    }

    function collectCredentials(input) {
        if (!input || input.type !== 'password' || input.maxLength === 1 || !visible(input) || otpHint.test(fieldText(input))) return null;
        const user = usernameField(input);
        const username = user?.value || lastCredentials?.username;
        const password = input.value;
        if (!username || !password) return null;
        return { origin: location.origin, url: location.href, name: location.hostname, username, password };
    }

    function saveCredentials(input) {
        const entry = collectCredentials(input) || (!input ? lastCredentials : null);
        if (!entry) return;
        const key = JSON.stringify([entry.origin, entry.username, entry.password]);
        if (lastSaved === key || accounts?.some(account => account.username === entry.username && account.password === entry.password)) return;
        lastSaved = key;
        void message('SAVE_PASSWORD', { entry }).then(() => { invalidateAccounts(); }).catch(() => { lastSaved = ''; });
    }

    function onInput(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !event.isTrusted) return;
        editedFields.add(input);
        writtenValues.delete(input);
        const password = input.type === 'password' ? input : input.form?.querySelector('input[type="password"]');
        const entry = collectCredentials(password);
        if (entry) lastCredentials = entry;
    }

    function onFocus(event) {
        if (!(event.target instanceof HTMLInputElement)) return;
        if (accountError || !accounts?.length) invalidateAccounts();
        scheduleScan(event.target);
    }

    function onSubmit(event) {
        if (event.target instanceof HTMLFormElement) saveCredentials(event.target.querySelector('input[type="password"]'));
    }

    function onClick(event) {
        if (event.composedPath().includes(host)) return;
        closeMenu();
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest('button, input[type="submit"], input[type="button"], [role="button"], .btn, .button');
        if (!button) return;
        const text = (button.textContent || button.value || '').trim().toLowerCase();
        if (!(button.type === 'submit' || /log\s*in|sign\s*in|\u767b\u5f55|\u767b\u5165/.test(text))) return;
        const scope = button.closest('form') || document;
        const password = Array.from(scope.querySelectorAll('input[type="password"]')).find(visible);
        if (password) saveCredentials(password);
    }

    function onKey(event) { if (event.key === 'Escape') closeMenu(); }
    function onPosition() { closeMenu(); scheduleScan(); }
    function onActivation() {
        if (document.visibilityState === 'hidden') {
            clearTimeout(scanTimer);
            scanTimer = null;
            closeMenu();
            return;
        }
        invalidateAccounts();
        scheduleScan();
    }

    function start() {
        if (running) return;
        running = true;
        lifecycle++;
        invalidateAccounts();
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['type', 'name', 'id', 'autocomplete', 'placeholder', 'aria-label', 'aria-labelledby', 'aria-describedby',
                'maxlength', 'disabled', 'readonly', 'hidden', 'style', 'class', 'aria-hidden', 'inert'] });
        document.addEventListener('input', onInput, true);
        document.addEventListener('change', onInput, true);
        document.addEventListener('focusin', onFocus, true);
        document.addEventListener('submit', onSubmit, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('visibilitychange', onActivation);
        window.addEventListener('focus', onActivation);
        window.addEventListener('scroll', onPosition, true);
        window.addEventListener('resize', onPosition);
        window.addEventListener('popstate', onPosition);
        window.addEventListener('hashchange', onPosition);
        scheduleScan();
    }

    function stop() {
        if (!running) return;
        saveCredentials(null);
        running = false;
        lifecycle++;
        observer.disconnect();
        clearTimeout(scanTimer);
        scanTimer = null;
        retryField = null;
        scanAgain = false;
        closeMenu();
        host?.remove();
        host = null;
        ui = null;
        controls.clear();
        invalidateAccounts();
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('change', onInput, true);
        document.removeEventListener('focusin', onFocus, true);
        document.removeEventListener('submit', onSubmit, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('visibilitychange', onActivation);
        window.removeEventListener('focus', onActivation);
        window.removeEventListener('scroll', onPosition, true);
        window.removeEventListener('resize', onPosition);
        window.removeEventListener('popstate', onPosition);
        window.removeEventListener('hashchange', onPosition);
    }

    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', start);
    start();
})();
