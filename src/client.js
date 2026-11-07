window.__ModuleLoader__.load({
  id: 'dsh-superagent-connector',
  factory: function (require) {
    'use strict';
    var React = require('react');
    var h = React.createElement;
    var PANEL = 'dsh-superagent-board';
    var CHAT_API = '/@superagent-board/api/chat';
    // Keep an uncertain submission across panel remounts, in memory only. Never auto-submit it.
    var chatMemory = {draft:'',attempt:null};
    var chatCss = '.sab-panel{display:flex;flex-direction:column;overflow:hidden}.sab-shellhead{padding:18px clamp(16px,3vw,38px);border-bottom:1px solid var(--dsw-alias-border-l2,#dbe3ee);flex:none}.sab-shellhead h1{font-size:22px}.sab-tabs{display:flex;gap:8px;margin-top:12px}.sab button[aria-selected=true]{background:#4f46e5;color:#fff;border-color:#4f46e5}.sab button:disabled{opacity:.55;cursor:wait}.sab-pane{flex:1;min-height:0;display:flex}.sab-pane[hidden]{display:none}.sab-pane>.sab{width:100%}.sab-chat{display:flex;flex-direction:column;min-height:0;width:100%;max-width:1100px;margin:auto;height:100%;gap:10px;padding:16px clamp(16px,3vw,32px)}.sab-chat .sab-notice{margin:0;flex:none}.sab-chatbar,.sab-composebar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;flex:none}.sab-log{flex:1;min-height:70px;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);border-radius:12px;padding:16px}.sab-message{max-width:90%;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);border-radius:12px;margin:0 0 12px;background:var(--dsw-alias-bg-base,#fff);overflow-wrap:anywhere}.sab-message-user{margin-left:auto;background:rgba(99,102,241,.08)}.sab-message-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b);margin-bottom:6px}.sab-message-text{white-space:pre-wrap;overflow-wrap:anywhere}.sab-message a{color:var(--dsw-alias-link,#4f46e5);text-decoration:underline}.sab-composer{flex:none;display:flex;flex-direction:column;gap:8px}.sab textarea{width:100%;min-height:90px;max-height:220px;resize:vertical;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);border-radius:10px;color:inherit;background:var(--dsw-alias-bg-base,#fff);font:inherit;line-height:1.5}.sab textarea:focus-visible{outline:2px solid #6366f1;outline-offset:2px}.sab textarea[readonly]{opacity:.8}.sab-chathelp{font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}';
    var css = '.sab{height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#172033);font:14px/1.5 system-ui,sans-serif}.sab *{box-sizing:border-box}.sab h1{margin:0 0 6px}.sab-sub,.sab-muted{color:var(--dsw-alias-label-secondary,#64748b)}.sab button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,#dbe3ee);background:var(--dsw-alias-bg-base,#fff);border-radius:9px;min-height:36px;padding:7px 12px;cursor:pointer}.sab button:focus-visible{outline:2px solid #6366f1;outline-offset:2px}.sab-notice{padding:13px 16px;border-radius:10px;background:rgba(99,102,241,.08)}.sab-error{background:rgba(239,68,68,.1)}.sab-empty{padding:25px;text-align:center;color:var(--dsw-alias-label-secondary,#64748b)}';

    // Never display API objects or response bodies. Text is bounded and common credential forms are masked.
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
    function chatContent(value) {
      var source = value.slice(0, 50000).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[已隐藏]')
        .replace(/\b(token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[已隐藏]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[已隐藏]');
      var parts = [], pattern = /\bhttps?:\/\/[^\s<>"']+/gi, match, offset = 0;
      while ((match = pattern.exec(source))) {
        parts.push(source.slice(offset, match.index));
        var candidate = match[0].replace(/[),.;:!?，。；：！？）\]}>]+$/, '');
        var link = githubPR(candidate);
        parts.push(link ? h('a',{key:'pr:'+match.index,href:link,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},link) : '[链接已隐藏]');
        if (link) parts.push(match[0].slice(candidate.length));
        offset = pattern.lastIndex;
      }
      parts.push(source.slice(offset));
      if (value.length > 50000) parts.push('\n[消息过长，已截断显示]');
      return parts;
    }
    function chatStatus(value) {
      var labels = {accepted:'已接收',queued:'已排队',pending:'待处理',running:'处理中',working:'处理中',completed:'已完成',done:'已完成',failed:'失败',error:'异常',cancelled:'已取消'};
      return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : '';
    }
    function sameMessages(left, right) {
      return left.length === right.length && left.every(function (item, index) {
        var other = right[index];
        return item.id === other.id && item.role === other.role && item.text === other.text && item.at === other.at && item.status === other.status;
      });
    }
    function Chat(props) {
      var messagesState = React.useState([]), messages = messagesState[0], setMessages = messagesState[1];
      var draftState = React.useState(chatMemory.draft), draft = draftState[0], setDraft = draftState[1];
      var loadingState = React.useState(true), loading = loadingState[0], setLoading = loadingState[1];
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1];
      var sendErrorState = React.useState(''), sendError = sendErrorState[0], setSendError = sendErrorState[1];
      var postingState = React.useState(false), posting = postingState[0], setPosting = postingState[1];
      var retryState = React.useState(!!chatMemory.attempt), retry = retryState[0], setRetry = retryState[1];
      var moreState = React.useState(false), more = moreState[0], setMore = moreState[1];
      var unreadState = React.useState(false), unread = unreadState[0], setUnread = unreadState[1];
      var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1];
      var alive = React.useRef(false), getRequest = React.useRef(null), postRequest = React.useRef(null), serial = React.useRef(0);
      var sending = React.useRef(false), attempt = React.useRef(chatMemory.attempt), local = React.useRef([]);
      var log = React.useRef(null), follow = React.useRef(true);
      var refresh = React.useCallback(function () {
        if (getRequest.current) getRequest.current.abort();
        var controller = new AbortController(), current = ++serial.current, timedOut = false;
        getRequest.current = controller; setLoading(true);
        var timeout = setTimeout(function () { timedOut = true; controller.abort(); }, 15000);
        fetch(CHAT_API,{method:'GET',headers:{'x-superagent-board':'1'},credentials:'same-origin',cache:'no-store',signal:controller.signal})
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json().catch(function () { throw new Error('format'); });
          }).then(function (body) {
            if (!body || !Array.isArray(body.messages) || body.limit !== 200 || (body.hasMore !== undefined && typeof body.hasMore !== 'boolean') || body.messages.length > 200 || body.messages.some(function (item) {
              return !item || (typeof item.id !== 'string' && typeof item.id !== 'number') || !String(item.id) || (item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string' || (typeof item.at !== 'string' && typeof item.at !== 'number');
            })) throw new Error('format');
            if (!alive.current || serial.current !== current) return;
            var incoming = body.messages.map(function (item) { return {id:String(item.id),role:item.role,text:item.text,at:item.at,status:chatStatus(item.status) ? item.status : ''}; });
            local.current = local.current.filter(function (item) { return !incoming.some(function (entry) { return entry.id === item.id; }); });
            var next = incoming.concat(local.current).slice(-200);
            setMessages(function (previous) { return sameMessages(previous, next) ? previous : next; });
            setMore(body.hasMore === true); setError('');
          }).catch(function (err) {
            if (!alive.current || serial.current !== current || (controller.signal.aborted && !timedOut)) return;
            // Never echo server bodies, arbitrary exceptions, URLs or credentials into an error.
            var reason = timedOut ? '请求超时' : err && /^HTTP \d+$/.test(err.message) ? err.message : err && err.message === 'format' ? '响应格式不符合对话协议' : '网络请求失败';
            setError('对话加载失败：' + reason + '。可刷新重试；已有消息保留。');
          }).finally(function () {
            clearTimeout(timeout);
            if (alive.current && serial.current === current) { getRequest.current = null; setLoading(false); }
          });
      }, []);
      React.useEffect(function () {
        alive.current = true; refresh();
        return function () {
          alive.current = false; serial.current++;
          if (getRequest.current) getRequest.current.abort();
          if (postRequest.current) postRequest.current.abort();
        };
      }, [refresh]);
      React.useEffect(function () {
        if (!props.active) return;
        var timer = setInterval(function () { if (!document.hidden && !getRequest.current) refresh(); }, 5000);
        return function () { clearInterval(timer); };
      }, [props.active, refresh]);
      React.useEffect(function () {
        if (!props.active || !log.current) return;
        if (follow.current) { log.current.scrollTop = log.current.scrollHeight; setUnread(false); }
        else setUnread(true);
      }, [messages, props.active]);
      function submit() {
        if (sending.current || (!attempt.current && !draft.trim())) return;
        if (!attempt.current && draft.length > 12000) { setSendError('消息超过 12000 字，请缩短后发送。'); return; }
        var submission = attempt.current;
        if (!submission) {
          try { submission = {text:draft,requestId:crypto.randomUUID()}; }
          catch (_) { setSendError('无法生成安全请求标识。文本已保留，请使用支持 crypto.randomUUID 的浏览器。'); return; }
          attempt.current = submission; chatMemory.attempt = submission;
        }
        sending.current = true; setPosting(true); setSendError(''); setNotice('');
        var controller = new AbortController(), timedOut = false;
        postRequest.current = controller;
        var timeout = setTimeout(function () { timedOut = true; controller.abort(); }, 30000);
        // This is the sole POST site, reached only by Send or Ctrl+Enter. No automatic retry.
        fetch(CHAT_API,{method:'POST',headers:{'x-superagent-board':'1','Content-Type':'application/json'},credentials:'same-origin',signal:controller.signal,body:JSON.stringify(submission)})
          .then(function (response) {
            if (response.status !== 202) throw new Error('HTTP ' + response.status);
            return response.json().catch(function () { throw new Error('format'); });
          }).then(function (body) {
            if (!body || body.accepted !== true || (typeof body.id !== 'string' && typeof body.id !== 'number') || !String(body.id)) throw new Error('format');
            if (chatMemory.attempt === submission) { chatMemory.attempt = null; chatMemory.draft = ''; }
            if (!alive.current) return;
            var entry = {id:String(body.id),role:'user',text:submission.text,at:new Date().toISOString(),status:'accepted'};
            local.current.push(entry);
            setMessages(function (previous) { return previous.some(function (item) { return item.id === entry.id; }) ? previous : previous.concat([entry]).slice(-200); });
            attempt.current = null; setDraft(''); setRetry(false);
            setNotice('消息已接收，等待现有 Superagent 处理；这不代表执行完成。');
            refresh();
          }).catch(function (err) {
            if (!alive.current) return;
            var reason = timedOut ? '请求超时，服务端是否已接收尚未确认' : err && /^HTTP \d+$/.test(err.message) ? err.message : err && err.message === 'format' ? '接收确认格式异常' : '网络异常，服务端是否已接收尚未确认';
            setRetry(true);
            setSendError('发送未确认：' + reason + '。文本和同一 requestId 已保留；仅在你再次按发送时重试，避免重复提交。');
          }).finally(function () {
            clearTimeout(timeout); sending.current = false;
            if (alive.current) { postRequest.current = null; setPosting(false); }
          });
      }
      return h('section',{className:'sab-chat','aria-label':'连接现有 Superagent 的对话'},
        h('div',{className:'sab-notice'},'连接现有 Superagent；会进入工单流程，可能修改仓库/消耗额度。只有点击发送或按 Ctrl+Enter 才会提交。'),
        h('div',{className:'sab-chatbar'},h('span',{className:'sab-muted'},'现有 Superagent 对话 · 每 5 秒读取新消息'),h('button',{type:'button',onClick:refresh,disabled:loading},loading?'加载中…':'刷新对话')),
        error && h('div',{className:'sab-notice sab-error',role:'alert'},error),
        more && h('div',{className:'sab-chathelp'},'仅显示最近 200 条消息，更早的消息未加载。'),
        h('div',{className:'sab-log',ref:log,role:'log','aria-label':'Superagent 消息','aria-live':'polite','aria-busy':loading,onScroll:function () {
          var node = log.current;
          if (node) { follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (follow.current) setUnread(false); }
        }},messages.length === 0 ? h('div',{className:'sab-empty'},loading?'正在加载对话…':error?'暂时无法读取对话，请刷新重试。':'还没有消息。向现有 Superagent 发送一条消息开始对话。') : messages.map(function (message) {
          return h('article',{className:'sab-message sab-message-'+message.role,key:message.id},
            h('div',{className:'sab-message-meta'},h('strong',null,message.role === 'user'?'你':'Superagent'),h('span',null,when(message.at)),chatStatus(message.status) && h('span',null,chatStatus(message.status))),
            h('div',{className:'sab-message-text'},chatContent(message.text)));
        })),
        unread && h('button',{type:'button',onClick:function () { follow.current = true; if (log.current) log.current.scrollTop = log.current.scrollHeight; setUnread(false); }},'有新消息 · 跳到底部'),
        h('div',{className:'sab-composer'},
          h('textarea',{maxLength:12000,'aria-label':'发送给现有 Superagent 的消息',placeholder:'输入消息；Enter 换行，Ctrl+Enter 发送',value:draft,readOnly:posting || retry,onChange:function (event) { if (!attempt.current) { chatMemory.draft = event.target.value; setDraft(event.target.value); } },onKeyDown:function (event) {
            if (event.key === 'Enter' && event.ctrlKey && !event.isComposing && !(event.nativeEvent && event.nativeEvent.isComposing)) { event.preventDefault(); submit(); }
          }}),
          sendError && h('div',{className:'sab-notice sab-error',role:'alert'},sendError),
          notice && h('div',{className:'sab-chathelp',role:'status'},notice),
          h('div',{className:'sab-composebar'},h('span',{className:'sab-chathelp'},retry?'为避免重复，失败消息保持原文，并使用同一 requestId 重试。':'Enter 换行 · Ctrl+Enter 发送 · 仅纯文本，安全识别 GitHub PR 链接'),h('button',{type:'button',onClick:submit,disabled:posting || (!retry && !draft.trim())},posting?'提交中…':retry?'重试发送':'发送'))));
    }
    function Superagent(props) {
      return h('section',{className:'sab sab-panel','aria-label':'Superagent'},h('style',null,css + chatCss),
        h('header',{className:'sab-shellhead'},h('h1',null,'Superagent'),
          h('div',{className:'sab-sub'},'独立对话入口 · 工单统一同步到现有任务看板'),
          h('button',{type:'button',onClick:function(){props.context.layout.selectPanel('task-board');},style:{marginTop:'12px'}},'打开任务看板')),
        h('div',{className:'sab-pane'},h(Chat,{active:true})));
    }
    function data(task) { return task && task.integrations && task.integrations.superagent; }
    function Decoration(props) {
      var entry=data(props.task);
      if (!entry || !entry.managed) return null;
      return h('span',{'data-superagent-external':'true',style:{fontSize:'12px',color:'var(--dsw-alias-link,#4f46e5)'}},'Superagent · '+text(entry.statusText,'状态未知',60));
    }
    function Detail(props) {
      var entry=data(props.task);
      if (!entry || !entry.managed) return null;
      var link=prLink(entry.links);
      return h('section',{'data-superagent-detail':'true',style:{padding:'14px',border:'1px solid var(--dsw-alias-border-l2,#ddd)',borderRadius:'8px'}},
        h('h3',null,'Superagent 外部工单'), h('p',null,'工单 ID：',h('code',null,text(entry.ticketId,'未知',128))),
        h('p',null,text(entry.statusText,'状态未知',60)+' · '+when(entry.upstreamUpdatedAt)),
        h('p',null,'此卡由 Superagent 执行并同步状态。本地运行预设故意不可执行；请从 Superagent 对话继续，不要修改其执行配置。'),
        h('p',{style:{whiteSpace:'pre-wrap'}},text(entry.summary,'暂无执行摘要',6000)),
        link && h('a',{href:link,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},'查看 PR ↗'));
    }
    function apply(ctx) {
      var releases=[];
      releases.push(ctx.slots.inject('sidebar.panellist',function(){return ctx.slots.register({name:'sidebar.panellist',id:PANEL,order:30,label:'Superagent'},Icon);}));
      releases.push(ctx.slots.inject('main',function(){return ctx.slots.register({name:'main',key:PANEL,inject:function(){return {context:ctx};}},Superagent);}));
      releases.push(ctx.slots.inject('task-board.card.decoration',function(){return ctx.slots.register({name:'task-board.card.decoration',id:'superagent-source'},Decoration);}));
      releases.push(ctx.slots.inject('task-board.detail.section',function(){return ctx.slots.register({name:'task-board.detail.section',id:'superagent-source'},Detail);}));
      if(typeof ctx.taskBoard.registerGrouping === 'function') releases.push(ctx.taskBoard.registerGrouping(function(task){return data(task) ? {id:'superagent:current',label:'Superagent'} : undefined;}));
      ctx.effect(function(){return function(){releases.forEach(function(dispose){dispose();});};},'superagent: chat and existing task-board provider');
    }
    return {inject:['slots','layout','taskBoard'],apply:apply};
  }
});
