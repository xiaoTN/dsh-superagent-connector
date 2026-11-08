window.__ModuleLoader__.load({
  id: 'dsh-superagent-connector',
  factory: function (require) {
    'use strict';
    var React = require('react');
    var h = React.createElement;
    var PANEL = 'dsh-superagent-board';
    var IDENTITY_API = '/@superagent-board/api/identity';
    // Source is the only authority. This shared cache is memory-only, never inferred from Feishu.
    var identityState = {identity:null,loading:false,error:''}, identityListeners = new Set();
    var identityRequest = null, identityOwners = 0, identityEpoch = 0, identityStop = null;
    function validName(value) {
      return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= 80 && !/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff\ud800-\udfff]/u.test(value);
    }
    function identityBody(body) {
      if (!body || !body.agent || !validName(body.agent.name) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('format');
      return {agent:{name:body.agent.name},revision:body.revision};
    }
    function publishIdentity(patch) {
      identityState = Object.assign({}, identityState, patch);
      identityListeners.forEach(function (listener) { listener(); });
    }
    function acceptIdentity(identity) {
      var previous = identityState.identity;
      // An older GET must never roll back a confirmed PUT or a more recent read.
      if (previous && identity.revision < previous.revision) return;
      if (previous && identity.revision === previous.revision && identity.agent.name !== previous.agent.name) throw new Error('format');
      publishIdentity({identity:identity,error:''});
    }
    function subscribeIdentity(listener) { identityListeners.add(listener); return function () { identityListeners.delete(listener); }; }
    function identitySnapshot() { return identityState; }
    function useIdentity() { return React.useSyncExternalStore(subscribeIdentity,identitySnapshot,identitySnapshot); }
    function agentName(entry) { return identityState.identity ? identityState.identity.agent.name : entry && validName(entry.agentName) ? entry.agentName : 'SuperAgent'; }
    function identityError(err, timedOut) {
      if (timedOut) return '名称请求超时。已有名称和输入保留，可重新读取后重试。';
      var labels = {400:'名称输入不合法，请使用 1–80 字且不含控制字符的名称。',401:'尚未登录，请登录后重新读取名称。',403:'没有名称设置授权。',409:'名称已被其他用户修改，请重新读取后再保存。',503:'名称服务离线，已有名称和输入保留，可重新读取后重试。'};
      return err && labels[err.status] || (err && err.message === 'format' ? '名称响应格式异常，已有名称和输入保留。' : '名称读取或保存失败，已有名称和输入保留，可重新读取后重试。');
    }
    function refreshIdentity() {
      if (identityRequest) return identityRequest.promise;
      var controller = new AbortController(), epoch = identityEpoch, timedOut = false;
      var request = {controller:controller,promise:null}; identityRequest = request;
      publishIdentity({loading:true});
      var timeout = setTimeout(function () { timedOut = true; controller.abort(); },15000);
      request.promise = fetch(IDENTITY_API,{method:'GET',headers:{'x-superagent-board':'1'},credentials:'same-origin',cache:'no-store',signal:controller.signal})
        .then(function (response) { if (!response.ok) { var err = new Error('HTTP'); err.status = response.status; throw err; } return response.json().catch(function () { throw new Error('format'); }); })
        .then(function (body) { var identity = identityBody(body); if (epoch !== identityEpoch) return false; acceptIdentity(identity); return true; })
        .catch(function (err) { if (epoch === identityEpoch && (!controller.signal.aborted || timedOut)) publishIdentity({error:identityError(err,timedOut)}); return false; })
        .finally(function () { clearTimeout(timeout); if (identityRequest === request) { identityRequest = null; publishIdentity({loading:false}); } });
      return request.promise;
    }
    function startIdentity() {
      if (identityOwners++ === 0) {
        refreshIdentity();
        var timer = setInterval(function () { if (!document.hidden) refreshIdentity(); },15000);
        function visible() { if (!document.hidden) refreshIdentity(); }
        document.addEventListener('visibilitychange',visible);
        identityStop = function () {
          clearInterval(timer); document.removeEventListener('visibilitychange',visible); identityEpoch++;
          if (identityRequest) { identityRequest.controller.abort(); identityRequest = null; }
        };
      }
      var stopped = false;
      return function () { if (stopped) return; stopped = true; if (--identityOwners === 0) { identityStop(); identityStop = null; } };
    }
    var shellCss = '.sab-panel{display:flex;flex-direction:column;overflow:hidden}.sab-shellhead{padding:14px 24px;border-bottom:1px solid var(--dsw-alias-border-l2,#dbe3ee);flex:none}.sab-shellhead h1{font-size:22px}.sab-pane{flex:1;min-height:0;display:flex}.sab-chathelp{font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}';
    var nameCss = '.sab-name-settings{margin-top:10px;font-size:13px}.sab-name-settings summary{cursor:pointer;width:fit-content}.sab-name-settings form{display:flex;flex-direction:column;gap:8px;max-width:550px;padding-top:8px}.sab-name-settings label{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sab-name-settings input{min-width:0;flex:1;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit}.sab-name-settings input:focus-visible{outline:2px solid #6366f1;outline-offset:2px}';
    var css = '.sab{height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#172033)}.sab *{box-sizing:border-box}.sab-shellhead,.sab-executions,.sab-native-notice{font:14px/1.5 system-ui,sans-serif}.sab-shellhead h1{margin:0 0 6px}.sab-sub,.sab-muted{color:var(--dsw-alias-label-secondary,#64748b)}.sab-shellhead button,.sab-executions button,.sab-native-notice button,.sab-native>.sab-notice button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);background:var(--dsw-alias-bg-base,#fff);border-radius:9px;min-height:36px;padding:7px 12px;cursor:pointer}.sab-shellhead button:focus-visible,.sab-executions button:focus-visible{outline:2px solid #6366f1;outline-offset:2px}.sab-notice{padding:13px 16px;border-radius:10px;background:rgba(99,102,241,.08)}.sab-error{background:rgba(239,68,68,.1)}';

    // Never display API errors or configuration objects. Authorized trace data is bounded and masked.
    function text(value, fallback, max) {
      if (typeof value !== 'string' && typeof value !== 'number') return fallback || '';
      return String(value).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[已隐藏]')
        .replace(/\b(token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[已隐藏]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[已隐藏]')
        .replace(/https?:\/\/[^\s]+/gi, '[链接已隐藏]').slice(0, max || 500);
    }
    function safeLink(value) {
      if (typeof value !== 'string') return null;
      try {
        var url = new URL(value);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
        // Query strings and fragments can contain access tokens; never put them in the DOM.
        url.search = ''; url.hash = '';
        return url;
      } catch (_) { return null; }
    }
    function prLink(threads) {
      if (!Array.isArray(threads)) return null;
      for (var i = 0; i < threads.length; i++) {
        var entry = threads[i];
        if (!entry || typeof entry !== 'object') continue;
        var link = githubPR(entry.url);
        if (link) return link;
      }
      return null;
    }
    function when(value) {
      var date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '时间未知';
    }
    function Icon(props) {
      return h('svg', {width:props.size || 16,height:props.size || 16,viewBox:'0 0 16 16',fill:'none',stroke:'currentColor',strokeWidth:'1.4',strokeLinecap:'round','aria-hidden':'true','data-dsh-panel-entry':PANEL},
        h('rect',{x:2,y:2,width:12,height:12,rx:2}), h('path',{d:'M6 4.5v7M10 4.5v7'}));
    }
    // Only canonical HTTPS github.com PR links become anchors. Everything else remains safe text.
    function githubPR(value) {
      var url = safeLink(value);
      if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)) return null;
      return 'https://github.com' + url.pathname.replace(/\/$/, '');
    }
    function sourceText(value) {
      var source = value.slice(0, 50000).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[已隐藏]')
        .replace(/\b(token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[已隐藏]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[已隐藏]');
      var parts = [], pattern = /\bhttps?:\/\/[^\s<>"']+/gi, match, offset = 0;
      while ((match = pattern.exec(source))) {
        parts.push(source.slice(offset, match.index));
        var candidate = match[0].replace(/[),.;:!?，。；：！？）\]}>]+$/, '');
        var link = githubPR(candidate);
        parts.push(link || '[链接已隐藏]');
        if (link) parts.push(match[0].slice(candidate.length));
        offset = pattern.lastIndex;
      }
      parts.push(source.slice(offset));
      if (value.length > 50000) parts.push('\n[消息过长，已截断显示]');
      return parts.join('');
    }
    // RC.1 compatibility shim: public slots lack per-session capability overrides.
    // These selectors are confined to real Source sessions, including catalog navigation.
    var SOURCE_PREFIX = 'superagent-source-', NATIVE_API = '/@superagent-board/api/native';
    var sourceScope = '[data-conversation-session^="'+SOURCE_PREFIX+'"]';
    // Version-pinned Windows history extension: these actions mutate local files/history or fork.
    // Scope only Source DOM; copy and any genuinely draft-only reuse action are not matched.
    var HISTORY_UNDO='button[aria-label="撤回"][title="整段回退：文件与对话一并回到该消息之前"]';
    var HISTORY_EDIT='button[aria-label="编辑"][title="编辑并重发：就地改完再发出去（新建会话，不动项目文件）"]';
    var HISTORY_ACTIONS=HISTORY_UNDO+','+HISTORY_EDIT;
    var nativeCss = sourceScope+' [data-slot="conversation.input.model"],'+sourceScope+' [data-slot="conversation.input.permission"],'+sourceScope+' [data-slot="conversation.input.plan"],'+sourceScope+' [data-slot="conversation.input.activity"],'+sourceScope+' [data-slot="conversation.input.left"],'+sourceScope+' [data-slot="conversation.input.right"],'+sourceScope+' [data-slot="conversation.input.overlay"],'+sourceScope+':not([data-superagent-attachments="true"]) [data-slot="conversation.input.attachments"],'+sourceScope+':not([data-superagent-attachments="true"]) [data-composer-card] button[aria-haspopup],'+sourceScope+' [data-composer-dock]{display:none!important}.sab-native,.sab-native-frame{flex:1;min-height:0;display:flex;flex-direction:column;width:100%}.sab-native-frame{flex-direction:row}.sab-native-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.sab-native [data-conversation-content]{flex:1;min-height:0}[data-superagent-native="true"] [data-slot="conversation.session.header"],[data-superagent-native="true"] [data-slot="conversation.session.header.actions"],[data-superagent-native="true"] [data-slot="conversation.session.header.utilities"],[data-superagent-native="true"] [data-slot="conversation.session.header.corner"]{display:none!important}.sab-native-notice{padding:8px 16px;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}.sab-source-node{padding:12px 0;overflow-wrap:anywhere}.sab-source-content>:first-child{font-size:inherit!important;line-height:inherit!important;color:inherit!important}.sab-source-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b);margin-bottom:6px}.sab-executions{padding:8px 16px;flex:none;max-height:40%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2,#ddd)}.sab-executions button:disabled{opacity:.5;cursor:not-allowed}.sab-executions [data-superagent-trace] pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}.sab-executions select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);padding:6px;max-width:100%}';
    nativeCss+=sourceScope+' '+HISTORY_UNDO+','+sourceScope+' '+HISTORY_EDIT+'{display:none!important}.sab-transport-status{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;color:var(--dsw-alias-label-secondary,#64748b);padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);border-radius:8px}.sab-transport-status p{margin:4px 0}.sab-transport-uncertain{background:rgba(245,158,11,.08)}.sab-source-quote{display:block;width:100%;margin:0 0 8px;padding:7px 10px 7px 12px;border:0;border-left:3px solid var(--dsw-alias-border-l3,#cbd5e1);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f6f8);font:inherit;font-size:12px;line-height:1.65;text-align:left;color:inherit;cursor:pointer;overflow-wrap:anywhere}.sab-source-quote:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}.sab-source-quote:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f46e5);outline-offset:2px}.sab-source-quote-label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,#94a3b8);margin-bottom:2px}.sab-source-quote-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-secondary,#64748b)}.sab-context-pane{width:min(400px,42%);flex:none;min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2,#dbe3ee);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#172033)}.sab-context-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#dbe3ee)}.sab-context-head h2{margin:0;font-size:15px}.sab-context-head p{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}.sab-context-head button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);background:var(--dsw-alias-bg-base,#fff);border-radius:9px;min-height:32px;padding:5px 11px;cursor:pointer;flex:none}.sab-context-list{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}.sab-context-row{border:1px solid transparent;border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-2,#f5f6f8)}.sab-context-row[data-current="true"]{border-color:var(--dsw-alias-brand-primary,#4f46e5);background:rgba(99,102,241,.08)}.sab-context-row .sab-quote-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b);margin-bottom:4px}.sab-quote-tag{font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(79,70,229,.12);color:var(--dsw-alias-brand-primary,#4f46e5)}.sab-quote-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6}.sab-context-compose{flex:none;border-top:1px solid var(--dsw-alias-border-l2,#dbe3ee);padding:12px 16px 16px;display:flex;flex-direction:column;gap:8px}.sab-context-label{font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}.sab-context-compose textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:72px;max-height:220px;font:inherit;font-size:14px;line-height:1.55;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:inherit}.sab-context-compose textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f46e5);outline-offset:2px}.sab-context-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}.sab-context-actions button{font:inherit;color:#fff;background:var(--dsw-alias-brand-primary,#4f46e5);border:1px solid transparent;border-radius:9px;min-height:34px;padding:6px 14px;cursor:pointer}.sab-context-actions button:disabled{opacity:.5;cursor:not-allowed}.sab-context-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8)}.sab-context-compose [role="status"],.sab-context-compose [role="alert"]{margin:0;font-size:12px}.sab-context-compose [role="alert"]{color:#dc2626}';
    function sourceSession(id) { return typeof id === 'string' && id.indexOf(SOURCE_PREFIX) === 0; }
    // Only Host native endpoints publish effective capabilities, never raw Source flags or upload receipts.
    var nativeCapabilities=new Map(), capabilityListeners=new Set(), NO_CAPABILITIES=Object.freeze({attachments:false});
    function effectiveCapabilities(id){return nativeCapabilities.get(id) || NO_CAPABILITIES;}
    function publishCapabilities(id,value){
      if(!sourceSession(id))return;
      var next=value && value.attachments===true ? {attachments:true} : NO_CAPABILITIES;
      if(effectiveCapabilities(id).attachments===next.attachments && nativeCapabilities.has(id))return;
      nativeCapabilities.set(id,next);capabilityListeners.forEach(function(listener){listener();});
    }
    function useNativeCapabilities(id){
      var subscribe=React.useCallback(function(listener){capabilityListeners.add(listener);return function(){capabilityListeners.delete(listener);};},[]);
      var snapshot=React.useCallback(function(){return effectiveCapabilities(id);},[id]);
      return React.useSyncExternalStore(subscribe,snapshot,snapshot);
    }
    function nativeRequest(path, method, body, signal) {
      return fetch(NATIVE_API+path,{method:method,credentials:'same-origin',cache:'no-store',headers:Object.assign({'x-superagent-board':'1'},body === undefined ? {} : {'Content-Type':'application/json'}),signal:signal,body:body === undefined ? undefined : JSON.stringify(body)})
        .then(function(response){ if(!response.ok){var err=new Error('HTTP');err.status=response.status;throw err;}return response.json().catch(function(){throw new Error('format');}); });
    }
    function sourceRecord(event) {
      if (!event || event.type !== 'superagent/source' || !event.data || event.data.customSource !== 'superagent' || event.data.conversationId !== 'main') return null;
      var record = event.data.event;
      if (!record || !Number.isSafeInteger(record.seq) || record.seq < 1 || typeof record.id !== 'string' || !record.id || (record.role !== 'assistant' && record.role !== 'user') || typeof record.text !== 'string' || (typeof record.at !== 'string' && typeof record.at !== 'number') || typeof record.kind !== 'string') return null;
      rememberSource(record);
      return record;
    }
    // Feishu-style quoted replies. The Source journal has no explicit reply field, but every
    // acknowledgement/reply id is the deterministic key of the Trigger it answers
    // (`key('ack', triggerId)` / `key('reply', triggerId, text)`), and the Trigger id is the id of
    // the user event already in the transcript. Recover the target locally; an unknown or rewritten
    // id simply renders the reply without a quote rather than guessing by position.
    var SOURCE_K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function rotateRight(value,bits){return (value>>>bits)|(value<<(32-bits));}
    function utf8Bytes(value){
      var text=String(value),bytes=[];
      for(var i=0;i<text.length;i++){
        var code=text.charCodeAt(i);
        if(code<0x80)bytes.push(code);
        else if(code<0x800)bytes.push(0xc0|code>>6,0x80|code&63);
        else if(code>=0xd800 && code<=0xdbff && i+1<text.length){var point=0x10000+((code-0xd800)<<10)+(text.charCodeAt(++i)-0xdc00);bytes.push(0xf0|point>>18,0x80|point>>12&63,0x80|point>>6&63,0x80|point&63);}
        else bytes.push(0xe0|code>>12,0x80|code>>6&63,0x80|code&63);
      }
      return bytes;
    }
    function sha256(value){
      var bytes=utf8Bytes(value),bits=bytes.length*8;
      bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);
      // 64-bit big-endian length: the high 32 bits stay zero for every id-sized input.
      bytes.push(0,0,0,0,(bits>>>24)&255,(bits>>>16)&255,(bits>>>8)&255,bits&255);
      var state=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
      for(var offset=0;offset<bytes.length;offset+=64){
        var words=[],t;
        for(t=0;t<16;t++)words[t]=(bytes[offset+t*4]<<24)|(bytes[offset+t*4+1]<<16)|(bytes[offset+t*4+2]<<8)|bytes[offset+t*4+3];
        for(t=16;t<64;t++)words[t]=(words[t-16]+(rotateRight(words[t-15],7)^rotateRight(words[t-15],18)^(words[t-15]>>>3))+words[t-7]+(rotateRight(words[t-2],17)^rotateRight(words[t-2],19)^(words[t-2]>>>10)))|0;
        var a=state[0],b=state[1],c=state[2],d=state[3],e=state[4],f=state[5],g=state[6],h2=state[7];
        for(t=0;t<64;t++){
          var select=(e&f)^(~e&g),majority=(a&b)^(a&c)^(b&c);
          var first=(h2+(rotateRight(e,6)^rotateRight(e,11)^rotateRight(e,25))+select+SOURCE_K[t]+words[t])|0;
          var second=((rotateRight(a,2)^rotateRight(a,13)^rotateRight(a,22))+majority)|0;
          h2=g;g=f;f=e;e=(d+first)|0;d=c;c=b;b=a;a=(first+second)|0;
        }
        state[0]=(state[0]+a)|0;state[1]=(state[1]+b)|0;state[2]=(state[2]+c)|0;state[3]=(state[3]+d)|0;
        state[4]=(state[4]+e)|0;state[5]=(state[5]+f)|0;state[6]=(state[6]+g)|0;state[7]=(state[7]+h2)|0;
      }
      return state.map(function(word){return ('00000000'+(word>>>0).toString(16)).slice(-8);}).join('');
    }
    function outboxKey(values){return sha256(JSON.stringify(values)).slice(0,32);}
    var sourceUsers=new Map(),sourceAssistants=new Map(),replyTargets=new Map(),ticketTargets=new Map();
    function rememberSource(entry){
      if(entry.role==='user'){
        if(sourceUsers.has(entry.id))return;
        sourceUsers.set(entry.id,entry);replyTargets.clear();
        if(sourceUsers.size>1000)sourceUsers.delete(sourceUsers.keys().next().value);
      }else if(entry.role==='assistant'&&!sourceAssistants.has(entry.id)){
        sourceAssistants.set(entry.id,entry);
        if(sourceAssistants.size>1000)sourceAssistants.delete(sourceAssistants.keys().next().value);
      }
    }
    function directReplyTarget(entry){
      if(replyTargets.has(entry.id))return replyTargets.get(entry.id);
      var users=Array.from(sourceUsers.values()),target=null;
      // Newest first: an answer normally responds to a recent message.
      for(var i=users.length-1;i>=0&&!target;i--){
        if(entry.id===outboxKey(['ack',users[i].id])||entry.id===outboxKey(['reply',users[i].id,entry.text]))target=users[i];
      }
      replyTargets.set(entry.id,target);return target;
    }
    function replyTarget(entry){
      if(entry.role!=='assistant'||typeof entry.id!=='string'||typeof entry.text!=='string')return null;
      var target=directReplyTarget(entry);
      if(target){if(entry.ticketId&&!ticketTargets.has(entry.ticketId))ticketTargets.set(entry.ticketId,target);return target;}
      // A ticket-level result (`key('reply', ticketId, text)`) names no human message directly.
      // Quote the message a sibling answer of the same ticket already resolved; never guess by position.
      if(!entry.ticketId)return null;
      if(ticketTargets.has(entry.ticketId))return ticketTargets.get(entry.ticketId);
      var siblings=Array.from(sourceAssistants.values());
      for(var i=0;i<siblings.length;i++){
        var sibling=siblings[i];
        if(sibling.id===entry.id||sibling.ticketId!==entry.ticketId)continue;
        var quoted=directReplyTarget(sibling);
        if(quoted){ticketTargets.set(entry.ticketId,quoted);return quoted;}
      }
      return null;
    }
    function quoteText(value,max){
      var text=String(value??'').replace(/\s+/g,' ').trim(),limit=max||220;
      return (text.length>limit?text.slice(0,limit)+'…':text) || '（无文字的消息）';
    }
    var SOURCE_KIND_LABELS={ack:'已接收',acknowledgement:'已接收',answer:'答复',reply:'答复',attention:'需要关注',result:'执行结果',notice:'通知',delivery:'Source 消息'};
    function sourceKind(entry){return SOURCE_KIND_LABELS[entry.kind] || text(entry.kind,'Source 消息',60);}
    // A focused topic view: the quoted message, its immediate confirmed neighbours and the
    // reply that opened the view. Built only from already-loaded Source history; read-only.
    function contextRows(target,origin){
      var rows=Array.from(sourceUsers.values()).concat(Array.from(sourceAssistants.values()));
      rows.sort(function(a,b){return (a.seq||0)-(b.seq||0);});
      var index=-1;
      for(var i=0;i<rows.length;i++)if(rows[i].id===target.id&&rows[i].role===target.role){index=i;break;}
      var window=index<0?[target]:rows.slice(Math.max(0,index-3),index+4);
      if(origin&&origin.id!==target.id&&!window.some(function(item){return item.id===origin.id;}))window=window.concat([origin]);
      window.sort(function(a,b){return (a.seq||0)-(b.seq||0);});
      return window.map(function(item){return {entry:item,current:item.id===target.id&&item.role===target.role,reply:!!origin&&item.id===origin.id};});
    }
    // The focused context lives beside the native conversation, not over it, so the operator can
    // read the quoted message and send a reply scoped to the same context from that pane.
    var focusedContext={target:null,origin:null},contextListeners=new Set();
    function publishFocus(value){focusedContext=value;contextListeners.forEach(function(listener){listener();});}
    function focusContext(target,origin){if(target)publishFocus({target:target,origin:origin});}
    function closeContext(){publishFocus({target:null,origin:null});}
    function useContextFocus(){
      var subscribe=React.useCallback(function(listener){contextListeners.add(listener);return function(){contextListeners.delete(listener);};},[]);
      var snapshot=React.useCallback(function(){return focusedContext;},[]);
      return React.useSyncExternalStore(subscribe,snapshot,snapshot);
    }
    function ContextPane(props){
      var target=props.target,origin=props.origin,rows=contextRows(target,origin);
      var currentRow=React.useRef(null);
      React.useEffect(function(){if(currentRow.current&&currentRow.current.scrollIntoView)currentRow.current.scrollIntoView({block:'center'});},[target.id,target.role]);
      var draft=React.useState(''),text=draft[0],setText=draft[1];
      var status=React.useState(''),notice=status[0],setNotice=status[1];
      var errors=React.useState(''),error=errors[0],setError=errors[1];
      function send(){
        var value=text.trim();
        if(!value)return;
        var input=props.context&&typeof props.sessionId==='string'?sourceInput(props.context,props.sessionId):null;
        if(!input){setError('原生会话尚未就绪，草稿保留。');return;}
        // Prefix the confirmed quote explicitly: the Source relay carries text, so the WSL
        // SuperAgent receives the context with the message instead of an unattached draft quote.
        input.setDraft('> '+String(target.text??'').replace(/\n/g,'\n> ')+'\n\n'+value);
        input.submit('queue','click');
        setText('');setNotice('已发送，只针对这段上下文。');setError('');
      }
      return h('aside',{className:'sab-context-pane','aria-label':'消息上下文'},
        h('header',{className:'sab-context-head'},h('div',null,h('h2',null,'消息上下文'),h('p',null,'这条消息及其前后的已确认内容；在下面发送只针对这段上下文。')),
          h('button',{type:'button','aria-label':'关闭消息上下文',onClick:props.onClose},'关闭')),
        h('div',{className:'sab-context-list'},rows.map(function(row){
          return h('article',{key:row.entry.role+':'+row.entry.id+':'+row.entry.seq,className:'sab-context-row','data-superagent-context-row':true,'data-current':row.current?'true':undefined,'data-reply':row.reply?'true':undefined,ref:row.current?currentRow:undefined},
            h('div',{className:'sab-quote-meta'},h('strong',null,row.entry.role==='user'?'你':agentName()),h('span',null,sourceKind(row.entry)),h('span',null,when(row.entry.at)),
              row.current&&h('span',{className:'sab-quote-tag'},'当前消息'),row.reply&&h('span',{className:'sab-quote-tag'},'正在查看')),
            h('div',{className:'sab-quote-body'},String(row.entry.text??'').slice(0,8000)||'（无文字的消息）'));
        })),
        h('div',{className:'sab-context-compose'},
          h('label',{className:'sab-context-label',htmlFor:'sab-context-input'},'只回复这段上下文'),
          h('textarea',{id:'sab-context-input','aria-label':'只回复这段上下文',rows:3,value:text,placeholder:'输入消息，Enter 发送，Shift+Enter 换行',onChange:function(event){setText(event.target.value);setNotice('');setError('');},onKeyDown:function(event){if(event.key==='Enter'&&!event.shiftKey&&!(event.nativeEvent&&event.nativeEvent.isComposing)&&event.keyCode!==229){event.preventDefault();send();}}}),
          h('div',{className:'sab-context-actions'},h('button',{type:'button',disabled:!text.trim(),onClick:send},'发送'),h('span',{className:'sab-context-hint'},'发送时会带上这条消息的引用。')),
          notice&&h('p',{role:'status'},notice),error&&h('p',{role:'alert'},error)));
    }
    function SourceNode(props) {
      useIdentity();
      var entry=props.node.data, quote=replyTarget(entry);
      return h('section',{className:'sab-source-node','data-superagent-source':entry.id},
        h('div',{className:'sab-source-meta'},h('strong',null,agentName()),h('span',null,sourceKind(entry)),h('span',null,when(entry.at)),entry.ticketId && h('code',null,text(entry.ticketId,'',128))),
        quote && h('button',{type:'button',className:'sab-source-quote','data-superagent-reply-to':quote.id,title:'在右侧查看这条消息的上下文',onClick:function(){focusContext(quote,entry);}},
          h('span',{className:'sab-source-quote-label'},h('span',null,'回复你的消息'),h('span',null,when(quote.at))),
          h('span',{className:'sab-source-quote-text'},quoteText(quote.text))),
        // The public text-only Factory is compact by default; Source deliveries are not model reasoning.
        h('div',{className:'sab-source-content','data-superagent-delivery-content':true,style:{fontSize:'var(--dsh-content-font-size,14px)',lineHeight:'calc(24px + var(--dsh-content-font-delta,0px))',color:'var(--dsw-alias-label-primary,#172033)'}},
          props.renderFactorySlot('conversation.chat.reasoning.content',{text:sourceText(entry.text),running:false})));
    }
    var TRANSPORT_CODES=['transport-error','needs-selection','control-pending','unsupported-control','invalid-ack','invalid-snapshot','invalid-source-event','request-id-conflict','source-history-conflict','source-history-gap','source-history-budget','relay-disposed','outbox-corrupt','outbox-required','outbox-not-synchronous','unsupported-input','invalid-request-id','empty-input'];
    function relayOwner(event){return event && event.type==='superagent/relay' && event.data && event.data.customSource==='superagent' && event.data.conversationId==='main';}
    function validTransportRequest(value){return typeof value==='string' && /^[a-f0-9]{64}$/.test(value);}
    function transportRecord(event){
      var source=sourceRecord(event);
      if(source && source.role==='user' && validTransportRequest(source.requestId))return {operation:'submit',outcome:'accepted',requestId:source.requestId};
      if(!relayOwner(event))return null;
      var data=event.data;
      if(!['submit','snapshot','interrupt','resume','restore-local-attachments','error','open'].includes(data.operation) || !['queued','unknown','accepted','acknowledged','unavailable','source-backed'].includes(data.outcome))return null;
      return {operation:data.operation,outcome:data.outcome,
        requestId:validTransportRequest(data.requestId)?data.requestId:undefined,
        ticketId:typeof data.ticketId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.ticketId)?data.ticketId:undefined,
        code:TRANSPORT_CODES.includes(data.code)?data.code:undefined};
    }
    function transportIdentity(record){return record.requestId?'request:'+record.requestId:'operation:'+record.operation+(record.ticketId?':'+record.ticketId:'');}
    function transportState(previous,match){
      var record=transportRecord(match.event);
      if(!record)return previous || {record:null,seq:match.event.seq,location:match.location};
      // A genuine Source receipt cannot be downgraded by a later local recovery/timeout marker.
      if(previous && previous.record){
        var old=previous.record;
        if(old.requestId && old.outcome==='accepted' && record.outcome!=='accepted')return previous;
        if(old.operation===record.operation && old.outcome===record.outcome && old.requestId===record.requestId && old.ticketId===record.ticketId && old.code===record.code)return previous;
      }
      return {record:record,seq:match.event.seq,location:match.location};
    }
    function SourceTransportNode(props){
      var entry=props.node.data, message='', uncertain=entry.outcome==='unknown' || entry.outcome==='unavailable';
      if(entry.requestId){
        message=entry.outcome==='accepted'?'Source 已确认接收；不代表任务完成。':entry.outcome==='queued'?'请求已保存在本机队列；尚未确认 Source 接收。':'本机已保存，但 Source 是否接收尚未确认。不会自动重发，请核对 Source 回执；不能视为已发送或任务完成。';
      }else if(entry.outcome==='unavailable'){
        message=entry.operation==='snapshot'?'最近一次 Source 状态读取异常；已有消息保留，未确认请求不会自动重发。':entry.operation==='submit'?'最近一次 Source 提交通讯异常，接收结果未确认；本机已记录的未确认请求不会自动重发。':'Source 控制或传输结果未确认；以真实 Source 回执和执行状态为准，不会自动重发或终结工单。';
      }else if(entry.outcome==='unknown' || entry.outcome==='queued')message='Source 传输或控制结果尚未确认；本机已记录的未确认请求不会自动重发，请以真实回执和执行状态为准。';
      else if(entry.operation==='interrupt' && entry.outcome==='acknowledged')message='Source 已确认收到中断请求；等待真实停止确认，工单不会终结。';
      else if(entry.operation==='resume' && entry.outcome==='acknowledged')message='Source 已确认收到继续请求；以真实执行状态为准，不代表任务完成。';
      else message='Source 传输状态已更新；以真实回执为准，不代表任务完成。';
      return h('section',{className:'sab-transport-status'+(uncertain?' sab-transport-uncertain':''),role:entry.outcome==='unavailable'?'alert':'status','aria-label':'Source 传输状态','data-superagent-transport':true,'data-superagent-request':entry.requestId || undefined},
        h('span',null,'Source 传输状态'),h('p',null,message),
        entry.requestId && h('code',null,'请求 '+entry.requestId.slice(0,12)+'…'),entry.code && h('code',null,' · '+entry.code));
    }
    function sourceInput(ctx, id) {
      var scope=ctx.sessions.scope(id);
      return scope ? ctx.conversation.input.for(scope) : null;
    }
    function unsupportedInput(input, attachments) {
      if (!input) return '原生会话尚未就绪，草稿保留。';
      if (input.claim || /^\s*\//.test(input.draft)) return 'SuperAgent 不支持本地斜杠命令、模型、权限、Plan 或 Goal 操作；草稿保留。';
      if (!attachments && input.attachmentIds.length) return 'SuperAgent 当前有效能力未启用原生附件；已有附件和文本草稿保留。';
      if (input.occurrences.length || /^\s*@/.test(input.draft)) return 'SuperAgent 不支持本机 @ 引用解析；草稿保留，可转换为普通文本。';
      return '';
    }
    function SourceGuard(props) {
      return h('section',{className:'sab-native-notice',role:'alert'},props.matched,
        h('p',null,'仅支持真实 Source 消息及本会话已启用的附件。不会调用本机普通 Agent 或修改全局设置。'),
        h('button',{type:'button',onClick:function(){
          var input=sourceInput(props.context,props.sessionId);
          if(!input)return;
          var snapshot=input.state.getSnapshot();
          input.pruneAttachments([]);
          input.setDraft('消息：\n'+snapshot.draft);
        }},'移除附件/引用并保留为普通文本'));
    }
    function SourceCapabilities(props) {
      var capabilities=useNativeCapabilities(props.sessionId), element=React.useRef(null);
      React.useEffect(function(){
        if(!sourceSession(props.sessionId) || !element.current)return;
        var root=element.current.closest('[data-conversation-session]');
        if(!root)return;
        root.setAttribute('data-superagent-attachments',capabilities.attachments?'true':'false');
        var panel=root.closest('[data-slot="main.conversation"]');
        if(panel)panel.setAttribute('data-superagent-native','true');
        // RC.1 also uses a global busyEnter label. Only this Source primary is relabelled;
        // the native editor, queue machine and user preference remain untouched.
        var plusOriginals=new Map();
        function labelQueue() {
          root.querySelectorAll(HISTORY_ACTIONS).forEach(function(action){if(!action.hidden)action.hidden=true;});
          var input=sourceInput(props.context,props.sessionId), button=root.querySelector('[data-composer-card] button[aria-busy]');
          if(!input || !button || button.getAttribute('aria-busy')==='true')return;
          var state=input.state.getSnapshot();
          if(state.phase==='plain' && (state.draft.trim() || state.attachmentIds.length) && button.getAttribute('aria-label')!=='发送（排队）')button.setAttribute('aria-label','发送（排队）');
          var plus=root.querySelector('[data-composer-card] button[aria-haspopup]');
          if(capabilities.attachments && plus){
            if(!plusOriginals.has(plus))plusOriginals.set(plus,{'aria-label':plus.getAttribute('aria-label'),'aria-haspopup':plus.getAttribute('aria-haspopup'),'aria-expanded':plus.getAttribute('aria-expanded')});
            if(plus.getAttribute('aria-label')!=='添加文件或图片')plus.setAttribute('aria-label','添加文件或图片');
            if(plus.getAttribute('aria-haspopup')!=='dialog')plus.setAttribute('aria-haspopup','dialog');
            if(plus.getAttribute('aria-expanded')!==null)plus.removeAttribute('aria-expanded');
          }
        }
        labelQueue();
        var observer=new MutationObserver(labelQueue);
        observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','aria-busy','aria-haspopup','aria-expanded','title']});
        var composing=false, composingUntil=0; // Match RC.1's native IME grace window.
        function capture(event) {
          if(event.type === 'compositionstart'){composing=true;return;}
          if(event.type === 'compositionend'){composing=false;composingUntil=Date.now()+10;return;}
          if(event.defaultPrevented)return;
          var history=event.target && event.target.closest && event.target.closest(HISTORY_ACTIONS);
          if(history && (['click','mousedown','pointerdown'].includes(event.type) || event.type==='keydown' && (event.key==='Enter' || event.key===' '))){
            event.preventDefault();event.stopPropagation();
            var ownerInput=sourceInput(props.context,props.sessionId);
            if(ownerInput)ownerInput.notify('error','Source 会话不支持本机整段回退或编辑并重发（新建会话）；消息与工单保持不变。');
            return;
          }
          var input=sourceInput(props.context,props.sessionId);
          if(!input)return;
          var state=input.state.getSnapshot(), target=event.target;
          var editable=target && target.closest && target.closest('[contenteditable="true"]');
          var primary=target && target.closest && target.closest('[data-composer-card] button[aria-busy]');
          var files=event.clipboardData || event.dataTransfer;
          function refuse(message){event.preventDefault();event.stopPropagation();input.notify('error',message);}
          var attachments=effectiveCapabilities(props.sessionId).attachments;
          var plus=target && target.closest && target.closest('[data-composer-card] button[aria-haspopup]');
          if(event.type==='click' && plus && plus===root.querySelector('[data-composer-card] button[aria-haspopup]')){
            if(!attachments){refuse('SuperAgent 当前未启用原生附件；草稿保留。');return;}
            // RC.1 Plus is a global command launcher. Reuse its mounted native file input instead.
            event.preventDefault();event.stopPropagation();
            var picker=root.querySelector('[data-composer-card] input[type="file"]');
            if(picker && !picker.disabled && !plus.disabled)picker.click();
            return;
          }
          if (!attachments && (event.type === 'paste' || event.type === 'drop' || event.type === 'dragover') && files && (files.files && files.files.length || files.items && Array.from(files.items).some(function(item){return item.kind === 'file';}) || files.types && Array.from(files.types).includes('Files'))) {
            refuse('SuperAgent 当前有效能力未启用原生附件，不接受文件；文本和已有附件草稿保留。');return;
          }
          if(event.type === 'keydown' && editable && (event.ctrlKey || event.metaKey) && !['a','c','v','x','y','z','arrowleft','arrowright','backspace','delete','home','end','enter'].includes(String(event.key).toLowerCase())) {refuse('SuperAgent 不支持本地全局命令或设置快捷键；文本草稿保留。');return;}
          var enter=event.type === 'keydown' && editable && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode !== 229 && !composing && Date.now()>=composingUntil;
          var submit=event.type === 'submit' || event.type === 'click' && primary;
          if(!enter && !submit)return;
          var reason=unsupportedInput(state,attachments);
          if(reason){refuse(reason);return;}
          if(enter && (event.ctrlKey || event.metaKey)) {refuse('SuperAgent 不支持 Steer；请使用 Enter 或发送按钮排队，草稿保留。');return;}
          if((!state.draft.trim() && state.attachmentIds.length===0) || state.phase !== 'plain')return; // Empty native Stop still uses Controller.cancel.
          var nativePrimary=root.querySelector('[data-composer-card] button[aria-busy]');
          if(!nativePrimary || nativePrimary.disabled)return; // Preserve the native pending/failed-upload gate and its feedback.
          event.preventDefault();event.stopPropagation();
          if(!event.repeat)input.submit('queue',enter?'enter':'click'); // Native input machine, never a second REST send.
        }
        var types=['compositionstart','compositionend','keydown','pointerdown','mousedown','click','submit','paste','drop','dragover'];
        types.forEach(function(type){root.addEventListener(type,capture,true);});
        return function(){
          observer.disconnect();types.forEach(function(type){root.removeEventListener(type,capture,true);});
          plusOriginals.forEach(function(original,plus){
            Object.keys(original).forEach(function(name){
              var current=plus.getAttribute(name), owned=name==='aria-label'?'添加文件或图片':name==='aria-haspopup'?'dialog':null;
              if(current!==owned)return;
              if(original[name]==null)plus.removeAttribute(name);else plus.setAttribute(name,original[name]);
            });
          });
          root.removeAttribute('data-superagent-attachments');if(panel)panel.removeAttribute('data-superagent-native');
        };
      },[props.context,props.sessionId,capabilities.attachments]);
      React.useEffect(function(){
        if(!sourceSession(props.sessionId))return;
        // Catalog-opened Source sessions have no create response; refresh their effective Host capability too.
        var alive=true, pending=null;
        function refresh(){
          if(pending)return;
          var controller=new AbortController();pending=controller;
          var timeout=setTimeout(function(){controller.abort();},15000);
          nativeRequest('/conversations/main/events','GET',undefined,controller.signal).then(function(body){
            if(!body || body.version!==1 || body.conversationId!=='main' || !body.capabilities)throw new Error('format');
            if(alive)publishCapabilities(props.sessionId,body.capabilities);
          }).catch(function(){if(alive)publishCapabilities(props.sessionId,null);}).finally(function(){clearTimeout(timeout);if(pending===controller)pending=null;});
        }
        if(!nativeCapabilities.has(props.sessionId))refresh();
        var timer=setInterval(function(){if(!document.hidden)refresh();},15000);
        return function(){alive=false;clearInterval(timer);if(pending)pending.abort();};
      },[props.sessionId]);
      if(!sourceSession(props.sessionId))return null;
      return h('div',{ref:element,className:'sab-native-notice'},h('style',null,nativeCss+sourceScope+' [data-slot="conversation.input.dock"] button[aria-label='+JSON.stringify(props.t('queue.steer'))+']{display:none!important}'),
        '真实 WSL SuperAgent · 仅排队 · '+(capabilities.attachments?'原生图片/文件已启用':'原生附件当前不可用')+' · Stop 中断当前执行并保留工单。模型/权限/Plan/Goal/本地命令暂不可用；Source 回执不代表执行完成。 ',
        h('span',null,'RC.1 兼容层按本会话有效能力裁剪；附件仍由原生上传和输入队列处理。 '),
        h('button',{type:'button',onClick:function(){props.context.layout.selectPanel(PANEL);}},'选择执行任务'));
    }
    function executionRow(row) {
      return row && typeof row.ticketId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.ticketId) &&
        (row.assignmentId === undefined || typeof row.assignmentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.assignmentId)) &&
        Number.isSafeInteger(row.controlSeq) && row.controlSeq >= 0 && ['pending','running','paused','ended'].includes(row.state) &&
        row.actions && typeof row.actions.interrupt === 'boolean' && typeof row.actions.resume === 'boolean';
    }
    function executionLabel(row) {
      if(row.interruption === 'requested')return '正在确认中断';
      if(row.interruption === 'failed')return '停止确认失败';
      if(row.state === 'paused')return row.interruption === 'settled' ? '已中断（工单保留）' : '等待停止确认';
      return {running:row.activity === 'running' || row.activity === 'preparing' ? '执行中' : '等待执行',pending:'等待执行',ended:'执行结束'}[row.state] || '状态未知';
    }
    function Trace(props) {
      var content=React.useState(null), page=content[0], setPage=content[1];
      var errors=React.useState(''), error=errors[0], setError=errors[1];
      var active=React.useState(false), busy=active[0], setBusy=active[1];
      var request=React.useRef(null), alive=React.useRef(false);
      React.useEffect(function(){alive.current=true;return function(){alive.current=false;if(request.current)request.current.abort();};},[]);
      function readPage(older) {
        if(request.current)return;
        var cursor=older && page && page.nextCursor;
        if(older && !cursor)return;
        var query='?limit=50'+(cursor?'&throughSeq='+cursor.throughSeq+'&beforeSeq='+cursor.beforeSeq:'');
        var controller=new AbortController();request.current=controller;setBusy(true);setError('');
        var timeout=setTimeout(function(){controller.abort();},15000);
        nativeRequest('/conversations/main/executions/'+encodeURIComponent(props.row.ticketId)+query,'GET',undefined,controller.signal).then(function(body){
          if(!body || body.ticketId !== props.row.ticketId || !['available','missing','unsupported','not-read'].includes(body.history) || !Array.isArray(body.records) || body.records.length>100 || body.records.some(function(record){return !record || !Number.isSafeInteger(record.seq) || record.seq<1 || !record.event || typeof record.event.type !== 'string' || record.event.type.length>128 || (typeof record.time !== 'number' && typeof record.time !== 'string');}) || typeof body.hasMore !== 'boolean' || typeof body.truncated !== 'boolean')throw new Error('format');
          if(body.hasMore && (!body.nextCursor || !Number.isSafeInteger(body.nextCursor.throughSeq) || !Number.isSafeInteger(body.nextCursor.beforeSeq) || body.nextCursor.beforeSeq<1 || body.nextCursor.beforeSeq>body.nextCursor.throughSeq || cursor && (body.nextCursor.throughSeq !== cursor.throughSeq || body.nextCursor.beforeSeq>=cursor.beforeSeq)))throw new Error('format');
          if(!alive.current)return;
          setPage(function(previous){
            var rows=older && previous ? previous.records.concat(body.records) : body.records;
            rows=rows.filter(function(record,index){return rows.findIndex(function(other){return other.seq===record.seq;})===index;}).sort(function(a,b){return a.seq-b.seq;});
            return {ticketId:body.ticketId,assignmentId:body.assignmentId,history:body.history,records:rows.slice(-500),bounded:rows.length>500,truncated:body.truncated || !!(older && previous && previous.truncated),hasMore:body.hasMore,nextCursor:body.nextCursor};
          });
        }).catch(function(){if(alive.current)setError('真实执行记录读取失败；已有记录保留，不会补造工具或模型过程。');})
          .finally(function(){clearTimeout(timeout);if(request.current===controller)request.current=null;if(alive.current)setBusy(false);});
      }
      return h('div',{'data-superagent-trace':props.row.ticketId},
        h('button',{type:'button',disabled:busy,onClick:function(){readPage(false);}},'读取所选真实记录'),
        busy && h('span',{role:'status'},' 正在冷读 WSL 执行记录…'),
        error && h('p',{role:'alert'},error),
        page && h('details',{open:true},h('summary',null,'WSL 原始执行记录 · '+text(page.ticketId,'',128)),
          h('p',null,'独立冷读，不启动或恢复 Worker；这里不是 Source 回执，也不是模拟的模型流。'),
          page.assignmentId && h('p',null,'实际 assignment：',text(page.assignmentId,'',128)),
          page.history !== 'available' && h('p',null,{missing:'真实历史不存在',unsupported:'当前版本不支持读取真实历史','not-read':'尚未读取历史'}[page.history]),
          (page.truncated || page.bounded) && h('p',null,'记录已按安全上限截断；此处不是完整执行历史。'),
          h('ol',null,page.records.map(function(record){return h('li',{key:record.seq},h('code',null,'#'+record.seq+' '+text(record.event.type,'未知记录',128)),h('time',null,' · '+when(record.time)),h('pre',null,text(JSON.stringify(record.event.data), '无记录正文',4000)));})),
          page.hasMore && !page.bounded && h('button',{type:'button',disabled:busy,onClick:function(){readPage(true);}},'读取更早记录')));
    }
    function Executions(props) {
      var state=React.useState({executions:[],capabilities:{},available:false}), snapshot=state[0], setSnapshot=state[1];
      var chosen=React.useState(null), selected=chosen[0], setSelected=chosen[1];
      var status=React.useState(''), notice=status[0], setNotice=status[1];
      var errors=React.useState(''), error=errors[0], setError=errors[1];
      var active=React.useState(false), busy=active[0], setBusy=active[1];
      var alive=React.useRef(false), request=React.useRef(null), controlRequest=React.useRef(null), selection=React.useRef(null), current=React.useRef(snapshot);
      function choose(row) {selection.current=row;setSelected(row);}
      var refresh=React.useCallback(function(){
        if(request.current)return;
        var controller=new AbortController();request.current=controller;
        var timeout=setTimeout(function(){controller.abort();},15000);
        nativeRequest('/conversations/main/events','GET',undefined,controller.signal).then(function(body){
          if(!body || body.version !== 1 || body.conversationId !== 'main' || !Array.isArray(body.executions) || body.executions.length > 100 || body.executions.some(function(row){return !executionRow(row);}) || new Set(body.executions.map(function(row){return row.ticketId;})).size !== body.executions.length || !body.capabilities)throw new Error('format');
          if(!alive.current)return;
          publishCapabilities(props.sessionId,body.capabilities);
          var next={executions:body.executions,capabilities:body.capabilities,available:true,executionsTruncated:body.executionsTruncated===true,executionCount:Number.isSafeInteger(body.executionCount)?body.executionCount:body.executions.length};current.current=next;setSnapshot(next);setError('');
          var picked=selection.current;
          if(picked && !body.executions.some(function(row){return row.ticketId === picked.ticketId && row.assignmentId === picked.assignmentId && row.controlSeq === picked.controlSeq;})){
            choose(null);setNotice('执行代次或控制序号已变化，请重新选择任务。');
          }
        }).catch(function(){if(alive.current){publishCapabilities(props.sessionId,null);current.current=Object.assign({},current.current,{available:false});setSnapshot(current.current);setError('执行状态读取失败；已有状态保留，控制已禁用，请刷新重试。');}})
          .finally(function(){clearTimeout(timeout);if(request.current===controller)request.current=null;});
      },[]);
      React.useEffect(function(){
        alive.current=true;refresh();
        var timer=setInterval(function(){if(!document.hidden)refresh();},5000);
        function visible(){if(!document.hidden)refresh();}
        document.addEventListener('visibilitychange',visible);
        return function(){alive.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);if(request.current)request.current.abort();if(controlRequest.current)controlRequest.current.abort();};
      },[refresh]);
      function allowed(row, operation) {
        var snap=current.current;
        row=row && snap.executions.find(function(latest){return latest.ticketId === row.ticketId && latest.assignmentId === row.assignmentId && latest.controlSeq === row.controlSeq;});
        return snap.available && row && row.assignmentId && snap.capabilities[operation] === true && row.actions[operation] === true &&
          (operation === 'interrupt' ? row.state === 'running' && ['running','preparing'].includes(row.activity) : row.state === 'paused' && row.interruption === 'settled');
      }
      function control(operation) {
        var row=selection.current;
        if(controlRequest.current || !allowed(row,operation))return;
        var controller=new AbortController();controlRequest.current=controller;setBusy(true);setError('');setNotice('');
        var timeout=setTimeout(function(){controller.abort();},20000);
        nativeRequest('/conversations/main/executions/'+encodeURIComponent(row.ticketId)+'/'+operation,'POST',{expectedAssignmentId:row.assignmentId,expectedControlSeq:row.controlSeq},controller.signal)
          .then(function(body){
            if(!body || body.ticketId !== row.ticketId || !Number.isSafeInteger(body.controlSeq))throw new Error('format');
            if(!alive.current)return;
            choose(null);setNotice(operation === 'interrupt'?'正在确认中断；仅收到执行停止确认后才可继续，工单不会终结。':'继续请求已提交；等待真实执行状态。');refresh();
          }).catch(function(err){
            if(!alive.current)return;
            choose(null);current.current=Object.assign({},current.current,{available:false});setSnapshot(current.current);
            setError(err && err.status === 409 ? '任务执行已变化或中断尚未确认。请刷新状态并重新选择，不会自动重试。' : '操作结果未确认。请刷新状态后再决定；不会自动重试或终结工单。');
          }).finally(function(){clearTimeout(timeout);if(controlRequest.current===controller)controlRequest.current=null;if(alive.current)setBusy(false);});
      }
      return h('section',{className:'sab-executions','aria-label':'真实 Source 执行控制'},
        h('div',null,h('span',null,'Source 执行'),' ',h('button',{type:'button',onClick:refresh},'刷新执行状态')),
        h('p',null,'Stop 只中断当前执行并保留工单；多个任务必须明确选择，不会猜测最后一个任务。'),
        snapshot.executionsTruncated && h('p',{role:'status'},'执行摘要已完整读取；仅显示活跃优先的前 100 项，共 '+snapshot.executionCount+' 项。未展示不代表已结束。'),
        h('label',null,'所选工单 ',h('select',{'aria-label':'选择 Source 工单执行',value:selected ? selected.ticketId : '',disabled:busy,onChange:function(event){var row=current.current.executions.find(function(item){return item.ticketId===event.target.value;});choose(row || null);setNotice('');}},
          h('option',{value:''},'请选择任务（不自动选择）'),snapshot.executions.map(function(row){return h('option',{key:row.ticketId,value:row.ticketId},row.ticketId+' · '+executionLabel(row));}))),
        ' ',h('button',{type:'button',disabled:busy || !allowed(selected,'interrupt'),onClick:function(){control('interrupt');}},'中断所选执行'),
        ' ',h('button',{type:'button',disabled:busy || !allowed(selected,'resume'),onClick:function(){control('resume');}},'继续所选工单'),
        selected && snapshot.available && snapshot.capabilities.executionRecords === true && h(Trace,{key:selected.ticketId+':'+selected.assignmentId,row:selected}),
        snapshot.executions.length === 0 && h('p',null,'暂无可读取的真实工单执行。'),
        snapshot.capabilities.interrupt !== true && h('p',null,'Source 执行控制尚不可用；不会用终结工单代替中断。'),
        notice && h('p',{role:'status'},notice),error && h('p',{role:'alert'},error));
    }
    function nativeBody(props) {
      var focus=useContextFocus();
      return h('div',{className:'sab-native-frame'},
        h('div',{className:'sab-native-main'},
          props.renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false},{fallback:h('div',{role:'alert',className:'sab-notice sab-error'},'原生 Conversation Factory 不可用；不会改用普通 Agent。')}),
          h(Executions,{context:props.context,sessionId:props.sessionId})),
        focus.target && h(ContextPane,{context:props.context,sessionId:props.sessionId,target:focus.target,origin:focus.origin,onClose:closeContext}));
    }
    function Chat(props) {
      var state=React.useState({reference:null,error:'',loading:true}), value=state[0], setValue=state[1];
      var retry=React.useState(0), nonce=retry[0], setNonce=retry[1];
      React.useEffect(function(){
        if(!props.workspaceReady)return;
        var alive=true, reference=null, controller=new AbortController(), timedOut=false;
        var timeout=setTimeout(function(){timedOut=true;controller.abort();},15000);
        setValue({reference:null,error:'',loading:true});
        nativeRequest('/session','POST',Object.assign({conversationId:'main'},props.workspaceId ? {workspaceId:props.workspaceId} : {}),controller.signal).then(function(body){
          if (!alive) return;
          if (!body || body.conversationId !== 'main' || !sourceSession(body.sessionId) || !body.capabilities || typeof body.capabilities !== 'object') throw new Error('format');
          publishCapabilities(body.sessionId,body.capabilities);
          // retain(string) rejects unknown identities; only the real Host catalog can admit this id.
          return props.context.sessions.refresh().then(function(){
            if(!alive)return;
            controller.signal.throwIfAborted();
            reference=props.context.sessions.retain(body.sessionId,{source:'controllerOperation',signal:controller.signal});
            return reference.ready.then(function(){if(alive && !controller.signal.aborted)setValue({reference:reference,error:'',loading:false});});
          });
        }).catch(function(){
          if(reference){reference.release();reference=null;}
          if(alive)setValue({reference:null,loading:false,error:timedOut?'原生会话连接超时。草稿不会发送到其他 Agent，请显式重试。':'无法连接真实 SuperAgent 原生会话；不会回退到普通 Agent。请检查连接后重试。'});
        }).finally(function(){clearTimeout(timeout);});
        return function(){alive=false;controller.abort();clearTimeout(timeout);if(reference)reference.release();};
      },[props.context,props.workspaceId,props.workspaceReady,nonce]);
      return h('div',{className:'sab-native','aria-label':'SuperAgent 原生会话'},
        value.loading && h('div',{className:'sab-notice',role:'status'},'正在连接真实 SuperAgent 原生会话…'),
        value.error && h('div',{className:'sab-notice sab-error',role:'alert'},value.error,' ',h('button',{type:'button',onClick:function(){setNonce(function(n){return n+1;});}},'重试连接')),
        value.reference && h(props.SessionProvider,{session:value.reference},props.renderSlot('superagent.conversation.native',{})));
    }
    function NameSettings() {
      var snapshot = useIdentity();
      var draftState = React.useState(''), draft = draftState[0], setDraft = draftState[1];
      var savingState = React.useState(false), saving = savingState[0], setSaving = savingState[1];
      var readingState = React.useState(false), reading = readingState[0], setReading = readingState[1];
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1];
      var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1];
      var edit = React.useRef({dirty:false,revision:null}), pending = React.useRef(null), alive = React.useRef(false), rereading = React.useRef(false);
      React.useEffect(function () { alive.current = true; return function () { alive.current = false; if (pending.current) pending.current.abort(); }; },[]);
      React.useEffect(function () {
        if (snapshot.identity && !edit.current.dirty) { edit.current.revision = snapshot.identity.revision; setDraft(snapshot.identity.agent.name); }
      },[snapshot.identity]);
      function reread() {
        if (pending.current || rereading.current) return;
        rereading.current = true; setReading(true); setError(''); setNotice('');
        refreshIdentity().then(function (ok) {
          if (!alive.current) return;
          if (ok && identityState.identity) { edit.current.revision = identityState.identity.revision; setNotice('已重新读取当前名称；你的输入保留，请确认后保存。'); }
        }).finally(function () { rereading.current = false; if (alive.current) setReading(false); });
      }
      function save(event) {
        event.preventDefault();
        if (pending.current || rereading.current) return;
        if (!validName(draft)) { setError('请输入 1–80 字且不含控制字符的名称。'); return; }
        if (!Number.isSafeInteger(edit.current.revision)) { setError('请先重新读取当前名称，再保存。'); return; }
        var controller = new AbortController(), timedOut = false, epoch = identityEpoch;
        var submission = {name:draft,revision:edit.current.revision};
        pending.current = controller; setSaving(true); setError(''); setNotice('');
        var timeout = setTimeout(function () { timedOut = true; controller.abort(); },15000);
        // The sole PUT site: only this explicit form submission can change the Source name.
        fetch(IDENTITY_API,{method:'PUT',headers:{'x-superagent-board':'1','Content-Type':'application/json'},credentials:'same-origin',signal:controller.signal,body:JSON.stringify(submission)})
          .then(function (response) { if (!response.ok) { var err = new Error('HTTP'); err.status = response.status; throw err; } return response.json().catch(function () { throw new Error('format'); }); })
          .then(function (body) {
            var identity = identityBody(body);
            if (epoch !== identityEpoch || controller.signal.aborted) return;
            acceptIdentity(identity);
            if (!alive.current) return;
            edit.current = {dirty:false,revision:identityState.identity.revision}; setDraft(identityState.identity.agent.name); setNotice('名称已保存。');
          }).catch(function (err) { if (alive.current && (!controller.signal.aborted || timedOut)) setError(identityError(err,timedOut)); })
          .finally(function () { clearTimeout(timeout); pending.current = null; if (alive.current) setSaving(false); });
      }
      return h('details',{className:'sab-name-settings'},h('summary',null,'名称设置'),
        h('form',{'aria-label':'名称设置',onSubmit:save},
          h('label',null,'Agent 名称 ',h('input',{'aria-label':'Agent 名称',type:'text',value:draft,placeholder:agentName(),maxLength:160,autoComplete:'off',readOnly:saving,onChange:function (event) { edit.current.dirty = true; setDraft(event.target.value); setError(''); setNotice(''); }})),
          h('span',{className:'sab-chathelp'},'独立名称，1–80 字；仅显式保存会写入 Source，不跟随飞书名称。'),
          h('div',null,h('button',{type:'submit',disabled:saving || reading || !snapshot.identity || !validName(draft)},saving?'保存中…':'保存名称'),' ',h('button',{type:'button',onClick:reread,disabled:saving || reading},reading?'读取中…':'重新读取名称')),
          (error || snapshot.error) && h('div',{className:'sab-notice sab-error',role:'alert'},error || snapshot.error),
          notice && h('div',{className:'sab-chathelp',role:'status'},notice)));
    }
    function Superagent(props) {
      useIdentity();
      var workspace=props.useWorkspaces(function(value){return value;}), sessions=props.useSessions(function(value){return value;});
      var mainIds=Object.keys(sessions.byId).filter(function(id){return (sessions.byId[id].retainedBy.mainView || 0)>0;});
      var selectedWorkspace=mainIds.length===1 ? workspace.items.find(function(item){return item.sessionIds.includes(mainIds[0]);}) : undefined;
      if(!selectedWorkspace && workspace.items.length===1)selectedWorkspace=workspace.items[0];
      var name = agentName();
      return h('section',{className:'sab sab-panel','aria-label':name},h('style',null,css + shellCss + nameCss + nativeCss),
        h('header',{className:'sab-shellhead'},h('h1',null,name),
          h('div',{className:'sab-sub'},'独立对话入口 · 工单统一同步到现有任务看板'),
          h(NameSettings),
          h('button',{type:'button',onClick:function(){props.context.layout.selectPanel('task-board');},style:{marginTop:'12px'}},'打开任务看板')),
        h('div',{className:'sab-pane'},h(Chat,{context:props.context,SessionProvider:props.SessionProvider,renderSlot:props.renderSlot,workspaceId:selectedWorkspace && selectedWorkspace.workspaceId,workspaceReady:workspace.phase==='ready' && sessions.phase==='ready'})));
    }
    function data(task) { return task && task.integrations && task.integrations.superagent; }
    function Decoration(props) {
      useIdentity();
      var entry=data(props.task);
      if (!entry || !entry.managed) return null;
      return h('span',{'data-superagent-external':'true',style:{fontSize:'12px',color:'var(--dsw-alias-link,#4f46e5)'}},agentName(entry)+' · '+text(entry.statusText,'状态未知',60));
    }
    function Detail(props) {
      useIdentity();
      var entry=data(props.task);
      if (!entry || !entry.managed) return null;
      var link=prLink(entry.links), name=agentName(entry);
      return h('section',{'data-superagent-detail':'true',style:{padding:'14px',border:'1px solid var(--dsw-alias-border-l2,#ddd)',borderRadius:'8px'}},
        h('h3',null,name+' 外部工单'), h('p',null,'工单 ID：',h('code',null,text(entry.ticketId,'未知',128))),
        h('p',null,text(entry.statusText,'状态未知',60)+' · '+when(entry.upstreamUpdatedAt)),
        h('p',null,'此卡由 '+name+' 执行并同步状态。本地运行预设故意不可执行；请从 '+name+' 对话继续，不要修改其执行配置。'),
        h('p',{style:{whiteSpace:'pre-wrap'}},text(entry.summary,'暂无执行摘要',6000)),
        link && h('a',{href:link,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},'查看 PR ↗'));
    }
    function apply(ctx) {
      var releases=[];
      releases.push(ctx.slots.inject('sidebar.panellist',function(){
        var label, release;
        function update() {
          var next = agentName();
          if (label === next) return;
          label = next; if (release) release();
          release = ctx.slots.register({name:'sidebar.panellist',id:PANEL,order:30,label:label},Icon);
        }
        update(); var unsubscribe = subscribeIdentity(update);
        return function () { unsubscribe(); if (release) release(); };
      }));
      releases.push(ctx.slots.inject('main',function(){return ctx.slots.register({name:'main',key:PANEL,children:{'superagent.conversation.native':{kind:'single',scope:'session'}},inject:function(){return {context:ctx};}},Superagent);}));
      releases.push(ctx.slots.inject('superagent.conversation.native',function(){return ctx.slots.register({name:'superagent.conversation.native',inject:function(){return {context:ctx};}},nativeBody);}));
      releases.push(ctx.uiConversation.events.register({
        kind:'superagent-source',target:'chat',
        match:{'superagent/source':function(event){var entry=sourceRecord(event);return entry?{id:event.data.conversationId+':'+entry.id,role:'start'}:null;}},
        start:function(_context,match){return {entry:sourceRecord(match.event),seq:match.event.seq,location:match.location};},
        update:function(context){return context.state;},
        buildViewNode:function(context){var state=context.state;if(!state || !state.entry || state.entry.role !== 'assistant')return null;return {key:context.key,id:context.id,kind:'superagent-source',target:'chat',anchorSeq:state.seq,location:state.location,groupTree:'turn',visibility:'visible',data:state.entry};}
      }));
      releases.push(ctx.slots.inject('conversation.chat.node',function(){return ctx.slots.register({name:'conversation.chat.node',key:'superagent-source'},SourceNode);}));
      releases.push(ctx.uiConversation.events.register({
        kind:'superagent-transport',target:'chat',
        match:{
          'superagent/relay':function(event){if(!relayOwner(event))return null;var record=transportRecord(event);return {id:record?transportIdentity(record):'ignored:'+event.seq,role:'start'};},
          'superagent/source':function(event){var record=transportRecord(event);return record && record.requestId?{id:transportIdentity(record),role:'update'}:null;}
        },
        start:function(_context,match){return transportState(undefined,match);},
        update:function(context,match){return transportState(context.state,match);},
        buildViewNode:function(context){var state=context.state;if(!state || !state.record || state.record.operation==='open')return null;return {key:context.key,id:context.id,kind:'superagent-transport',target:'chat',anchorSeq:state.seq,location:state.location,groupTree:'turn',visibility:'visible',data:state.record};}
      }));
      releases.push(ctx.slots.inject('conversation.chat.node',function(){return ctx.slots.register({name:'conversation.chat.node',key:'superagent-transport'},SourceTransportNode);}));
      releases.push(ctx.slots.inject('conversation.input.dock',function(){return ctx.slots.register({name:'conversation.input.dock',id:'superagent-capabilities',order:-100,locale:'conversation',inject:function(){return {context:ctx};}},SourceCapabilities);}));
      releases.push(ctx.slots.inject('conversation.composer',function(){return ctx.slots.register({name:'conversation.composer',priority:-100,select:function(owner){
        if(!sourceSession(owner.sessionId))return null;
        var input=sourceInput(ctx,owner.sessionId), reason=unsupportedInput(input && input.state.getSnapshot(),effectiveCapabilities(owner.sessionId).attachments);
        return reason || null;
      },inject:function(){return {context:ctx};}},SourceGuard);}));
      releases.push(ctx.slots.inject('task-board.card.decoration',function(){return ctx.slots.register({name:'task-board.card.decoration',id:'superagent-source'},Decoration);}));
      releases.push(ctx.slots.inject('task-board.detail.section',function(){return ctx.slots.register({name:'task-board.detail.section',id:'superagent-source'},Detail);}));
      if(typeof ctx.taskBoard.registerGrouping === 'function') {
        var groupingName, groupingRelease;
        function updateGrouping() {
          var next = agentName();
          if (next === groupingName) return;
          groupingName = next; if (groupingRelease) groupingRelease();
          groupingRelease = ctx.taskBoard.registerGrouping(function(task){var entry=data(task);return entry ? {id:'superagent:current',label:agentName(entry)} : undefined;});
        }
        updateGrouping(); var unsubscribeGrouping = subscribeIdentity(updateGrouping);
        releases.push(function(){unsubscribeGrouping();if(groupingRelease)groupingRelease();});
      }
      ctx.effect(function(){var stopIdentity = startIdentity();return function(){stopIdentity();releases.forEach(function(dispose){dispose();});};},'superagent: chat and existing task-board provider');
    }
    return {inject:['slots','layout','taskBoard','sessions','uiConversation','conversation'],apply:apply};
  }
});
