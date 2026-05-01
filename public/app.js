/* ========================================
   SORA 安全支援アプリ v1.4
   日新興業株式会社
   2026年対応: Gemini 2.5系モデル使用
   ======================================== */

/* ---------- Gemini API ---------- */
var GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];
var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

function getApiKey() {
  return localStorage.getItem('sora_api_key') || '';
}

function getTtsEnabled() {
  return localStorage.getItem('sora_tts_enabled') === '1';
}

function setTtsEnabled(enabled) {
  localStorage.setItem('sora_tts_enabled', enabled ? '1' : '0');
}

function stripForTts(text) {
  // Markdown/記号を簡易除去して読み上げ向けに整形
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[_*#>-]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function soraSpeak(text) {
  try {
    if (!getTtsEnabled()) return;
    if (!('speechSynthesis' in window)) return;
    var clean = stripForTts(text);
    if (!clean) return;
    window.speechSynthesis.cancel();
    var ut = new SpeechSynthesisUtterance(clean);
    ut.lang = 'ja-JP';
    // 日本語音声を優先して選択
    var voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (v && (v.lang === 'ja-JP' || (v.lang || '').toLowerCase().indexOf('ja') === 0)) { ut.voice = v; break; }
    }
    ut.rate = 1.0;
    ut.pitch = 1.0;
    ut.volume = 1.0;
    window.speechSynthesis.speak(ut);
  } catch (e) {}
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function callGemini(apiKey, body) {
  var json = null, lastErr = '', triedModels = [];
  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var model = GEMINI_MODELS[i];
    triedModels.push(model);
    var url = GEMINI_BASE + model + ':generateContent?key=' + apiKey;
    try {
      var resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (resp.ok) { json = await resp.json(); break; }
      var errBody = await resp.text();
      lastErr = model + ' (' + resp.status + '): ' + errBody.substring(0, 300);

      if (resp.status === 403 && errBody.indexOf('leaked') >= 0) {
        throw new Error('LEAKED_KEY');
      }
      if (resp.status === 403 || resp.status === 401) {
        throw new Error('INVALID_KEY:' + errBody.substring(0, 200));
      }
      if (resp.status === 429 && i < GEMINI_MODELS.length - 1) {
        await sleep(3000);
        continue;
      }
      if (i < GEMINI_MODELS.length - 1) { await sleep(1000); continue; }
    } catch (e) {
      if (e.message === 'LEAKED_KEY' || e.message.indexOf('INVALID_KEY') === 0) throw e;
      lastErr = model + ': ' + e.message;
      if (i < GEMINI_MODELS.length - 1) continue;
    }
  }
  if (!json) throw new Error(triedModels.join(', ') + ' で失敗\n' + lastErr);
  if (!json.candidates || !json.candidates[0] || !json.candidates[0].content)
    throw new Error('AIから回答が返りませんでした');
  return json.candidates[0].content.parts[0].text;
}

async function testApiKey(apiKey) {
  var url = GEMINI_BASE + 'gemini-2.5-flash-lite:generateContent?key=' + apiKey;
  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'テスト。OKとだけ返して。' }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 100 }
    })
  });
  if (!resp.ok) {
    var e = await resp.text().catch(function() { return ''; });
    if (e.indexOf('leaked') >= 0) {
      throw new Error('このAPIキーはGoogleにより無効化されています。新しいプロジェクトでAPIキーを再作成してください。');
    }
    if (resp.status === 429) {
      throw new Error('APIの利用上限に達しています。Google AI Studioで新しいプロジェクトを作成し、そこでAPIキーを発行してください。');
    }
    throw new Error('HTTP ' + resp.status + ': ' + e.substring(0, 120));
  }
  return true;
}

/* ---------- 法令検索 ---------- */
function searchLaws(query) {
  if (typeof LAWS_DB === 'undefined' || !LAWS_DB) return '';
  var keywords = query.replace(/[?？。、！!]/g, ' ').split(/\s+/).filter(function(w) { return w.length >= 2; });
  if (keywords.length === 0) keywords = [query.trim()];

  var scored = [];
  LAWS_DB.forEach(function(law) {
    law.articles.forEach(function(art) {
      var text = art.heading + ' ' + art.body;
      var score = 0;
      keywords.forEach(function(kw) {
        var idx = text.indexOf(kw);
        while (idx >= 0) { score += 10; idx = text.indexOf(kw, idx + 1); }
      });
      if (law.priority) score *= 2;
      if (score > 0) scored.push({ law: law.title, score: score, text: art.body.substring(0, 600) });
    });
  });

  scored.sort(function(a, b) { return b.score - a.score; });
  var top = scored.slice(0, 6);
  if (top.length === 0) return '';

  var ctx = '【参考：関係法令の該当条文】\n';
  top.forEach(function(item) { ctx += '\n■ ' + item.law + '\n' + item.text + '\n'; });
  return ctx;
}

/* ---------- システムプロンプト ---------- */
var SYS = 'あなたは「SORA（ソラ）」です。日新興業株式会社の安全管理AIアシスタントです。\n'
  + 'SORAは「中枢AI NICORA」に寄り添う浮遊型マスコットAI。若手技術者（経験1年程度）の安全の相棒として、命令や管理ではなく、気づきと対話で判断力を伸ばす。\n'
  + '口調は相棒的でフラット。敬語・説教・上から目線は禁止。「一緒に考える」スタンスで、相手の判断を尊重する。\n'
  + 'ただし安全に関してだけは妥協しない。危険度に応じてトーンを変える：\n'
  + '- 通常：やわらかく会話的\n'
  + '- 注意：端的で真剣\n'
  + '- 危険：短く低いトーンで制止（例：「止まって。今はダメ。」）\n\n'
  + '回答の最初に危険度を必ず明示する（いずれか一つ）：\n'
  + '【危険度：通常】/【危険度：注意】/【危険度：危険】\n\n'
  + '回答は以下のセクションで構成（該当のみ）：\n'
  + '### 🔍 リスク・危険ポイント\n### 🛡️ 対策・改善提案\n### 📋 関係法令\n### ⚠️ 類似災害事例\n### 💡 SORAからのひとこと\n\n'
  + '書き方ルール：\n'
  + '- 断定命令（「〜しろ」「必ず〜しなさい」）は避け、提案・確認の形にする（ただし【危険度：危険】のときだけ短く制止はOK）\n'
  + '- 余計な前置きは短く、現場で今すぐ使える確認ポイントを優先\n'
  + '- 「ナイス」「その判断アリ」など相棒らしい短い声かけを1つ入れて良い\n\n'
  + '関係法令は条文番号を必ず明記すること。ユーザーから渡される【参考：関係法令の該当条文】があればそれを優先的に引用すること。';

var SYS_PHOTO = SYS + '\n\n1枚または複数枚の現場写真が渡されることがあります。すべての写真を総合的に踏まえ、安全の観点からリスク・対策・法令・事例を回答してください。';

var SYS_PATROL_JSON = 'あなたは建設現場の安全巡視アシスタントです。\n'
  + '与えられた写真の範囲でだけ判断し、写っていない・確認できない項目は断定しない（am/pm に空文字）。\n'
  + '「ok」= 写真から見て良好、「ng」= 是正が必要または明らかな不備・危険がうかがえる。\n'
  + '出力は有効なJSONオブジェクトのみ（説明文・マークダウン禁止）。';

/* ---------- ユーティリティ ---------- */
function $(id) { return document.getElementById(id); }
function escapeHtml(t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function renderMd(text) {
  var h = escapeHtml(text);
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/`(.+?)`/g, '<code>$1</code>');
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  var lines = h.split('\n'), inList = false, out = [];
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t.match(/^- /) || t.match(/^\d+\. /)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + (t.match(/^- /) ? t.slice(2) : t.replace(/^\d+\. /, '')) + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!t) continue;
      if (t.indexOf('<h3>') === 0 || t.indexOf('<blockquote>') === 0) out.push(t);
      else out.push('<p>' + t + '</p>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function friendlyError(msg) {
  msg = msg || '';
  if (msg === 'LEAKED_KEY' || msg.indexOf('leaked') >= 0 || msg.indexOf('無効化') >= 0) {
    return '⚠️ このAPIキーはGoogleにより「漏洩」として無効化されています。\n\n'
      + '**新しいAPIキーの作成手順：**\n'
      + '1. Google AI Studio（https://aistudio.google.com/）にアクセス\n'
      + '2. 左上のプロジェクト選択から「新しいプロジェクトを作成」\n'
      + '3. 新プロジェクト内で「APIキーを作成」をクリック\n'
      + '4. コピーしたキーを右上の⚙設定から登録\n\n'
      + '※同じプロジェクト内で新しいキーを作っても同じエラーになります';
  }
  if (msg.indexOf('429') >= 0 || msg.indexOf('quota') >= 0 || msg.indexOf('RESOURCE_EXHAUSTED') >= 0) {
    return '⚠️ APIの利用制限に達しました。\n\n'
      + '**対処法：**\n'
      + '- 1～2分待ってから再送信\n'
      + '- 改善しない場合 → Google AI Studio で新しいプロジェクトを作成してAPIキーを発行\n\n'
      + '詳細: ' + msg.substring(0, 120);
  }
  if (msg.indexOf('INVALID_KEY') >= 0 || msg.indexOf('API key') >= 0 || msg.indexOf('403') >= 0 || msg.indexOf('401') >= 0) {
    return '⚠️ APIキーが無効です。右上の⚙から正しいキーを設定してください。\n\n'
      + 'Google AI Studio（https://aistudio.google.com/apikey）から取得できます。';
  }
  if (msg.indexOf('Failed to fetch') >= 0 || msg.indexOf('network') >= 0) {
    return '⚠️ ネットワークに接続できません。Wi-Fiや回線を確認してください。';
  }
  return '⚠️ エラーが発生しました。\n詳細: ' + msg.substring(0, 200);
}

var soraNotifySpeakingEnded = function() {};

function soraKeyOutGreen(ctx, w, h) {
  try {
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      // 緑が R/B よりも強いピクセルを抜く（クロマキー）
      // gDom: 緑の突出度 / gAdv: 緑優位性
      var maxRB = Math.max(r, b);
      var gDom = g - maxRB;
      // 強めに抜く（純緑～黄緑まで広く対象）
      if (g > 60 && gDom > 20) {
        d[i + 3] = 0;
        continue;
      }
      // 縁のフェザー：半透明化 + 緑滲み抑制
      if (g > 40 && gDom > 8) {
        var k = Math.min(1, (gDom - 8) / 18);
        var a = d[i + 3];
        d[i + 3] = Math.floor(a * (1 - 0.9 * k));
        d[i + 1] = Math.floor(g * (1 - 0.7 * k) + maxRB * 0.7 * k);
      }
    }
    ctx.putImageData(img, 0, 0);
  } catch (e) {
    // getImageData が失敗したら画面に赤い目印を出して検知できるようにする
    try {
      ctx.fillStyle = 'rgba(255,0,0,0.35)';
      ctx.fillRect(0, 0, Math.min(10, w), Math.min(10, h));
    } catch (e2) {}
  }
}

function soraKeyOutWhite(ctx, w, h) {
  try {
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      // 白背景の簡易クロマキー（白～薄灰も含めて、縁はフェザー）
      var maxc = Math.max(r, g, b);
      var minc = Math.min(r, g, b);
      var avg = (r + g + b) / 3;
      var sat = maxc - minc; // 低いほど白/灰

      // まず「白～薄灰」らしさをスコア化
      var whiteness = avg; // 0..255
      var grayish = 255 - sat; // 低彩度ほど高い

      // 強く抜く領域（ほぼ白 & 低彩度）
      if (whiteness > 238 && grayish > 235) {
        d[i + 3] = 0;
        continue;
      }

      // 周辺をフェザー（白寄り + 低彩度）
      if (whiteness > 220 && grayish > 210) {
        // whiteness 220..250 を 0..1 に
        var t = Math.min(1, Math.max(0, (whiteness - 220) / 30));
        // grayish 210..255 を 0..1 に
        var u = Math.min(1, Math.max(0, (grayish - 210) / 45));
        var k = t * u; // 0..1
        // 透明度を落とす（完全に消すと縁が欠けるので少し残す）
        var a = d[i + 3];
        var target = Math.floor(a * (1 - 0.92 * k));
        d[i + 3] = Math.min(a, target);
      }
    }
    ctx.putImageData(img, 0, 0);
  } catch (e) {}
}

function soraDrawToCanvas(portraitEl, sourceEl) {
  var c = portraitEl.querySelector('canvas');
  if (!c) return;
  var rect = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
  var w = Math.max(1, Math.floor((rect && rect.width) || c.clientWidth || 80));
  var h = Math.max(1, Math.floor((rect && rect.height) || c.clientHeight || w));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  var ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  var sw = 0, sh = 0;
  var isVideo = false;
  if (sourceEl && sourceEl.videoWidth && sourceEl.videoHeight) {
    sw = sourceEl.videoWidth;
    sh = sourceEl.videoHeight;
    isVideo = true;
  } else if (sourceEl && sourceEl.naturalWidth && sourceEl.naturalHeight) {
    sw = sourceEl.naturalWidth;
    sh = sourceEl.naturalHeight;
  } else {
    sw = w; sh = h;
  }
  // チャットの丸アイコンは「全体が収まる」ことを優先（contain）
  var scale = Math.min(w / sw, h / sh);
  var dw = Math.max(1, Math.floor(sw * scale));
  var dh = Math.max(1, Math.floor(sh * scale));
  var dx = Math.floor((w - dw) / 2);
  var dy = Math.floor((h - dh) / 2);
  ctx.drawImage(sourceEl, dx, dy, dw, dh);
  // 動画はグリーンバック（緑抜き）、静止画は白抜きで処理
  if (isVideo) {
    soraKeyOutGreen(ctx, w, h);
  } else {
    soraKeyOutWhite(ctx, w, h);
  }
}

function soraInitPortraitCanvas(portraitEl) {
  // チャット用アイコンは「動画」を使う（常時ループ再生）
  if (!portraitEl || portraitEl._soraInit) return;
  portraitEl._soraInit = true;
  portraitEl._soraStartVideoDraw = function() {};
  portraitEl._soraStopVideoDraw = function() {};
  var vid = portraitEl.querySelector('video');
  if (vid) {
    try {
      vid.muted = true;
      vid.loop = true;
      vid.playsInline = true;
      // loop が効かない環境でも確実にループ（終端で黒画面にならないように）
      if (!vid._soraLoopBound) {
        vid._soraLoopBound = true;
        // 動画の末尾に黒い区間が含まれるため、固定で 9秒時点で先頭へ戻す
        var LOOP_AT_SEC = 9.0;
        vid.addEventListener('timeupdate', function() {
          try {
            // 動画が 9秒未満の場合は終端付近で戻す
            var d = vid.duration;
            var t = (d && isFinite(d)) ? Math.min(LOOP_AT_SEC, Math.max(0, d - 0.18)) : LOOP_AT_SEC;
            if (vid.currentTime >= t) {
              vid.currentTime = 0;
              var p4 = vid.play();
              if (p4 && typeof p4.catch === 'function') p4.catch(function() {});
            }
          } catch (e4) {}
        });
        vid.addEventListener('ended', function() {
          try {
            vid.currentTime = 0;
            var p3 = vid.play();
            if (p3 && typeof p3.catch === 'function') p3.catch(function() {});
          } catch (e3) {}
        });
      }
      var p = vid.play();
      if (p && typeof p.catch === 'function') p.catch(function() {});
    } catch (e) {}
  }
}

function soraSetPortraitSpeaking(portraitEl, speaking) {
  if (!portraitEl) return;
  portraitEl.classList.toggle('is-speaking', !!speaking);
  var v = portraitEl.querySelector('video');
  if (!v) return;
  try {
    // 動画アイコンは常時再生。見た目だけ切り替える。
    var p2 = v.play();
    if (p2 && typeof p2.catch === 'function') p2.catch(function() {});
  } catch (e) {}
}

function soraSpeechMascotHtml(modClass) {
  modClass = modClass || 'sora-speech--chat';
  return '<div class="sora-avatar-portrait sora-avatar-portrait--alpha ' + modClass + '" aria-hidden="true">'
    + '<span class="sora-avatar-portrait__motion">'
    + '<video class="sora-avatar-portrait__video sora-avatar-portrait__video--icon" muted playsinline preload="metadata" loop autoplay aria-hidden="true">'
    + '<source src="videos/sora-icon.mp4" type="video/mp4">'
    + '</video>'
    + '</span></div>';
}

function soraRunSpeaking(messageRow, text) {
  var m = messageRow.querySelector('.sora-avatar-portrait');
  if (!m) return;
  var len = (text && text.length) ? text.length : 80;
  var dur = Math.min(12000, Math.max(1800, len * 32));
  m.classList.remove('is-yawning');
  soraSetPortraitSpeaking(m, true);
  clearTimeout(m._soraSpeakT);
  m._soraSpeakT = setTimeout(function() {
    soraSetPortraitSpeaking(m, false);
    m._soraSpeakT = null;
    soraNotifySpeakingEnded();
  }, dur);
}

function injectSoraMascotSlots() {
  var pairs = [
    ['splashMascotSlot', 'sora-speech--splash'],
    ['loadingMascotSlot', 'sora-speech--loading'],
    ['setupMascotSlot', 'sora-speech--setup'],
    ['welcomeMascotSlot', 'sora-speech--chat']
  ];
  for (var i = 0; i < pairs.length; i++) {
    var el = $(pairs[i][0]);
    if (el) {
      el.innerHTML = soraSpeechMascotHtml(pairs[i][1]);
      var p = el.querySelector('.sora-avatar-portrait');
      if (p) soraInitPortraitCanvas(p);
    }
  }
}

/* ========== メイン ========== */
document.addEventListener('DOMContentLoaded', function() {
  injectSoraMascotSlots();

  var chatPresenter = $('chatPresenter');
  var chatPresenterVideo = $('chatPresenterVideo');
  var chatPresenterSubtitle = $('chatPresenterSubtitle');

  function setChatPresenterSubtitle(t) {
    if (chatPresenterSubtitle) chatPresenterSubtitle.textContent = t || '';
  }

  function showChatPresenter() {
    if (!chatPresenter) return;
    chatPresenter.classList.remove('chat-presenter--hidden');
    chatPresenter.setAttribute('aria-hidden', 'false');
    if (!chatPresenterVideo) return;
    try {
      chatPresenterVideo.currentTime = 0;
      var p = chatPresenterVideo.play();
      if (p && typeof p.catch === 'function') p.catch(function() {});
    } catch (e) {}
  }

  function hideChatPresenter() {
    if (!chatPresenter) return;
    chatPresenter.classList.add('chat-presenter--hidden');
    chatPresenter.setAttribute('aria-hidden', 'true');
    if (chatPresenterVideo) {
      try {
        chatPresenterVideo.pause();
        chatPresenterVideo.currentTime = 0;
      } catch (e2) {}
    }
    setChatPresenterSubtitle('');
  }

  var chatHistory = [];
  var photoSlots = [];
  var MAX_PHOTOS = 8;
  var uploadPlaceholderHtml = '';
  var processing = false;

  function openPhotoLightbox(dataUrl, alt) {
    var lb = $('photoLightbox');
    var im = $('photoLightboxImg');
    if (!lb || !im || !dataUrl) return;
    im.src = dataUrl;
    im.alt = alt || '拡大画像';
    lb.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closePhotoLightbox() {
    var lb = $('photoLightbox');
    var im = $('photoLightboxImg');
    if (lb) lb.style.display = 'none';
    if (im) {
      im.removeAttribute('src');
      im.alt = '';
    }
    document.body.style.overflow = '';
  }

  (function initPhotoLightbox() {
    if ($('photoLightboxClose')) {
      $('photoLightboxClose').addEventListener('click', function(e) {
        e.preventDefault();
        closePhotoLightbox();
      });
    }
    if ($('photoLightboxBackdrop')) {
      $('photoLightboxBackdrop').addEventListener('click', function(e) {
        e.preventDefault();
        closePhotoLightbox();
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      var lb = $('photoLightbox');
      if (lb && lb.style.display === 'flex') closePhotoLightbox();
    });
  })();

  function extractImageFilesFromList(fileList) {
    if (!fileList || !fileList.length) return [];
    var arr = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var name = (f.name || '').toLowerCase();
      if (f.type && f.type.indexOf('image/') === 0) arr.push(f);
      else if (name.endsWith('.heic') || name.endsWith('.heif')) arr.push(f);
    }
    return arr;
  }

  function bindImageDropZone(areaEl, handleFilesFn) {
    if (!areaEl || typeof handleFilesFn !== 'function') return;
    areaEl.addEventListener('dragenter', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });
    areaEl.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      areaEl.classList.add('dragover');
    });
    areaEl.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var rt = e.relatedTarget;
      if (rt && areaEl.contains(rt)) return;
      areaEl.classList.remove('dragover');
    });
    areaEl.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      areaEl.classList.remove('dragover');
      var dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      var imgs = extractImageFilesFromList(dt.files);
      if (!imgs.length) {
        alert('画像ファイル（JPEG / PNG / HEIC 等）をドロップしてください。');
        return;
      }
      handleFilesFn(imgs);
    });
  }

  // --- スプラッシュ ---
  setTimeout(function() {
    $('splash').classList.add('fade-out');
    $('app').classList.remove('hidden');
    setTimeout(function() { $('splash').style.display = 'none'; }, 500);
  }, 2000);

  var idleYawnTimer = null;

  function clearIdleYawnSchedule() {
    if (idleYawnTimer) {
      clearTimeout(idleYawnTimer);
      idleYawnTimer = null;
    }
  }

  function clearChatYawning() {
    document.querySelectorAll('#chatMessages .sora-avatar-portrait.is-yawning').forEach(function(el) {
      el.classList.remove('is-yawning');
    });
  }

  function scheduleIdleYawn() {
    clearIdleYawnSchedule();
    idleYawnTimer = setTimeout(runIdleYawn, 11000 + Math.random() * 15000);
  }

  function runIdleYawn() {
    idleYawnTimer = null;
    if (processing) return;
    var tabChat = $('tabChat');
    if (!tabChat || !tabChat.classList.contains('active')) {
      scheduleIdleYawn();
      return;
    }
    var last = document.querySelector('#chatMessages .message.assistant:last-of-type');
    if (!last) {
      scheduleIdleYawn();
      return;
    }
    if (last.querySelector('.typing-indicator')) {
      scheduleIdleYawn();
      return;
    }
    var p = last.querySelector('.sora-avatar-portrait');
    if (!p || p.classList.contains('is-speaking')) {
      scheduleIdleYawn();
      return;
    }
    p.classList.add('is-yawning');
    setTimeout(function() {
      p.classList.remove('is-yawning');
      if (!processing) scheduleIdleYawn();
    }, 3000);
  }

  soraNotifySpeakingEnded = function() {
    scheduleIdleYawn();
  };

  // --- タブ ---
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.tab === tab); });
      document.querySelectorAll('.tab-content').forEach(function(c) {
        c.classList.toggle('active', c.id === 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
      });
      if (tab !== 'chat') hideChatPresenter();
      if (tab === 'chat') setTimeout(scheduleIdleYawn, 4000);
      if (tab === 'patrol') initPatrolChecklistOnce();
    });
  });

  // ===== 安全巡視パトロール =====
  var PATROL_STORAGE_KEY = 'sora_patrol_v1';
  var patrolSlots = [];
  var patrolPlaceholderHtml = '';
  var patrolChecklistBuilt = false;

  function patrolItemMark(i) {
    if (i >= 0 && i < 20) return String.fromCharCode(0x2460 + i);
    return String(i + 1) + '.';
  }

  function normalizePatrolShiftVal(v) {
    if (v === true) return 'ok';
    if (typeof v === 'string') {
      var t = v.trim().toLowerCase();
      if (t === 'ok' || t === 'good' || t === 'maru') return 'ok';
      if (t === 'ng' || t === 'bad' || t === 'x' || t === 'batsu') return 'ng';
    }
    return '';
  }

  function setPatrolMarkButton(btn, state) {
    if (!btn) return;
    var st = state === 'ok' || state === 'ng' ? state : '';
    btn.setAttribute('data-state', st);
    btn.classList.remove('patrol-mark--ok', 'patrol-mark--ng');
    var shift = btn.getAttribute('data-shift') === 'pm' ? '午後' : '午前';
    if (st === 'ok') {
      btn.textContent = '〇';
      btn.classList.add('patrol-mark--ok');
      btn.setAttribute('aria-label', shift + ' 良好');
    } else if (st === 'ng') {
      btn.textContent = '✖';
      btn.classList.add('patrol-mark--ng');
      btn.setAttribute('aria-label', shift + ' 是正が必要');
    } else {
      btn.textContent = '・';
      btn.setAttribute('aria-label', shift + ' 未選択（タップで〇／✖）');
    }
  }

  function collectAllPatrolKeys() {
    var keys = [];
    function walk(letter, sections) {
      if (!sections) return;
      for (var s = 0; s < sections.length; s++) {
        for (var k = 0; k < sections[s].items.length; k++) {
          keys.push(letter + '-' + s + '-' + k);
        }
      }
    }
    if (typeof PATROL_CHECKLIST_LEFT !== 'undefined') walk('L', PATROL_CHECKLIST_LEFT);
    if (typeof PATROL_CHECKLIST_RIGHT !== 'undefined') walk('R', PATROL_CHECKLIST_RIGHT);
    return keys;
  }

  function buildPatrolManifestText() {
    var lines = ['【判定対象】キー名\tカテゴリ\t項目（各行が1項目）'];
    function walk(letter, sections) {
      for (var s = 0; s < sections.length; s++) {
        var cat = sections[s].category;
        for (var k = 0; k < sections[s].items.length; k++) {
          var key = letter + '-' + s + '-' + k;
          lines.push(key + '\t' + cat + '\t' + sections[s].items[k]);
        }
      }
    }
    if (typeof PATROL_CHECKLIST_LEFT !== 'undefined') walk('L', PATROL_CHECKLIST_LEFT);
    if (typeof PATROL_CHECKLIST_RIGHT !== 'undefined') walk('R', PATROL_CHECKLIST_RIGHT);
    return lines.join('\n');
  }

  function parsePatrolAiJson(text) {
    if (!text || typeof text !== 'string') throw new Error('空の応答です');
    var t = text.trim();
    if (t.indexOf('```') >= 0) {
      var m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (m) t = m[1].trim();
    }
    var a = t.indexOf('{');
    var b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.substring(a, b + 1);
    return JSON.parse(t);
  }

  function mergePatrolAiParsed(parsed) {
    var keys = collectAllPatrolKeys();
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var cell = parsed && typeof parsed === 'object' ? parsed[key] : null;
      var am = '';
      var pm = '';
      if (cell && typeof cell === 'object') {
        am = normalizePatrolShiftVal(cell.am);
        pm = normalizePatrolShiftVal(cell.pm);
      }
      out[key] = { am: am, pm: pm };
    }
    return out;
  }

  function getPatrolAiShiftMask() {
    var ta = $('patrolTimeAm') && $('patrolTimeAm').value;
    var tp = $('patrolTimePm') && $('patrolTimePm').value;
    var hasAm = !!(ta && String(ta).trim() !== '');
    var hasPm = !!(tp && String(tp).trim() !== '');
    if (hasAm && !hasPm) return { am: true, pm: false };
    if (!hasAm && hasPm) return { am: false, pm: true };
    return { am: true, pm: true };
  }

  function applyPatrolChecksWithMask(merged, mask) {
    if (!merged || !mask) return;
    var current = collectPatrolChecks();
    var keys = collectAllPatrolKeys();
    var final = {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var m = merged[key] || { am: '', pm: '' };
      var c = current[key] || { am: '', pm: '' };
      final[key] = {
        am: mask.am ? m.am : c.am,
        pm: mask.pm ? m.pm : c.pm
      };
    }
    applyPatrolChecks(final);
  }

  function onPatrolMarkGridClick(ev) {
    var btn = ev.target.closest('button.patrol-mark');
    if (!btn || !btn.getAttribute('data-patrol-k')) return;
    ev.preventDefault();
    var seq = ['', 'ok', 'ng'];
    var cur = btn.getAttribute('data-state') || '';
    var ix = seq.indexOf(cur);
    if (ix < 0) ix = 0;
    setPatrolMarkButton(btn, seq[(ix + 1) % seq.length]);
  }

  function buildPatrolColumnHtml(side, sections) {
    var html = '<div class="patrol-col" data-patrol-side="' + side + '">';
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      html += '<div class="patrol-cat"><h4>' + escapeHtml(sec.category) + '</h4>';
      for (var k = 0; k < sec.items.length; k++) {
        var key = side + '-' + s + '-' + k;
        html += '<div class="patrol-row" data-patrol-key="' + key + '">'
          + '<span class="patrol-row-num">' + patrolItemMark(k) + '</span>'
          + '<span class="patrol-row-label">' + escapeHtml(sec.items[k]) + '</span>'
          + '<button type="button" class="patrol-mark patrol-mark--am" data-patrol-k="' + key + '" data-shift="am" data-state="" aria-label="午前 未選択">・</button>'
          + '<button type="button" class="patrol-mark patrol-mark--pm" data-patrol-k="' + key + '" data-shift="pm" data-state="" aria-label="午後 未選択">・</button>'
          + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function initPatrolChecklistOnce() {
    if (patrolChecklistBuilt) return;
    var mount = $('patrolChecklistMount');
    if (!mount || typeof PATROL_CHECKLIST_LEFT === 'undefined') return;
    mount.innerHTML = buildPatrolColumnHtml('L', PATROL_CHECKLIST_LEFT) + buildPatrolColumnHtml('R', PATROL_CHECKLIST_RIGHT);
    mount.querySelectorAll('button.patrol-mark').forEach(function(b) { setPatrolMarkButton(b, b.getAttribute('data-state') || ''); });
    mount.addEventListener('click', onPatrolMarkGridClick);
    patrolChecklistBuilt = true;
    loadPatrolDraft();
  }

  function collectPatrolChecks() {
    var checks = {};
    document.querySelectorAll('#patrolChecklistMount button.patrol-mark[data-patrol-k]').forEach(function(btn) {
      var k = btn.getAttribute('data-patrol-k');
      var sh = btn.getAttribute('data-shift');
      if (!k || !sh) return;
      if (!checks[k]) checks[k] = { am: '', pm: '' };
      checks[k][sh] = normalizePatrolShiftVal(btn.getAttribute('data-state'));
    });
    return checks;
  }

  function applyPatrolChecks(checks) {
    if (!checks) return;
    document.querySelectorAll('#patrolChecklistMount button.patrol-mark[data-patrol-k]').forEach(function(btn) {
      var k = btn.getAttribute('data-patrol-k');
      var sh = btn.getAttribute('data-shift');
      if (!k || !checks[k]) return;
      var v = sh === 'am' ? checks[k].am : checks[k].pm;
      setPatrolMarkButton(btn, normalizePatrolShiftVal(v));
    });
  }

  function patrolDraftPayload() {
    return {
      v: 1,
      savedAt: new Date().toISOString(),
      timeAm: $('patrolTimeAm') ? $('patrolTimeAm').value : '',
      timePm: $('patrolTimePm') ? $('patrolTimePm').value : '',
      checks: collectPatrolChecks(),
      inspectorAm: $('patrolInspectorAm') ? $('patrolInspectorAm').value : '',
      inspectorPm: $('patrolInspectorPm') ? $('patrolInspectorPm').value : '',
      workAm: $('patrolWorkAm') ? $('patrolWorkAm').value : '',
      workPm: $('patrolWorkPm') ? $('patrolWorkPm').value : '',
      memo: $('patrolMemo') ? $('patrolMemo').value : '',
      photoCount: patrolSlots.length
    };
  }

  function savePatrolDraft() {
    try {
      var payload = patrolDraftPayload();
      localStorage.setItem(PATROL_STORAGE_KEY, JSON.stringify(payload));
      var hint = $('patrolSaveHint');
      if (hint) hint.textContent = '下書きを保存しました（この端末のブラウザ内）。写真は容量の都合、下書きには含めていません。';
    } catch (e) {
      var h2 = $('patrolSaveHint');
      if (h2) h2.textContent = '保存に失敗しました。ブラウザの保存領域を確認してください。';
    }
  }

  function loadPatrolDraft() {
    try {
      var raw = localStorage.getItem(PATROL_STORAGE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || o.v !== 1) return;
      if ($('patrolTimeAm') && o.timeAm) $('patrolTimeAm').value = o.timeAm;
      if ($('patrolTimePm') && o.timePm) $('patrolTimePm').value = o.timePm;
      if ($('patrolInspectorAm') && o.inspectorAm) $('patrolInspectorAm').value = o.inspectorAm;
      if ($('patrolInspectorPm') && o.inspectorPm) $('patrolInspectorPm').value = o.inspectorPm;
      if ($('patrolWorkAm') && o.workAm) $('patrolWorkAm').value = o.workAm;
      if ($('patrolWorkPm') && o.workPm) $('patrolWorkPm').value = o.workPm;
      if ($('patrolMemo') && o.memo) $('patrolMemo').value = o.memo;
      applyPatrolChecks(o.checks);
    } catch (e) {}
  }

  function buildPatrolReportText() {
    var checks = collectPatrolChecks();
    var lines = [];
    lines.push('【安全巡視パトロール】');
    lines.push('作成: ' + new Date().toLocaleString('ja-JP'));
    lines.push('');
    lines.push('巡回時間（午前）: ' + ($('patrolTimeAm') && $('patrolTimeAm').value ? $('patrolTimeAm').value : '（未入力）'));
    lines.push('巡回時間（午後）: ' + ($('patrolTimePm') && $('patrolTimePm').value ? $('patrolTimePm').value : '（未入力）'));
    lines.push('添付写真枚数: ' + patrolSlots.length + ' 枚');
    if (patrolSlots.length === 1) {
      lines.push('（現場写真1枚を、午前・午後の確認記録に共通して使用）');
    }
    lines.push('');
    function appendSide(title, sections, side) {
      lines.push('--- ' + title + ' ---');
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        lines.push('■ ' + sec.category);
        for (var k = 0; k < sec.items.length; k++) {
          var key = side + '-' + s + '-' + k;
          var ch = checks[key] || { am: '', pm: '' };
          var am = ch.am === 'ok' ? '〇' : ch.am === 'ng' ? '✖' : '・';
          var pm = ch.pm === 'ok' ? '〇' : ch.pm === 'ng' ? '✖' : '・';
          lines.push('  ' + patrolItemMark(k) + ' ' + sec.items[k]);
          lines.push('    午前: ' + am + '  午後: ' + pm);
        }
      }
      lines.push('');
    }
    if (typeof PATROL_CHECKLIST_LEFT !== 'undefined') appendSide('左欄', PATROL_CHECKLIST_LEFT, 'L');
    if (typeof PATROL_CHECKLIST_RIGHT !== 'undefined') appendSide('右欄', PATROL_CHECKLIST_RIGHT, 'R');
    lines.push('【巡視結果】');
    lines.push('午前 巡視者: ' + ($('patrolInspectorAm') ? $('patrolInspectorAm').value : ''));
    lines.push('午前 巡視時作業: ' + ($('patrolWorkAm') ? $('patrolWorkAm').value.replace(/\n/g, ' ') : ''));
    lines.push('午後 巡視者: ' + ($('patrolInspectorPm') ? $('patrolInspectorPm').value : ''));
    lines.push('午後 巡視時作業: ' + ($('patrolWorkPm') ? $('patrolWorkPm').value.replace(/\n/g, ' ') : ''));
    lines.push('備考: ' + ($('patrolMemo') ? $('patrolMemo').value.replace(/\n/g, ' ') : ''));
    return lines.join('\n');
  }

  function runPatrolAutoCheck() {
    initPatrolChecklistOnce();
    if (!patrolSlots.length) {
      alert('先に現場の写真を1枚以上添付してください。');
      return;
    }
    var key = getApiKey();
    if (!key) {
      openSetup();
      return;
    }
    if (processing) return;

    var mask = getPatrolAiShiftMask();
    var manifest = buildPatrolManifestText();
    var shiftRule = '';
    if (mask.am && !mask.pm) {
      shiftRule = '【重要】ユーザーは「午前の巡回時刻」のみ入力している。各キーは am（午前）列のみ判定し、pm（午後）は必ず空文字 "" にすること（午後巡視は未実施の想定）。\n';
    } else if (!mask.am && mask.pm) {
      shiftRule = '【重要】ユーザーは「午後の巡回時刻」のみ入力している。pm のみ判定し、am は必ず空文字 "" にすること。\n';
    } else {
      shiftRule = '午前(am)・午後(pm)の両列を判定すること。\n';
    }
    var sameBothHint = (mask.am && mask.pm)
      ? '写真が1枚のみで午前・午後の区別が写真から読み取れないときは、am と pm に原則同じ値でよい。\n'
      : '';
    var instruct = '【指示】\n' + shiftRule
      + '添付の現場写真だけを根拠に判定する。\n'
      + '各値は次の文字列のみ: "ok"（良好・問題なし）、"ng"（是正が必要または不備・危険がうかがえる）、""（写真から判断不可）。\n'
      + sameBothHint
      + '推測で断定しない。写っていない項目は "" にする。\n'
      + 'JSONのトップレベルはキー名（例 "L-0-0"）のみ。値は必ず {"am":"ok"|"ng"|"","pm":"ok"|"ng"|""} の形。\n'
      + 'リストの全キーを漏れなく含めること。JSON以外は一切出力しない。';

    var parts = [{ text: SYS_PATROL_JSON + '\n\n' + manifest + '\n\n' + instruct }];
    patrolSlots.forEach(function(s) {
      parts.push({ inline_data: { mime_type: s.mime, data: s.base64 } });
    });
    var body = {
      contents: [{ parts: parts }],
      generationConfig: { temperature: 0.12, maxOutputTokens: 16384 }
    };

    processing = true;
    var overlay = $('loadingOverlay');
    var loadText = $('loadingText');
    var loadMascot = $('loadingMascotSlot') && $('loadingMascotSlot').querySelector('.sora-avatar-portrait');
    if (overlay) overlay.style.display = 'flex';
    if (loadText) loadText.textContent = '写真から巡視項目を判定中...';
    if (loadMascot) loadMascot.classList.add('is-speaking');

    var hint = $('patrolSaveHint');

    callGemini(key, body).then(function(text) {
      var parsed = parsePatrolAiJson(text);
      var merged = mergePatrolAiParsed(parsed);
      applyPatrolChecksWithMask(merged, mask);
      if (hint) {
        if (mask.am && !mask.pm) {
          hint.textContent = 'AIが午前のみ反映しました（午後の巡回時刻を入れてから再度「自動チェック」すると午後列のみ更新できます）。参考です。必ず現場で確認してください。';
        } else if (!mask.am && mask.pm) {
          hint.textContent = 'AIが午後のみ反映しました（午前の巡回時刻のみのときは午前列のみ更新されます）。参考です。必ず現場で確認してください。';
        } else {
          hint.textContent = 'AIが〇／✖を入力しました（参考です。必ず現場で確認のうえ修正してください）。';
        }
      }
    }).catch(function(err) {
      var em = friendlyError(err.message || String(err)).replace(/\n/g, ' ');
      if (hint) hint.textContent = em;
      else alert(em);
    }).finally(function() {
      processing = false;
      if (overlay) overlay.style.display = 'none';
      if (loadMascot) loadMascot.classList.remove('is-speaking');
    });
  }

  function renderPatrolStrip() {
    var strip = $('patrolPhotoStrip');
    var ph = $('patrolUploadPlaceholder');
    var area = $('patrolUploadArea');
    if (!strip || !ph || !area) return;
    if (patrolSlots.length === 0) {
      strip.hidden = true;
      strip.innerHTML = '';
      ph.innerHTML = patrolPlaceholderHtml;
      ph.style.display = '';
      area.classList.remove('has-image');
      $('btnPatrolClearPhotos').hidden = true;
      $('patrolPhotoCountLine').hidden = true;
      return;
    }
    ph.style.display = 'none';
    strip.hidden = false;
    strip.innerHTML = '';
    area.classList.add('has-image');
    $('btnPatrolClearPhotos').hidden = false;
    $('patrolPhotoCountLine').hidden = false;
    $('patrolPhotoCountText').textContent = String(patrolSlots.length);
    patrolSlots.forEach(function(slot, idx) {
      var wrap = document.createElement('div');
      wrap.className = 'photo-thumb-wrap';
      var img = document.createElement('img');
      img.src = slot.dataUrl;
      img.alt = '巡視写真' + (idx + 1);
      img.className = 'photo-thumb-img';
      img.addEventListener('click', function(ev) {
        ev.stopPropagation();
        openPhotoLightbox(slot.dataUrl, img.alt);
      });
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-thumb-remove';
      btn.setAttribute('aria-label', 'この写真を削除');
      btn.textContent = '×';
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        patrolSlots.splice(idx, 1);
        renderPatrolStrip();
      });
      wrap.appendChild(img);
      wrap.appendChild(btn);
      strip.appendChild(wrap);
    });
    if (patrolSlots.length < MAX_PHOTOS) {
      var addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.className = 'patrol-strip-add';
      addTile.setAttribute('aria-label', '写真を追加（1枚のままでもレポート作成可）');
      addTile.innerHTML = '<span class="patrol-strip-add-plus">＋</span><span class="patrol-strip-add-text">追加</span>';
      addTile.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var ipg = $('inputPatrolGallery');
        if (ipg) {
          ipg.value = '';
          ipg.click();
        }
      });
      strip.appendChild(addTile);
    }
  }

  function handlePatrolFiles(files) {
    if (!files || !files.length) return Promise.resolve();
    var arr = Array.prototype.slice.call(files, 0);
    var room = MAX_PHOTOS - patrolSlots.length;
    if (room <= 0) {
      alert('写真は最大' + MAX_PHOTOS + '枚までです。');
      return Promise.resolve();
    }
    if (arr.length > room) {
      alert('最大' + MAX_PHOTOS + '枚までです。先頭' + room + '枚のみ追加します。');
      arr = arr.slice(0, room);
    }
    var skipped = 0;
    return arr.reduce(function(chain, file) {
      return chain.then(function() {
        return processOneFile(file).then(function(slot) {
          if (slot) patrolSlots.push(slot);
          else skipped++;
        });
      });
    }, Promise.resolve()).then(function() {
      if (skipped) alert('画像以外のファイルはスキップしました（JPEG / PNG / HEIC対応）');
      renderPatrolStrip();
      var h = $('patrolSaveHint');
      if (h && patrolSlots.length) {
        h.textContent = '写真を追加しました。「写真から自動チェック」でAIが〇／✖を入れられます（タップで手直し可）。';
      }
    });
  }

  (function initPatrolUi() {
    var pMount = $('patrolChecklistMount');
    if (!pMount) return;
    patrolPlaceholderHtml = $('patrolUploadPlaceholder') ? $('patrolUploadPlaceholder').innerHTML : '';

    var ipc = $('inputPatrolCapture');
    var ipg = $('inputPatrolGallery');
    if ($('btnPatrolCapture') && ipc) {
      $('btnPatrolCapture').addEventListener('click', function(e) {
        e.stopPropagation();
        ipc.value = '';
        ipc.click();
      });
    }
    if ($('btnPatrolGallery') && ipg) {
      $('btnPatrolGallery').addEventListener('click', function(e) {
        e.stopPropagation();
        ipg.value = '';
        ipg.click();
      });
    }
    if ($('patrolUploadArea') && ipg) {
      $('patrolUploadArea').addEventListener('click', function(e) {
        if (e.target.closest('.photo-thumb-remove')) return;
        if (e.target.closest('.photo-thumb-wrap')) return;
        if (e.target.closest('.patrol-strip-add')) return;
        ipg.value = '';
        ipg.click();
      });
      bindImageDropZone($('patrolUploadArea'), function(filesArr) {
        handlePatrolFiles(filesArr);
      });
    }
    if ($('btnPatrolClearPhotos')) {
      $('btnPatrolClearPhotos').addEventListener('click', function(e) {
        e.stopPropagation();
        patrolSlots = [];
        renderPatrolStrip();
      });
    }
    if (ipc) ipc.addEventListener('change', function() {
      if (ipc.files && ipc.files.length) handlePatrolFiles(ipc.files);
    });
    if (ipg) ipg.addEventListener('change', function() {
      if (ipg.files && ipg.files.length) handlePatrolFiles(ipg.files);
    });

    if ($('btnPatrolSaveDraft')) $('btnPatrolSaveDraft').addEventListener('click', savePatrolDraft);
    if ($('btnPatrolAiFill')) $('btnPatrolAiFill').addEventListener('click', function() { runPatrolAutoCheck(); });
    if ($('btnPatrolExport')) {
      $('btnPatrolExport').addEventListener('click', function() {
        initPatrolChecklistOnce();
        var text = buildPatrolReportText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function() {
            var hint = $('patrolSaveHint');
            if (hint) hint.textContent = 'レポートをクリップボードにコピーしました。メールやTeamsに貼り付けて送れます。';
          }).catch(function() {
            prompt('以下をコピーしてください:', text);
          });
        } else {
          prompt('以下をコピーしてください:', text);
        }
      });
    }
    if ($('btnPatrolReset')) {
      $('btnPatrolReset').addEventListener('click', function() {
        if (!confirm('チェックと入力をすべて消しますか？（下書き保存データも削除）')) return;
        try { localStorage.removeItem(PATROL_STORAGE_KEY); } catch (e2) {}
        patrolSlots = [];
        renderPatrolStrip();
        ['patrolTimeAm', 'patrolTimePm', 'patrolInspectorAm', 'patrolInspectorPm', 'patrolWorkAm', 'patrolWorkPm', 'patrolMemo'].forEach(function(id) {
          var el = $(id);
          if (el) el.value = '';
        });
        document.querySelectorAll('#patrolChecklistMount button.patrol-mark').forEach(function(b) { setPatrolMarkButton(b, ''); });
        var hint = $('patrolSaveHint');
        if (hint) hint.textContent = 'クリアしました。';
      });
    }
  })();

  // ===== 写真機能（複数枚・HEIC対応） =====
  var inputCapture = $('inputCapture');
  var inputGallery = $('inputGallery');
  uploadPlaceholderHtml = $('uploadPlaceholder').innerHTML;

  $('btnCapture').addEventListener('click', function(e) {
    e.stopPropagation();
    inputCapture.value = '';
    inputCapture.click();
  });
  $('btnGallery').addEventListener('click', function(e) {
    e.stopPropagation();
    inputGallery.value = '';
    inputGallery.click();
  });
  $('uploadArea').addEventListener('click', function(e) {
    if (e.target.closest('.photo-thumb-remove')) return;
    if (e.target.closest('.photo-thumb-wrap')) return;
    inputGallery.value = '';
    inputGallery.click();
  });

  $('btnClearPhotos').addEventListener('click', function(e) {
    e.stopPropagation();
    photoSlots = [];
    renderPhotoStrip();
  });

  function isHeic(file) {
    var name = (file.name || '').toLowerCase();
    var type = (file.type || '').toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif') || type === 'image/heic' || type === 'image/heif';
  }

  function readAsDataUrl(blob) {
    return new Promise(function(resolve, reject) {
      var r = new FileReader();
      r.onload = function() { resolve(r.result); };
      r.onerror = function() { reject(new Error('read')); };
      r.readAsDataURL(blob);
    });
  }

  function processOneFile(file) {
    return new Promise(function(resolve) {
      if (isHeic(file) && typeof heic2any !== 'undefined') {
        heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 })
          .then(function(jpegBlob) { return readAsDataUrl(jpegBlob); })
          .then(function(dataUrl) {
            resolve({ mime: 'image/jpeg', base64: dataUrl.split(',')[1], dataUrl: dataUrl });
          })
          .catch(function() {
            readAsDataUrl(file).then(function(dataUrl) {
              resolve({ mime: file.type || 'image/jpeg', base64: dataUrl.split(',')[1], dataUrl: dataUrl });
            }).catch(function() { resolve(null); });
          });
        return;
      }
      if (isHeic(file)) {
        readAsDataUrl(file).then(function(dataUrl) {
          resolve({ mime: 'image/jpeg', base64: dataUrl.split(',')[1], dataUrl: dataUrl });
        }).catch(function() { resolve(null); });
        return;
      }
      if (!file.type.startsWith('image/')) {
        resolve(null);
        return;
      }
      readAsDataUrl(file).then(function(dataUrl) {
        resolve({ mime: file.type, base64: dataUrl.split(',')[1], dataUrl: dataUrl });
      }).catch(function() { resolve(null); });
    });
  }

  function renderPhotoStrip() {
    var strip = $('photoPreviewStrip');
    var ph = $('uploadPlaceholder');
    var area = $('uploadArea');
    if (photoSlots.length === 0) {
      strip.hidden = true;
      strip.innerHTML = '';
      ph.innerHTML = uploadPlaceholderHtml;
      ph.style.display = '';
      area.classList.remove('has-image');
      $('photoMessageArea').style.display = 'none';
      $('photoResult').style.display = 'none';
      $('btnClearPhotos').hidden = true;
      $('photoCountLine').hidden = true;
      return;
    }
    ph.style.display = 'none';
    strip.hidden = false;
    strip.innerHTML = '';
    area.classList.add('has-image');
    $('photoMessageArea').style.display = 'block';
    $('photoResult').style.display = 'none';
    $('btnClearPhotos').hidden = false;
    $('photoCountLine').hidden = false;
    $('photoCountText').textContent = String(photoSlots.length);
    photoSlots.forEach(function(slot, idx) {
      var wrap = document.createElement('div');
      wrap.className = 'photo-thumb-wrap';
      var img = document.createElement('img');
      img.src = slot.dataUrl;
      img.alt = '写真' + (idx + 1);
      img.className = 'photo-thumb-img';
      img.addEventListener('click', function(ev) {
        ev.stopPropagation();
        openPhotoLightbox(slot.dataUrl, img.alt);
      });
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-thumb-remove';
      btn.setAttribute('aria-label', 'この写真を削除');
      btn.textContent = '×';
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        photoSlots.splice(idx, 1);
        renderPhotoStrip();
      });
      wrap.appendChild(img);
      wrap.appendChild(btn);
      strip.appendChild(wrap);
    });
  }

  function handlePhotoFiles(files) {
    if (!files || !files.length) return Promise.resolve();
    var arr = Array.prototype.slice.call(files, 0);
    var room = MAX_PHOTOS - photoSlots.length;
    if (room <= 0) {
      alert('写真は最大' + MAX_PHOTOS + '枚までです。');
      return Promise.resolve();
    }
    if (arr.length > room) {
      alert('最大' + MAX_PHOTOS + '枚までです。先頭' + room + '枚のみ追加します。');
      arr = arr.slice(0, room);
    }
    var skipped = 0;
    return arr.reduce(function(chain, file) {
      return chain.then(function() {
        return processOneFile(file).then(function(slot) {
          if (slot) photoSlots.push(slot);
          else skipped++;
        });
      });
    }, Promise.resolve()).then(function() {
      if (skipped) alert('画像以外のファイルはスキップしました（JPEG / PNG / HEIC対応）');
      renderPhotoStrip();
    });
  }

  inputCapture.addEventListener('change', function() {
    if (inputCapture.files && inputCapture.files.length) handlePhotoFiles(inputCapture.files);
  });
  inputGallery.addEventListener('change', function() {
    if (inputGallery.files && inputGallery.files.length) handlePhotoFiles(inputGallery.files);
  });
  bindImageDropZone($('uploadArea'), function(filesArr) {
    handlePhotoFiles(filesArr);
  });

  // --- 写真診断 ---
  $('btnAnalyze').addEventListener('click', function() {
    if (!photoSlots.length || processing) return;
    var key = getApiKey();
    if (!key) { openSetup(); return; }

    processing = true;
    $('loadingOverlay').style.display = 'flex';
    $('loadingText').textContent = 'SORAが写真を分析中...';
    var loadMascot = $('loadingMascotSlot') && $('loadingMascotSlot').querySelector('.sora-avatar-portrait');
    if (loadMascot) loadMascot.classList.add('is-speaking');

    var msg = $('photoMessage').value.trim() || 'この現場写真を安全の観点から分析してください。';
    var intro = photoSlots.length > 1
      ? '【写真枚数】' + photoSlots.length + '枚。順に現場の状況を示しています。すべてを総合的に読み取ってください。\n\n'
      : '';
    var parts = [{ text: SYS_PHOTO + '\n\n' + intro + '【ユーザーの指示】\n' + msg }];
    photoSlots.forEach(function(s) {
      parts.push({ inline_data: { mime_type: s.mime, data: s.base64 } });
    });
    var body = {
      contents: [{ parts: parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
    };

    callGemini(key, body).then(function(text) {
      $('photoResultContent').innerHTML = renderMd(text);
      $('photoResult').style.display = 'flex';
      requestAnimationFrame(function() {
        $('photoResultContent').scrollTop = 0;
        $('photoResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }).catch(function(err) {
      $('photoResultContent').innerHTML = '<div style="color:#ff6b6b">' + renderMd(friendlyError(err.message)) + '</div>';
      $('photoResult').style.display = 'flex';
    }).finally(function() {
      processing = false;
      $('loadingOverlay').style.display = 'none';
      if (loadMascot) loadMascot.classList.remove('is-speaking');
    });
  });

  // ===== チャット機能 =====
  function doSend() {
    var msg = $('chatInput').value.trim();
    if (!msg || processing) return;
    var key = getApiKey();
    if (!key) { openSetup(); return; }

    processing = true;
    clearIdleYawnSchedule();
    clearChatYawning();
    $('chatInput').value = '';
    $('chatInput').style.height = 'auto';
    $('chatSuggestions').style.display = 'none';

    appendMsg('user', msg);
    // 送信後の「説明パネル（枠）」は表示しない

    var lawContext = searchLaws(msg);
    chatHistory.push({ role: 'user', parts: [{ text: msg }] });

    var typing = showTyping();

    var hist = chatHistory.slice(-10);
    while (hist.length > 0 && hist[0].role !== 'user') hist.shift();

    var sendContents = [];
    for (var i = 0; i < hist.length; i++) {
      var text = hist[i].parts[0].text;
      if (i === 0 && hist[i].role === 'user') {
        text = SYS + '\n\n---\n\n' + text;
      }
      if (i === hist.length - 1 && hist[i].role === 'user' && lawContext) {
        text = text + '\n\n' + lawContext;
      }
      sendContents.push({ role: hist[i].role, parts: [{ text: text }] });
    }

    var body = {
      contents: sendContents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
    };

    callGemini(key, body).then(function(text) {
      typing.remove();
      appendMsg('assistant', text);
      chatHistory.push({ role: 'model', parts: [{ text: text }] });
    }).catch(function(err) {
      typing.remove();
      appendMsg('assistant', friendlyError(err.message));
    }).finally(function() {
      processing = false;
      setTimeout(function() {
        scheduleIdleYawn();
      }, 900);
    });
  }

  $('btnSend').addEventListener('click', doSend);
  $('chatInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  $('chatInput').addEventListener('input', function() {
    var el = $('chatInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  });
  $('chatSuggestions').querySelectorAll('.suggestion-chip').forEach(function(chip) {
    chip.addEventListener('click', function() { $('chatInput').value = chip.dataset.message; doSend(); });
  });

  function appendMsg(role, text) {
    var d = document.createElement('div');
    d.className = 'message ' + role;
    if (role === 'assistant') {
      d.innerHTML = '<div class="message-avatar">' + soraSpeechMascotHtml('sora-speech--chat') + '</div>'
        + '<div class="message-bubble"><div class="message-name">SORA</div><div class="message-text">' + renderMd(text) + '</div></div>';
    } else {
      d.innerHTML = '<div class="message-bubble"><div class="message-text">' + escapeHtml(text) + '</div></div>';
    }
    $('chatMessages').appendChild(d);
    var p = d.querySelector('.sora-avatar-portrait');
    if (p) soraInitPortraitCanvas(p);
    if (role === 'assistant') soraRunSpeaking(d, text);
    if (role === 'assistant') soraSpeak(text);
    requestAnimationFrame(function() { $('chatMessages').scrollTop = $('chatMessages').scrollHeight; });
  }

  function showTyping() {
    var d = document.createElement('div');
    d.className = 'message assistant';
    // 回答待ち中（typing）はアイコンを出さない
    d.innerHTML = '<div class="message-bubble"><div class="message-name">SORA</div><div class="typing-indicator"><span></span><span></span><span></span></div></div>';
    $('chatMessages').appendChild(d);
    // 回答待ち中の説明テキストは出さない
    setChatPresenterSubtitle('');
    requestAnimationFrame(function() { $('chatMessages').scrollTop = $('chatMessages').scrollHeight; });
    return d;
  }

  // --- 新しい会話 ---
  $('btnNewChat').addEventListener('click', function() {
    hideChatPresenter();
    clearIdleYawnSchedule();
    clearChatYawning();
    chatHistory = [];
    $('chatMessages').innerHTML = '';
    $('chatSuggestions').style.display = '';
    appendMsg('assistant', 'よう！新しい会話だね。法令のこと、安全のこと、何でも聞いてくれ！');
  });

  // ===== 設定 =====
  function openSetup() {
    $('setupModal').style.display = 'flex';
  }

  $('btnSettings').addEventListener('click', function() {
    var k = getApiKey();
    $('apiKeyInput').value = k;
    updateLawsStatus();
    if ($('ttsEnabled')) $('ttsEnabled').checked = getTtsEnabled();
    $('settingsModal').style.display = 'flex';
    if (k) {
      $('testResult').innerHTML = '';
    }
  });
  $('btnCloseSettings').addEventListener('click', function() { $('settingsModal').style.display = 'none'; });
  $('settingsBackdrop').addEventListener('click', function() { $('settingsModal').style.display = 'none'; });

  $('btnSaveKey').addEventListener('click', function() {
    var key = $('apiKeyInput').value.trim();
    if (!key) { alert('APIキーを入力してください'); return; }
    doSaveAndTest(key, $('testResult'), function() { $('settingsModal').style.display = 'none'; });
  });

  if ($('ttsEnabled')) {
    $('ttsEnabled').addEventListener('change', function() {
      setTtsEnabled(!!$('ttsEnabled').checked);
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    });
  }

  $('btnSetupSave').addEventListener('click', function() {
    var key = $('setupApiKey').value.trim();
    if (!key) return;
    doSaveAndTest(key, $('setupTestResult'), function() { $('setupModal').style.display = 'none'; });
  });
  $('btnSetupSkip').addEventListener('click', function() { $('setupModal').style.display = 'none'; });

  function doSaveAndTest(key, el, onOk) {
    el.innerHTML = '<span style="color:var(--accent)">gemini-2.5-flash-lite で接続テスト中...</span>';
    testApiKey(key).then(function() {
      localStorage.setItem('sora_api_key', key);
      el.innerHTML = '<span style="color:#2ed573">✓ 接続成功！キーを保存しました</span>';
      updateHeader();
      if (onOk) setTimeout(onOk, 1000);
    }).catch(function(err) {
      el.innerHTML = '<span style="color:#ff4757">✗ ' + escapeHtml(err.message).substring(0, 120) + '</span>';
    });
  }

  function updateHeader() {
    $('headerStatus').textContent = getApiKey() ? '安全支援AI - オンライン' : '安全支援AI - APIキー未設定';
  }

  function updateLawsStatus() {
    if (typeof LAWS_DB !== 'undefined' && LAWS_DB && LAWS_DB.length) {
      $('lawsStatus').textContent = LAWS_DB.length + '法令読み込み済み';
    } else {
      $('lawsStatus').textContent = '法令データなし';
    }
  }

  // --- 起動 ---
  updateHeader();
  setTimeout(scheduleIdleYawn, 9000);
  if (!getApiKey()) {
    setTimeout(openSetup, 2500);
  }
});
