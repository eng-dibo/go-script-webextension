import { verbose, isDomainAllowed } from '#/common';
import {
  getUniqId, bindEvents, attachFunction, cache2blobUrl,
} from '../utils';
import {
  includes, forEach, map, utf8decode, jsonDump, jsonLoad,
  Promise, console,
} from '../utils/helpers';
import bridge from './bridge';
import { onRequestCreate, onRequestStart, onRequestCallback } from './requests';
import {
  onNotificationCreate,
  onNotificationClicked,
  onNotificationClosed,
} from './notifications';
import { onTabCreate, onTabClosed } from './tabs';
import { onDownload } from './download';

let state = 0;

export default function initialize(webId, contentId, props) {
  bridge.props = props;
  bridge.post = bindEvents(webId, contentId, onHandle);
  document.addEventListener('DOMContentLoaded', () => {
    state = 1;
    // Load scripts after being handled by listeners in web page
    Promise.resolve().then(bridge.load);
  }, false);
  bridge.post({ cmd: 'Ready' });
}

const store = {
  commands: {},
  values: {},
  callbacks: {},
  lastCallbackId: 0,
  contextMenuHandlers: [],
};

function addCallback(callback) {
  if (typeof callback !== 'function') {
    return -1;
  }
  const requestId = store.lastCallbackId + 1;
  store.lastCallbackId = requestId;
  store.callbacks[requestId] = callback;
  return requestId;
}

function handleCallback(requestId, result) {
  if (requestId && store.callbacks[requestId]) {
    const callback = store.callbacks[requestId];
    delete store.callbacks[requestId];
    callback(result);
  }
}

function postCommandWithCallback(cmd, callback, data) {
  const requestId = addCallback(callback);
  bridge.post({
    cmd: 'PostCommand',
    data: { cmd, requestId, data },
  });
}

const handlers = {
  LoadScripts: onLoadScripts,
  Command(data) {
    const func = store.commands[data];
    if (func) func();
  },
  Callback({ callbackId, payload }) {
    const func = store.callbacks[callbackId];
    if (func) func(payload);
  },
  GotRequestId: onRequestStart,
  HttpRequested: onRequestCallback,
  TabClosed: onTabClosed,
  UpdatedValues(updates) {
    Object.keys(updates)
    .forEach(id => {
      if (store.values[id]) store.values[id] = updates[id];
    });
  },
  NotificationClicked: onNotificationClicked,
  NotificationClosed: onNotificationClosed,
  ScriptChecked(data) {
    if (bridge.onScriptChecked) bridge.onScriptChecked(data);
  },
  CommandResponse({ result, requestId }) {
    verbose(`web:CommandResponse: requestId=${requestId} result`, result);
    handleCallback(requestId, result);
  },
  WatchOnlineMenuClicked(data) {
    verbose('web:WatchOnlineMenuClicked: data', data);
    store.contextMenuHandlers.forEach(handler => {
      if (typeof handler === 'function') {
        handler(data.url);
      }
    });
  },
};

function registerCallback(callback) {
  const callbackId = getUniqId('VMcb');
  store.callbacks[callbackId] = payload => {
    callback(payload);
    delete store.callbacks[callbackId];
  };
  return callbackId;
}

function onHandle(obj) {
  const handle = handlers[obj.cmd];
  if (handle) handle(obj.data);
}

function onLoadScripts(data) {
  const start = [];
  const idle = [];
  const end = [];
  bridge.version = data.version;
  exposeAceScript();
  // reset load and checkLoad
  bridge.load = () => {
    run(end);
    setTimeout(run, 0, idle);
  };
  const listMap = {
    'document-start': start,
    'document-idle': idle,
    'document-end': end,
  };
  if (data.scripts) {
    forEach(data.scripts, script => {
      // XXX: use camelCase since v2.6.3
      const runAt = script.custom.runAt || script.custom['run-at']
        || script.meta.runAt || script.meta['run-at'];
      const list = listMap[runAt] || end;
      list.push(script);
      store.values[script.props.id] = data.values[script.props.id];
    });
    run(start);
  }
  if (!state && includes(['interactive', 'complete'], document.readyState)) {
    state = 1;
  }
  if (state) bridge.load();

  function buildCode(script) {
    const requireKeys = script.meta.require || [];
    const pathMap = script.custom.pathMap || {};
    const code = data.code[script.props.id] || '';
    const { wrapper, thisObj } = wrapGM(script, code, data.cache);
    // Must use Object.getOwnPropertyNames to list unenumerable properties
    const argNames = Object.getOwnPropertyNames(wrapper);
    const wrapperInit = map(argNames, name => `this["${name}"]=${name}`).join(';');
    const codeSlices = [`${wrapperInit};with(this)!function(define,module,exports){`];
    forEach(requireKeys, key => {
      const requireCode = data.require[pathMap[key] || key];
      if (requireCode) {
        codeSlices.push(requireCode);
        // Add `;` to a new line in case script ends with comment lines
        codeSlices.push(';');
      }
    });
    // wrap code to make 'use strict' work
    codeSlices.push(`!function(){${code}\n}.call(this)`);
    codeSlices.push('}.call(this);');
    const codeConcat = codeSlices.join('\n');
    const name = script.custom.name || script.meta.name || script.props.id;
    const args = map(argNames, key => wrapper[key]);
    const id = getUniqId('VMin');
    const fnId = getUniqId('VMfn');
    attachFunction(fnId, () => {
      const func = window[id];
      if (func) runCode(name, func, args, thisObj);
    });
    bridge.post({ cmd: 'Inject', data: [id, argNames, codeConcat, fnId] });
  }
  function run(list) {
    while (list.length) buildCode(list.shift());
  }
}

function wrapGM(script, code, cache) {
  // Add GM functions
  // Reference: http://wiki.greasespot.net/Greasemonkey_Manual:API
  const gm = {};
  const grant = script.meta.grant || [];
  const urls = {};
  const unsafeWindow = window;
  let thisObj = gm;
  if (!grant.length || (grant.length === 1 && grant[0] === 'none')) {
    // @grant none
    grant.pop();
    gm.window = unsafeWindow;
  } else {
    thisObj = getWrapper(unsafeWindow);
    gm.window = thisObj;
  }
  if (!includes(grant, 'unsafeWindow')) grant.push('unsafeWindow');
  if (!includes(grant, 'GM_info')) grant.push('GM_info');
  if (includes(grant, 'window.close')) gm.window.close = () => { bridge.post({ cmd: 'TabClose' }); };
  const resources = script.meta.resources || {};
  const dataDecoders = {
    o: val => jsonLoad(val),
    // deprecated
    n: val => Number(val),
    b: val => val === 'true',
  };
  const pathMap = script.custom.pathMap || {};
  const matches = code.match(/\/\/\s+==UserScript==\s+([\s\S]*?)\/\/\s+==\/UserScript==\s/);
  const metaStr = matches ? matches[1] : '';
  const gmInfo = {
    uuid: script.props.uuid,
    scriptMetaStr: metaStr,
    scriptWillUpdate: !!script.config.shouldUpdate,
    scriptHandler: 'AceScript',
    version: bridge.version,
    script: {
      description: script.meta.description || '',
      excludes: [...script.meta.exclude],
      includes: [...script.meta.include],
      matches: [...script.meta.match],
      name: script.meta.name || '',
      namespace: script.meta.namespace || '',
      resources: Object.keys(resources).map(name => ({
        name,
        url: resources[name],
      })),
      runAt: script.meta.runAt || '',
      unwrap: false, // deprecated, always `false`
      version: script.meta.version || '',
    },
  };
  const gmFunctions = {
    unsafeWindow: { value: unsafeWindow },
    GM_info: { value: gmInfo },
    GM_deleteValue: {
      value(key) {
        const value = loadValues();
        delete value[key];
        dumpValue(key);
      },
    },
    GM_getValue: {
      value(key, def) {
        const value = loadValues();
        const raw = value[key];
        if (raw) {
          const type = raw[0];
          const handle = dataDecoders[type];
          let val = raw.slice(1);
          try {
            if (handle) val = handle(val);
          } catch (e) {
            if (process.env.DEBUG) console.warn(e);
          }
          return val;
        }
        return def;
      },
    },
    GM_listValues: {
      value() {
        return Object.keys(loadValues());
      },
    },
    GM_setValue: {
      value(key, val) {
        const dumped = jsonDump(val);
        const raw = dumped ? `o${dumped}` : null;
        const value = loadValues();
        value[key] = raw;
        dumpValue(key, raw);
      },
    },
    GM_getResourceText: {
      value(name) {
        if (name in resources) {
          const key = resources[name];
          const raw = cache[pathMap[key] || key];
          const text = raw && utf8decode(window.atob(raw.split(',').pop()));
          return text;
        }
      },
    },
    GM_getResourceURL: {
      value(name) {
        if (name in resources) {
          const key = resources[name];
          let blobUrl = urls[key];
          if (!blobUrl) {
            const raw = cache[pathMap[key] || key];
            if (raw) {
              blobUrl = cache2blobUrl(raw);
              urls[key] = blobUrl;
            } else {
              blobUrl = key;
            }
          }
          return blobUrl;
        }
      },
    },
    GM_addStyle: {
      value(css) {
        const callbacks = [];
        let el = false;
        const callbackId = registerCallback(styleId => {
          el = document.getElementById(styleId);
          callbacks.splice().forEach(callback => callback(el));
        });
        bridge.post({ cmd: 'AddStyle', data: { css, callbackId } });
        // Mock a Promise without the need for polyfill
        return {
          then(callback) {
            if (el !== false) callback(el);
            else callbacks.push(callback);
          },
        };
      },
    },
    GM_log: {
      value(...args) {
        // eslint-disable-next-line no-console
        console.log(`[AceScript][${script.meta.name || 'No name'}]`, ...args);
      },
    },
    GM_openInTab: {
      value(url, options) {
        const data = options && typeof options === 'object' ? options : {
          active: !options,
        };
        data.url = url;
        return onTabCreate(data);
      },
    },
    GM_registerMenuCommand: {
      value(cap, func) {
        const { id } = script.props;
        const key = `${id}:${cap}`;
        store.commands[key] = func;
        bridge.post({ cmd: 'RegisterMenu', data: [key, cap] });
      },
    },
    GM_unregisterMenuCommand: {
      value(cap) {
        const { id } = script.props;
        const key = `${id}:${cap}`;
        delete store.commands[key];
        bridge.post({ cmd: 'UnregisterMenu', data: [key, cap] });
      },
    },
    GM_xmlhttpRequest: {
      value: onRequestCreate,
    },
    GM_download: {
      value: onDownload,
    },
    GM_notification: {
      value(text, title, image, onclick) {
        const options = typeof text === 'object' ? text : {
          text,
          title,
          image,
          onclick,
        };
        if (!options.text) {
          throw new Error('GM_notification: `text` is required!');
        }
        onNotificationCreate(options);
      },
    },
    GM_setClipboard: {
      value(data, type) {
        bridge.post({
          cmd: 'SetClipboard',
          data: { type, data },
        });
      },
    },
    AWE_engineStatus: {
      value(callback) {
        postCommandWithCallback('GetEngineStatus', callback);
      },
    },
    AWE_startJsPlayer: {
      value() {
        throw new Error('not implemented');
      },
    },
    AWE_getAvailablePlayers: {
      value(params, callback) {
        postCommandWithCallback('GetAvailablePlayers', callback, { params });
      },
    },
    AWE_openInPlayer: {
      value(params, playerId, callback) {
        postCommandWithCallback('OpenInPlayer', callback, { params, playerId });
      },
    },
    AWE_getDeviceId: {
      value(callback) {
        postCommandWithCallback('GetDeviceId', callback);
      },
    },
    AWE_registerContextMenuCommand: {
      // eslint-disable-next-line no-unused-vars
      value(caption, commandFunc, accessKey, filterFunc) {
        postCommandWithCallback('RegisterContextMenuCommand', () => {
          store.contextMenuHandlers.push(commandFunc);
        });
      },
    },
    AWE_getLocale: {
      value(callback) {
        postCommandWithCallback('GetLocale', callback);
      },
    },
    AWE_getConfig: {
      value(name, callback) {
        postCommandWithCallback('GetConfig', callback, { name });
      },
    },
  };
  forEach(grant, name => {
    const prop = gmFunctions[name];
    if (prop) addProperty(name, prop, gm);
  });
  return { thisObj, wrapper: gm };
  function loadValues() {
    return store.values[script.props.id];
  }
  function propertyToString() {
    return '[AceScript property]';
  }
  function addProperty(name, prop, obj) {
    if ('value' in prop) prop.writable = false;
    prop.configurable = false;
    Object.defineProperty(obj, name, prop);
    if (typeof obj[name] === 'function') obj[name].toString = propertyToString;
  }
  function dumpValue(key, value) {
    bridge.post({
      cmd: 'UpdateValue',
      data: {
        id: script.props.id,
        update: { key, value },
      },
    });
  }
}

/**
 * @desc Wrap helpers to prevent unexpected modifications.
 */
function getWrapper(unsafeWindow) {
  // http://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects
  // http://developer.mozilla.org/docs/Web/API/Window
  const wrapper = {};
  // Block special objects
  forEach([
    'browser',
  ], name => {
    wrapper[name] = undefined;
  });
  forEach([
    // `eval` should be called directly so that it is run in current scope
    'eval',
  ], name => {
    wrapper[name] = unsafeWindow[name];
  });
  forEach([
    // 'uneval',
    'isFinite',
    'isNaN',
    'parseFloat',
    'parseInt',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',

    'addEventListener',
    'alert',
    'atob',
    'blur',
    'btoa',
    'clearInterval',
    'clearTimeout',
    'close',
    'confirm',
    'dispatchEvent',
    'fetch',
    'find',
    'focus',
    'getComputedStyle',
    'getDefaultComputedStyle', // Non-standard, Firefox only, used by jQuery
    'getSelection',
    'matchMedia',
    'moveBy',
    'moveTo',
    'open',
    'openDialog',
    'postMessage',
    'print',
    'prompt',
    'removeEventListener',
    'requestAnimationFrame',
    'resizeBy',
    'resizeTo',
    'scroll',
    'scrollBy',
    'scrollByLines',
    'scrollByPages',
    'scrollTo',
    'setInterval',
    'setTimeout',
    'stop',
  ], name => {
    const method = unsafeWindow[name];
    if (method) {
      wrapper[name] = (...args) => method.apply(unsafeWindow, args);
    }
  });
  function defineProtectedProperty(name) {
    let modified = false;
    let value;
    Object.defineProperty(wrapper, name, {
      get() {
        if (!modified) value = unsafeWindow[name];
        return value === unsafeWindow ? wrapper : value;
      },
      set(val) {
        modified = true;
        value = val;
      },
    });
  }
  function defineReactedProperty(name) {
    Object.defineProperty(wrapper, name, {
      get() {
        const value = unsafeWindow[name];
        return value === unsafeWindow ? wrapper : value;
      },
      set(val) {
        unsafeWindow[name] = val;
      },
    });
  }
  // Wrap properties
  forEach(bridge.props, name => {
    if (name in wrapper) return;
    if (name.slice(0, 2) === 'on') defineReactedProperty(name);
    else defineProtectedProperty(name);
  });
  return wrapper;
}

function runCode(name, func, args, thisObj) {
  if (process.env.DEBUG) {
    console.log(`Run script: ${name}`); // eslint-disable-line no-console
  }
  try {
    func.apply(thisObj, args);
  } catch (e) {
    let msg = `Error running script: ${name}\n${e}`;
    if (e.message) msg = `${msg}\n${e.message}`;
    console.error(msg);
  }
}

function exposeAceScript() {
  const AceScript = {};

  // public methods (for all domains)
  Object.defineProperty(AceScript, 'startEngine', {
    value: callback => {
      postCommandWithCallback('StartEngine', callback);
    },
  });

  // protected methods (exposed only to allowed domains)
  if (isDomainAllowed(window.location.host)) {
    verbose(`expose AceScript to ${window.location.href}`);

    Object.defineProperty(AceScript, 'getVersion', {
      value: () => Promise.resolve({
        version: bridge.version,
      }),
    });
    Object.defineProperty(AceScript, 'isInstalled', {
      value: (name, namespace) => new Promise(resolve => {
        postCommandWithCallback('CheckScript', resolve, { name, namespace });
      }),
    });
  }

  Object.defineProperty(window.external, 'AceScript', {
    value: AceScript,
  });
}
